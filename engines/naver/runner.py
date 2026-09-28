"""Private JSON bridge. No MCP server, credentials, shell commands or arbitrary actions."""
import asyncio
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import urlparse, parse_qs

from naver_blog_mcp.ir import parse_markdown


def blog_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{2,50}", value):
        raise ValueError("NAVER_BLOG_ID_INVALID")
    return value


def inspect_markdown(markdown):
    if not isinstance(markdown, str) or not markdown.strip():
        raise ValueError("EMPTY_BODY")
    if len(markdown.encode()) > 1024 * 1024:
        raise ValueError("FILE_TOO_LARGE")
    blocks = parse_markdown(markdown)
    images = []
    warnings = []
    for block in blocks:
        if block.type in ("file", "formula", "place"):
            raise ValueError("NAVER_UNSUPPORTED_DIRECTIVE")
        if block.type == "image":
            images.append(block.path)
        spans = block.spans + [s for item in block.items for s in item] + [s for row in block.rows for cell in row for s in cell]
        for span in spans:
            if span.href and urlparse(span.href).scheme not in ("http", "https", "mailto"):
                raise ValueError("LINK_SCHEME_UNSUPPORTED")
            if span.code:
                warnings.append("인라인 코드는 일반 텍스트로 입력됩니다.")
            if span.href and block.type in ("quote", "table"):
                warnings.append("인용문·표 내부 링크는 유지되지 않을 수 있습니다.")
    return blocks, {"images": images, "block_count": len(blocks), "warnings": sorted(set(warnings))}


def owner_from_url(url):
    parsed = urlparse(url)
    if parsed.hostname not in ("blog.naver.com", "m.blog.naver.com"):
        return None
    query = parse_qs(parsed.query)
    candidate = query.get("blogId", [None])[0]
    if not candidate:
        first = parsed.path.strip("/").split("/")[0]
        candidate = first if re.fullmatch(r"[A-Za-z0-9_-]{2,50}", first) else None
    return candidate


def post_url(url, owner):
    parsed = urlparse(url)
    if parsed.hostname not in ("blog.naver.com", "m.blog.naver.com"):
        return None
    query = parse_qs(parsed.query)
    match = re.fullmatch(r"/" + re.escape(owner) + r"/(\d+)", parsed.path)
    number = match.group(1) if match else query.get("logNo", [""])[0]
    if not match and (parsed.path != "/PostView.naver" or query.get("blogId", [""])[0] != owner):
        return None
    return f"https://blog.naver.com/{owner}/{number}" if number.isdigit() and int(number) > 0 else None


async def run(data):
    action = data.get("action")
    if action == "inspect":
        return inspect_markdown(data.get("markdown"))[1]
    if action not in ("status", "categories", "drafts", "write"):
        raise ValueError("ACTION_UNSUPPORTED")
    owner = blog_id(data.get("blog_id"))
    from naver_blog_mcp import editor as E, selectors as S
    from naver_blog_mcp.session import Session

    async with Session() as context:
        page, frame = None, None
        for candidate in context.pages:
            for existing in candidate.frames:
                if owner_from_url(existing.url) == owner and await existing.locator('.se-documentTitle').is_visible():
                    page, frame = candidate, existing
                    break
            if page:
                break
        if page is None:
            # Preserve all existing tabs and any unsaved document.
            page = await context.new_page()
            await page.goto("https://blog.naver.com/MyBlog.naver", wait_until="domcontentloaded")
            await page.wait_for_timeout(1500)
            await E.check_auth_barrier(page)
            owners = {owner_from_url(f.url) for f in page.frames} - {None}
            if owner not in owners:
                raise ValueError("NAVER_LOGIN_OR_OWNER_CHECK_REQUIRED")
            frame = await E.goto_editor(page, owner)
        await E.check_auth_barrier(page)
        await E.dismiss_popups(frame)
        if action == "status":
            return {"authenticated": True, "editor_accessible": True, "blog_id": owner}
        if action == "categories":
            items = await E.read_categories(page, frame)
            await E.close_publish_panel(page, frame)
            return {"items": [{"name": n, "child": child} for n, child in items]}
        if action == "drafts":
            items = await E.list_drafts(page, frame)
            await E.close_draft_list(page, frame)
            return {"items": [{"title": t, "date": d} for t, d in items]}

        # Reject a recovered/non-empty document. Never append to another user's work.
        if not await E.title_is_empty(frame):
            raise ValueError("EDITOR_NOT_EMPTY")
        if not await E.body_is_empty(frame):
            raise ValueError("EDITOR_BODY_NOT_EMPTY")
        blocks, _ = inspect_markdown(data["markdown"])
        assets = data.get("assets", {})
        staging = Path(data["staging"]).resolve(strict=True)
        for block in blocks:
            if block.type == "image":
                image = Path(assets[block.path]).resolve(strict=True)
                if not image.is_relative_to(staging) or image.stat().st_size > 10 * 1024 * 1024:
                    raise ValueError("IMAGE_OUTSIDE_STAGING")
                block.path = str(image)
        title = data["title"]
        mode = data.get("mode")
        if mode not in ("draft", "publish") or data.get("visibility") not in ("private", "public"):
            raise ValueError("WRITE_OPTIONS_INVALID")
        # Exact title uniqueness lets draft verification distinguish the new item.
        drafts = await E.list_drafts(page, frame)
        if any(t == title for t, _ in drafts):
            raise ValueError("DUPLICATE_DRAFT_TITLE")
        await E.close_draft_list(page, frame)
        await E.check_auth_barrier(page)
        notes = await E.write_post(page, title, data["markdown"], prepared_blocks=blocks)
        if any("실패" in n or "누락" in n or "확인 불가" in n for n in notes):
            raise ValueError("EDITOR_CONTENT_REVIEW_REQUIRED")
        await E.open_publish_panel(page, frame)
        if data.get("category"):
            await E._open_category_dropdown(page, frame)
            items = await E._category_items(frame)
            matches = []
            for i in range(await items.count()):
                if E._clean_category(await items.nth(i).inner_text())[0] == data["category"]:
                    matches.append(items.nth(i))
            if len(matches) != 1:
                raise ValueError("CATEGORY_MISSING_OR_AMBIGUOUS")
            await matches[0].click()
        tags = data.get("tags", [])
        if tags and await E.set_tags(page, frame, tags) != len(tags):
            raise ValueError("TAG_INPUT_FAILED")
        await E.set_visibility(page, frame, data["visibility"])
        checked = frame.locator("#open_" + data["visibility"])
        if not await checked.is_checked():
            raise ValueError("VISIBILITY_NOT_CONFIRMED")
        if mode == "draft":
            await E.check_auth_barrier(page)
            await E.close_publish_panel(page, frame)
            save = await S.first(frame, S.SAVE_DRAFT)
            if not save:
                raise ValueError("DRAFT_BUTTON_MISSING")
            await save.click()
            await page.wait_for_timeout(2500)
            after = await E.list_drafts(page, frame)
            if len(after) <= len(drafts) or sum(t == title for t, _ in after) != 1:
                raise ValueError("DRAFT_OUTCOME_UNKNOWN")
            return {"saved": True, "mode": "draft", "title": title, "verified": "draft_list", "notes": notes}

        button = await S.first(frame, S.PUBLISH_CONFIRM)
        if not button:
            raise ValueError("PUBLISH_BUTTON_MISSING")
        await E.check_auth_barrier(page)
        await button.click()  # Exactly one submission. Never retry.
        url = None
        for _ in range(40):
            await E.check_auth_barrier(page)
            for f in page.frames:
                url = post_url(f.url, owner)
                if url:
                    break
            if url:
                break
            await page.wait_for_timeout(500)
        if not url:
            raise ValueError("PUBLISH_OUTCOME_UNKNOWN")
        # Reopen the returned post rather than treating the click as success.
        await page.goto(url, wait_until="domcontentloaded")
        await page.wait_for_timeout(1500)
        frame = await E.get_editor_frame(page)
        titles = frame.locator(".se-title-text")
        if not await titles.count() or title.strip() != (await titles.first.inner_text()).strip():
            raise ValueError("PUBLISH_VERIFICATION_UNKNOWN")
        return {"saved": True, "mode": "publish", "url": url, "title": title,
                "verified": "post_url_and_title", "visibility_verified_after_save": False,
                "warning": "저장 후 본문 서식·이미지·공개 상태는 실제 페이지에서 확인하세요.", "notes": notes}


if __name__ == "__main__":
    os.umask(0o077)
    try:
        payload = json.loads(sys.stdin.buffer.read(2 * 1024 * 1024 + 1))
        result = asyncio.run(run(payload))
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
    except Exception as error:
        # Do not echo arbitrary browser errors, page HTML, cookie or request data.
        code = str(error) if isinstance(error, (ValueError, KeyError)) else type(error).__name__
        print(json.dumps({"ok": False, "error": code[:120]}, ensure_ascii=False))
