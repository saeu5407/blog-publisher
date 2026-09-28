import { z } from 'zod';
import { naverBlogId } from './service.js';

export function registerNaverTools(tool, naver) {
  const blog = z.string().transform(naverBlogId);
  const title = z.string().trim().min(1).max(300);
  tool('naver_login', '전용 프로필로 로그인합니다. resume은 보호조치 해제 후 사용자가 재개를 명시적으로 승인한 경우에만 사용합니다.', { blog, resume: z.boolean().default(false) }, a => naver.login(a.blog, a.resume));
  tool('naver_session_status', '로그인과 대상 블로그 소유 여부를 확인합니다.', { blog }, a => naver.query('status', a.blog), true);
  tool('naver_list_categories', '네이버 편집기에서 카테고리 이름을 조회합니다.', { blog }, a => naver.query('categories', a.blog), true);
  tool('naver_list_drafts', '네이버 임시저장 글 목록을 조회합니다.', { blog }, a => naver.query('drafts', a.blog), true);
  tool('naver_create_markdown', '네이버용 로컬 Markdown과 이미지 폴더를 만듭니다. 서버에는 저장하지 않습니다.',
    { title, markdown: z.string().min(1).max(1000000) }, a => naver.createMarkdown(a.title, a.markdown));
  tool('naver_prepare_post', '네이버 새 글의 미리보기를 만듭니다. mode=draft는 임시저장, publish는 발행입니다. 실제 저장 전 대상·본문·공개 상태에 대한 사용자 승인이 필요합니다.',
    {
      blog, title, markdown_file: z.string(),
      category: z.string().max(100).default(''),
      tags: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
      mode: z.enum(['draft', 'publish']).default('draft'),
      visibility: z.enum(['private', 'public']).default('private'),
    }, a => naver.prepare(a));
  tool('naver_commit_post', '사용자가 미리보기의 저장 방식·대상·공개 상태를 승인한 뒤 실행합니다. 실패 시 자동 재시도하지 않습니다.',
    { confirmation_token: z.string().uuid(), confirm: z.literal(true) }, a => naver.commit(a.confirmation_token, a.confirm));
}
