# CLI

스킬 루트에서 실행합니다. 결과는 JSON이며 실패하면 종료 코드 1입니다.

```sh
node scripts/blog.mjs help
node scripts/blog.mjs list_categories '{"blog":"https://example.tistory.com"}'
node scripts/blog.mjs upload_post @workspace/request.json
```

두 번째 인자는 JSON 또는 @JSON파일입니다. 긴 본문은 파일을 사용합니다. JSON 파일의 상대 경로는 현재 디렉터리 기준이며 markdown_file은 BLOG_WORKSPACE 기준입니다.

## 티스토리

| 명령 | 입력 |
|---|---|
| login / session_status | blog |
| list_posts | blog, page(기본 1), search(기본 빈 문자열) |
| list_categories | blog |
| create_markdown | blog, title, markdown, category(기본 0), tags(기본 []) |
| download_post | blog, post_id(문자열) |
| upload_post / update_post | markdown_file, visibility?, category?, scheduled_at? |
| commit_post | confirmation_token, confirm: true |
| create_category | blog, name, parent_id(기본 0) |
| commit_category | confirmation_token, confirm: true |

Markdown 형식:

```markdown
---
title: 글 제목
blog: https://example.tistory.com
category: 0
tags: [AI]
visibility: private
---

본문과 **강조**, `인라인 코드`입니다.

![설명](images/figure.png)
```

공개 저장은 CLI 인자로 visibility: public을 지정합니다. tags는 # 없이 입력합니다. category는 조회한 ID를 사용합니다. 예약은 초·시간대가 있는 ISO 형식이며 최소 1분 이후여야 합니다. 예약은 public만 허용합니다.

수정은 download_post가 만든 post_id/source_revision을 유지한 파일로 update_post를 실행합니다. working_copy가 반환되면 다음 수정에 사용합니다. list_posts의 hasMore는 현재 페이지가 비어 있지 않다는 뜻이므로 빈 페이지까지 조회합니다.

## 네이버

| 명령 | 입력 |
|---|---|
| naver_login | blog(ID 또는 https://blog.naver.com/ID), resume?(기본 false) |
| naver_session_status | blog |
| naver_list_categories / naver_list_drafts | blog |
| naver_create_markdown | title, markdown |
| naver_prepare_post | blog, title, markdown_file, category?, tags?, mode?, visibility? |
| naver_commit_post | confirmation_token, confirm: true |

본문 Markdown만 사용하며 frontmatter는 넣지 않습니다. category는 이름입니다. mode 기본값은 draft(원격 임시저장), publish는 새 글 발행입니다. visibility 기본값은 private입니다. 같은 제목의 임시저장이 있으면 중단합니다.

이미지는 독립된 줄의 상대 경로로 지정합니다. PNG/JPEG/GIF/WebP, 파일당 최대 10 MiB입니다. 기존 글 다운로드·수정·삭제·예약·카테고리 생성은 지원하지 않습니다. 복잡한 중첩 서식·인라인 코드·표 안의 링크는 완전히 보존되지 않을 수 있습니다.

## 로그인과 승인

login은 터미널 입력을 기다립니다. 사용자가 인증한 뒤 Enter를 입력합니다. 브라우저 창을 먼저 닫지 않습니다.

네이버는 `.state/naver/browser` 전용 브라우저를 계속 켜두고, 명령마다 같은 브라우저에 연결합니다. 연결은 이 컴퓨터의 loopback 주소만 사용합니다. 명령 종료 시 연결만 끊으며 창·탭·로그인은 유지합니다. 열린 글쓰기 탭을 재사용하고 작성 중인 본문을 덮어쓰지 않습니다. 브라우저가 없으면 일반 명령은 중단하며, `naver_login`만 전용 브라우저를 열 수 있습니다. 사용을 마치면 창을 직접 닫습니다.

로그인 완료는 현재 창의 글쓰기 접근으로 확인합니다. 재인증·보호조치 감지 후에는 접속을 차단합니다. 보호조치 해제와 재개에 대한 사용자의 명시적 승인 후에만 `naver_login`에 `resume: true`를 지정합니다. 일반 Chrome의 프로필이나 기존 쿠키 파일을 복사하지 않습니다. 일반 Chrome의 기존 로그인 창을 사용하려면 연결된 컴퓨터 사용 도구로 별도 진행합니다.

prepare는 로컬 미리보기와 confirmation_token을 반환합니다. 토큰은 .state/plans/에 저장되므로 명령 프로세스가 끝나도 유효합니다. commit은 토큰을 소모한 뒤 작업하며, 실패해도 토큰을 다시 사용하지 않습니다. .state/operations/, .state/naver/operations/와 실제 블로그를 확인합니다. prepare와 commit의 상태·작업공간 경로를 바꾸지 않습니다.

네이버 uv 경로는 BLOG_UV로 지정할 수 있습니다. 웹 편집기와 CLI를 동시에 사용하지 않습니다. 쿠키·백업·작업 기록에는 비공개 정보가 있으므로 공유하지 않습니다.
