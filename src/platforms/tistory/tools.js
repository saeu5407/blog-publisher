import { z } from 'zod';
import { blogOrigin } from './core.js';

export function registerTistoryTools(tool, { api, service }) {
  const blog = z.string().transform(blogOrigin);
  const id = z.string().regex(/^[1-9]\d*$/);
  const file = z.string().describe('BLOG_WORKSPACE 안에 있는 Markdown 파일의 절대/상대 경로');
  const visibility = z.enum(['private', 'public']).optional();
  const category = z.number().int().min(0).optional().describe('list_categories로 확인한 카테고리 ID');
  const scheduled_at = z.string().optional().describe('예약 시각: 2026-10-01T09:00:00+09:00처럼 시간대 필수. 예약은 visibility: public 필요');
  tool('login', '로그인 브라우저를 엽니다. 사용자가 직접 카카오 인증을 완료해야 합니다. 자격증명을 도구로 받지 않습니다.', { blog }, a => api.login(a.blog));
  tool('session_status', '티스토리 인증 상태를 읽기 전용으로 확인합니다.', { blog }, a => api.status(a.blog), true);
  tool('list_categories', '블로그 카테고리 ID와 전체 경로를 조회합니다.', { blog }, a => api.categories(a.blog), true);
  tool('create_markdown', '업로드용 Markdown 파일과 이미지 폴더를 작업공간에 생성합니다. 티스토리 서버 임시저장이 아닌 로컬 파일입니다.', { blog, title: z.string().min(1).max(300), markdown: z.string().min(1).max(1000000), category: z.number().int().min(0).default(0), tags: z.array(z.string()).default([]) }, a => service.createMarkdown(a.blog, a.title, a.markdown, a.category, a.tags));
  tool('create_category', '카테고리 추가를 준비합니다. name과 parent_id(0=최상위)를 지정합니다. 기존 카테고리는 수정/삭제하지 않고 확인 토큰만 반환합니다.', { blog, name: z.string().min(1).max(40), parent_id: z.number().int().min(0).default(0) }, a => service.prepareCategory(a.blog, a.name, a.parent_id));
  tool('commit_category', '사용자가 카테고리 이름·상위 분류·생성을 승인한 뒤 실행합니다. 추가 전 충돌 확인 및 백업, 추가 후 재조회합니다. 실패 시 자동 재시도 금지.', { confirmation_token: z.string().uuid(), confirm: z.literal(true) }, a => service.commitCategory(a.confirmation_token, a.confirm));
  tool('list_posts', '기존 글 목록과 ID를 조회합니다. page를 늘려 다음 페이지를 확인하세요.', { blog, page: z.number().int().min(1).max(10000).default(1), search: z.string().max(200).default('') }, a => api.list(a.blog, a.page, a.search), true);
  tool('download_post', '기존 글을 Markdown+이미지로 새 폴더에 다운로드합니다. 원본 HTML/설정 백업 및 충돌 감지 해시를 저장합니다. 지원하지 않는 편집 스키마에서는 중단합니다.', { blog, post_id: id }, a => service.download(a.blog, a.post_id));
  tool('upload_post', '새 글 업로드를 준비합니다. HTML 미리보기와 확인 토큰만 생성하고 서버에는 쓰지 않습니다. 기본 비공개. category로 분류, scheduled_at으로 예약 시각을 지정합니다.', { markdown_file: file, visibility, category, scheduled_at }, a => service.prepare(a.markdown_file, 'create', a.visibility, a.category, a.scheduled_at));
  tool('update_post', '다운로드한 Markdown의 post_id/source_revision으로 충돌을 확인하고 수정 미리보기를 만듭니다. 공개 상태와 메타데이터는 기본 유지합니다. category/예약 시각을 명시할 수 있습니다.', { markdown_file: file, visibility, category, scheduled_at }, a => service.prepare(a.markdown_file, 'update', a.visibility, a.category, a.scheduled_at));
  tool('commit_post', '미리보기의 대상/내용/공개 상태에 대해 사용자 승인을 받은 뒤에만 실행합니다. 이미지 업로드 후 글을 저장합니다. 토큰은 1회용이며 실패/타임아웃 후 자동 재시도하지 않습니다.', { confirmation_token: z.string().uuid(), confirm: z.literal(true) }, a => service.commit(a.confirmation_token, a.confirm));
}
