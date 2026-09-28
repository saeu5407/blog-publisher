import { chromium } from 'playwright';
import path from 'node:path';
import { chmod, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { blogOrigin, postId, privateDir, parseEditorData, mediaUrl } from './core.js';
import { flattenCategories, categoryRevision } from './categories.js';

export class Tistory {
  constructor(state) { this.state = state; this.context = null; }
  async open(headless = true) {
    if (this.context) return this.context;
    const profile = path.join(this.state, 'browser');
    await privateDir(profile); await chmod(profile, 0o700);
    this.context = await chromium.launchPersistentContext(profile, { headless, acceptDownloads: false });
    try {
      const saved = JSON.parse(await readFile(path.join(this.state, 'session.json'), 'utf8'));
      await this.context.addCookies(saved.cookies.filter(c => /(^|\.)tistory\.com$/.test(c.domain.replace(/^\./, ''))));
    } catch (error) { if (error.code !== 'ENOENT') { await this.context.close(); this.context = null; throw new Error('SESSION_FILE_INVALID'); } }
    this.context.on('close', () => { this.context = null; });
    return this.context;
  }
  async persistSession() {
    if (!this.context) return;
    const cookies = (await this.context.cookies()).filter(c => /(^|\.)tistory\.com$/.test(c.domain.replace(/^\./, '')));
    if (!cookies.length) return;
    const temp = path.join(this.state, `session-${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify({ cookies }), { mode: 0o600, flag: 'wx' });
    await rename(temp, path.join(this.state, 'session.json'));
  }
  async login(blog) {
    blog = blogOrigin(blog);
    await this.close(); const context = await this.open(false);
    const page = await context.newPage(); await page.goto(blog + '/manage', { waitUntil: 'domcontentloaded' });
    return { status: 'login_window_open', blog, instruction: '열린 브라우저에서 직접 로그인한 뒤 session_status를 호출하세요. 비밀번호나 쿠키를 도구에 입력하지 마세요.' };
  }
  async request(blog, endpoint, options = {}) {
    blog = blogOrigin(blog);
    if (!endpoint.startsWith('/manage/') || endpoint.includes('://')) throw new Error('ENDPOINT_INVALID');
    const context = await this.open();
    let response;
    try {
      response = await context.request.fetch(blog + endpoint, { ...options, maxRedirects: 0, timeout: 30000, headers: { Accept: 'application/json', Origin: blog, Referer: blog + '/manage', ...options.headers } });
    } catch { throw new Error(options.method && options.method !== 'GET' ? 'WRITE_OUTCOME_UNKNOWN: 재전송하지 말고 목록에서 확인하세요.' : 'NETWORK_ERROR'); }
    if ([301, 302, 303, 307, 308, 401, 403].includes(response.status())) throw new Error('SESSION_OR_CHALLENGE_REQUIRED: 직접 로그인/보안 확인이 필요합니다.');
    if (!response.ok()) throw new Error(`TISTORY_HTTP_${response.status()}: 응답 원문은 인증정보 보호를 위해 표시하지 않습니다.`);
    return response;
  }
  async status(blog) { await this.list(blog, 1); await this.persistSession(); return { authenticated: true, blog: blogOrigin(blog) }; }
  async list(blog, page = 1, search = '') {
    const query = new URLSearchParams({ category: '-3', page: String(page), searchKeyword: search, searchType: 'title', visibility: 'all' });
    const response = await this.request(blog, '/manage/posts.json?' + query);
    let data; try { data = await response.json(); } catch { throw new Error('SESSION_OR_API_SCHEMA_CHANGED'); }
    if (!Array.isArray(data.items)) throw new Error('LIST_SCHEMA_CHANGED');
    return { items: data.items.map(p => ({ id: postId(p.id), title: p.title, visibility: p.visibility, categoryId: p.categoryId, modified: p.modified, url: p.permalink, scheduled: p.isScheduled ?? null, scheduled_at: p.reservedDate ?? null })), page, hasMore: data.items.length > 0 };
  }
  async categoryTree(blog) {
    const response = await this.request(blog, '/manage/category.json');
    const data = await response.json();
    flattenCategories(data); return data;
  }
  async categories(blog) {
    const data = await this.categoryTree(blog);
    return { items: flattenCategories(data), revision: categoryRevision(data) };
  }
  async appendCategory(blog, body) {
    if (body.delete.length || body.append.length !== 1 || body.append[0].id !== -1 || body.update.length !== 1 || JSON.stringify(body.update[0]) !== JSON.stringify(body.append[0])) throw new Error('CATEGORY_APPEND_ONLY');
    const response = await this.request(blog, '/manage/category.json', { method: 'PUT', data: body });
    try { const data = await response.json(); if (!Array.isArray(data.categoryTree)) throw new Error(); }
    catch { throw new Error('WRITE_OUTCOME_UNKNOWN: 목록에서 카테고리 생성 여부를 확인하세요.'); }
    return { saved: true };
  }
  async read(blog, id) {
    id = postId(id);
    const response = await this.request(blog, '/manage/newpost/' + id, { headers: { Accept: 'text/html' } });
    return parseEditorData(await response.text(), id);
  }
  async uploadImage(blog, data, name, mime) {
    const response = await this.request(blog, '/manage/post/attach.json', { method: 'POST', multipart: { file: { name, mimeType: mime, buffer: data } } });
    try { return await response.json(); } catch { throw new Error('UPLOAD_RESPONSE_INVALID'); }
  }
  async save(blog, id, body) {
    const endpoint = id ? '/manage/post/' + postId(id) + '.json' : '/manage/post.json';
    const response = await this.request(blog, endpoint, { method: id ? 'PUT' : 'POST', data: { ...body, id: id || '0', recaptchaValue: '', draftSequence: null, totalWritingTimeMs: 0 } });
    let result; try { result = await response.json(); } catch { throw new Error('WRITE_OUTCOME_UNKNOWN'); }
    if (typeof result.entryUrl !== 'string') throw new Error('WRITE_OUTCOME_UNKNOWN');
    const u = new URL(result.entryUrl);
    if (u.origin !== blogOrigin(blog)) throw new Error('WRITE_OUTCOME_UNKNOWN');
    return { url: u.href };
  }
  async downloadImage(url) {
    // Deliberately use unauthenticated fetch. Never forward blog cookies to image hosts.
    const response = await fetch(mediaUrl(url), { redirect: 'manual', signal: AbortSignal.timeout(30000) });
    if (!response.ok || response.status >= 300) throw new Error('IMAGE_DOWNLOAD_FAILED');
    if (!/^image\/(png|jpeg|gif|webp)(;|$)/i.test(response.headers.get('content-type') || '')) throw new Error('IMAGE_TYPE_UNSUPPORTED');
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 20 * 1024 * 1024) throw new Error('IMAGE_TOO_LARGE'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  async close() { if (this.context) { await this.persistSession(); await this.context.close(); } this.context = null; }
}
