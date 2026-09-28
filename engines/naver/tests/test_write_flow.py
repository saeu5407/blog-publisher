import tempfile
import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from runner import run
from naver_blog_mcp import editor as E, selectors as S, session


class WriteFlowTests(unittest.IsolatedAsyncioTestCase):
    async def exercise(self, *, mode='draft', checked=True, duplicate=False, published=True, saved_title='test', existing=False):
        page = MagicMock()
        page.frames = [SimpleNamespace(url='https://blog.naver.com/example')]
        page.goto = AsyncMock()
        page.wait_for_timeout = AsyncMock()
        frame = MagicMock()
        choice = MagicMock()
        choice.is_checked = AsyncMock(return_value=checked)
        choice.count = AsyncMock(return_value=1)
        choice.first.inner_text = AsyncMock(return_value=saved_title)
        frame.locator.return_value = choice
        button = MagicMock()

        async def click():
            if mode == 'publish' and published:
                page.frames = [SimpleNamespace(url='https://blog.naver.com/example/123')]
        button.click = AsyncMock(side_effect=click)
        context = MagicMock()
        context.pages = []
        if existing:
            frame.url = 'https://blog.naver.com/PostWriteForm.naver?blogId=example'
            choice.is_visible = AsyncMock(return_value=True)
            page.frames = [frame]
            context.pages = [page]
        context.new_page = AsyncMock(return_value=page)
        manager = MagicMock()
        manager.__aenter__ = AsyncMock(return_value=context)
        manager.__aexit__ = AsyncMock(return_value=False)
        self.write = AsyncMock(return_value=[])
        draft_lists = [[('test', 'old')]] if duplicate else [[], [('test', 'new')]]
        with tempfile.TemporaryDirectory() as staging, ExitStack() as stack:
            stack.enter_context(patch.object(session, 'Session', return_value=manager))
            for name, value in {
                'check_auth_barrier': AsyncMock(),
                'dismiss_popups': AsyncMock(),
                'goto_editor': AsyncMock(return_value=frame),
                'get_editor_frame': AsyncMock(return_value=frame),
                'title_is_empty': AsyncMock(return_value=True),
                'body_is_empty': AsyncMock(return_value=True),
                'list_drafts': AsyncMock(side_effect=draft_lists),
                'close_draft_list': AsyncMock(),
                'write_post': self.write,
                'open_publish_panel': AsyncMock(),
                'close_publish_panel': AsyncMock(),
                'set_visibility': AsyncMock(),
            }.items():
                stack.enter_context(patch.object(E, name, value))
            stack.enter_context(patch.object(S, 'first', AsyncMock(return_value=button)))
            result = await run({'action': 'write', 'blog_id': 'example', 'title': 'test',
                              'markdown': 'body', 'staging': staging, 'assets': {},
                              'mode': mode, 'visibility': 'private', 'tags': []})
            if existing:
                context.new_page.assert_not_awaited()
                page.goto.assert_not_awaited()
                E.goto_editor.assert_not_awaited()
            return result

    async def test_existing_editor_is_not_reloaded(self):
        self.assertTrue((await self.exercise(existing=True))['saved'])

    async def test_draft_requires_new_exact_list_entry(self):
        result = await self.exercise()
        self.assertEqual(result['verified'], 'draft_list')

    async def test_duplicate_title_stops_before_writing(self):
        with self.assertRaisesRegex(ValueError, 'DUPLICATE_DRAFT_TITLE'):
            await self.exercise(duplicate=True)
        self.write.assert_not_awaited()

    async def test_unchecked_visibility_stops_submission(self):
        with self.assertRaisesRegex(ValueError, 'VISIBILITY_NOT_CONFIRMED'):
            await self.exercise(checked=False)

    async def test_publish_needs_actual_post_navigation(self):
        with self.assertRaisesRegex(ValueError, 'PUBLISH_OUTCOME_UNKNOWN'):
            await self.exercise(mode='publish', published=False)

    async def test_publish_rereads_title_and_does_not_claim_visibility_verified(self):
        result = await self.exercise(mode='publish')
        self.assertEqual(result['url'], 'https://blog.naver.com/example/123')
        self.assertFalse(result['visibility_verified_after_save'])
        with self.assertRaisesRegex(ValueError, 'PUBLISH_VERIFICATION_UNKNOWN'):
            await self.exercise(mode='publish', saved_title='wrong')
