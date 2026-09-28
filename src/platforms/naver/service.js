import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { connectBrowser, browserEndpoint } from './browser.js';
import { access, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { imageSize } from 'image-size';
import { hash, within, privateDir, writeNew, readLimited, renderMarkdown, rewriteImages, imageUrls } from '../../shared/content.js';

const engineDir = fileURLToPath(new URL('../../../engines/naver/', import.meta.url));
const TTL = 10 * 60 * 1000;
const children = new Set();

function killEngine(child) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch { /* Process may already have exited. */ }
}

export function stopNaverEngines() {
  for (const child of children) killEngine(child);
}

export function naverBlogId(value) {
  if (typeof value !== 'string') throw new Error('NAVER_BLOG_ID_INVALID');
  let id = value;
  if (value.startsWith('https://')) {
    const u = new URL(value);
    if (u.hostname !== 'blog.naver.com' || u.port || u.username || u.password || u.search || u.hash) throw new Error('NAVER_BLOG_ID_INVALID');
    id = u.pathname.replace(/^\//, '').replace(/\/$/, '');
  }
  if (!/^[a-zA-Z0-9_-]{2,50}$/.test(id)) throw new Error('NAVER_BLOG_ID_INVALID');
  return id;
}

export async function runNaverEngine(payload, state, { command = process.env.BLOG_UV || 'uv', timeout = 240000 } = {}) {
  const endpoint = payload.action === 'inspect' ? '' : await browserEndpoint(path.join(state, 'browser'));
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['run', '--frozen', '--offline', '--directory', engineDir, 'python', 'runner.py'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: { ...process.env, NAVER_CDP: endpoint, PYTHONUTF8: '1' },
    });
    children.add(child);
    let output = '', ended = false;
    const finish = (error, value) => {
      if (ended) return;
      ended = true; clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => { killEngine(child); finish(new Error('NAVER_TIMEOUT: 결과를 확인하기 전 재시도하지 마세요.')); }, timeout);
    child.on('error', () => { children.delete(child); finish(new Error('NAVER_ENGINE_UNAVAILABLE: npm run setup:naver를 실행하고 BLOG_UV 경로를 확인하세요.')); });
    child.stderr.on('data', () => {}); // Do not expose browser/session diagnostics.
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 2 * 1024 * 1024) { killEngine(child); finish(new Error('NAVER_RESPONSE_TOO_LARGE')); }
    });
    child.stdin.on('error', () => {});
    child.on('close', code => {
      children.delete(child);
      if (ended) return;
      if (code !== 0) return finish(new Error('NAVER_ENGINE_FAILED: 설치 상태를 확인하세요.'));
      try {
        const data = JSON.parse(output);
        if (!data.ok) return finish(new Error(`NAVER_OPERATION_FAILED: ${data.error}`));
        finish(null, data.result);
      } catch { finish(new Error('NAVER_RESPONSE_INVALID')); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export class NaverService {
  constructor(root, state, engine = runNaverEngine) {
    this.root = root;
    this.state = path.join(state, 'naver');
    this.engine = async payload => {
      if (payload.action !== 'inspect') await this.checkPaused();
      try { return await engine(payload, this.state); }
      catch (error) {
        if (/NAVER_LOGIN|NAVER_AUTH|NAVER_ACCOUNT|NAVER_SECURITY/.test(error.message)) await this.pause();
        throw error;
      }
    };
    this.plans = new Map();
    this.context = null;
    this.browser = null;
  }

  async close() {
    this.context = null;
    // CDP Browser.close disconnects this client; it does not close Chrome.
    if (this.browser) await this.browser.close();
    this.browser = null;
  }

  async pause() {
    await privateDir(this.state);
    try { await writeNew(path.join(this.state, 'auth-paused'), 'Authentication stopped. Explicit user-authorized resume required.\n'); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }

  async checkPaused() {
    try { await access(path.join(this.state, 'auth-paused')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    throw new Error('NAVER_AUTH_PAUSED: 재시도하지 마세요. 사용자가 보호조치 해제와 재개를 승인해야 합니다.');
  }

  async login(blog, resume = false) {
    const id = naverBlogId(blog);
    if (!resume) await this.checkPaused();
    await this.close();
    await privateDir(this.state);
    await privateDir(path.join(this.state, 'browser'));
    try {
      this.browser = await connectBrowser(path.join(this.state, 'browser'), { start: true });
      this.context = this.browser.contexts()[0];
      if (!this.context) throw new Error('NAVER_BROWSER_CONTEXT_MISSING');
      let page = this.context.pages().find(p => p.url().startsWith('https://blog.naver.com/') || p.url().startsWith('https://nid.naver.com/'));
      if (!page) {
        page = await this.context.newPage();
        await page.goto(`https://blog.naver.com/${id}?Redirect=Write`, { waitUntil: 'domcontentloaded' });
      }
      await page.bringToFront();
    } catch (error) { await this.close(); throw error; }
    return { status: 'login_window_open', blog_id: id, instruction: '직접 로그인 후 naver_session_status를 호출하세요. 비밀번호·인증코드·쿠키를 입력하지 마세요.' };
  }

  async finishLogin(blog) {
    // Validate the user's existing page. Do not reopen or navigate after login.
    const id = naverBlogId(blog);
    for (const page of this.context?.pages() || []) {
      for (const frame of page.frames()) {
        let url;
        try { url = new URL(frame.url()); } catch { continue; }
        if (url.hostname !== 'blog.naver.com' || url.searchParams.get('blogId') !== id) continue;
        if (await frame.locator('.se-documentTitle').isVisible() &&
            await frame.getByRole('button', { name: '발행', exact: true }).isVisible()) {
          await unlink(path.join(this.state, 'auth-paused')).catch(error => { if (error.code !== 'ENOENT') throw error; });
          return { authenticated: true, editor_accessible: true, blog_id: id };
        }
      }
    }
    await this.pause();
    throw new Error('NAVER_AUTH_PAUSED: 글쓰기 접근을 확인하지 못했습니다. 재로그인을 반복하지 마세요.');
  }

  async query(action, blog) {
    if (!['status', 'categories', 'drafts'].includes(action)) throw new Error('ACTION_UNSUPPORTED');
    const blog_id = naverBlogId(blog);
    await this.close();
    return this.engine({ action, blog_id });
  }

  async createMarkdown(title, markdown) {
    if (!title.trim() || !markdown.trim()) throw new Error('EMPTY_BODY');
    const directory = path.join(this.root, `naver-${randomUUID()}`);
    await privateDir(path.join(directory, 'images'));
    const file = path.join(directory, 'post.md');
    await writeNew(file, markdown);
    return { title, markdown_file: file, image_directory: path.join(directory, 'images'), remote_saved: false };
  }

  async prepare({ blog, title, markdown_file, category = '', tags = [], mode = 'draft', visibility = 'private' }) {
    const blog_id = naverBlogId(blog);
    if (!title.trim() || title.length > 300) throw new Error('TITLE_INVALID');
    if (!['draft', 'publish'].includes(mode) || !['private', 'public'].includes(visibility)) throw new Error('WRITE_OPTIONS_INVALID');
    if (!Array.isArray(tags) || tags.length > 30 || tags.some(t => typeof t !== 'string' || !t.trim() || /[,#\n\r]/.test(t))) throw new Error('TAGS_INVALID');
    const file = await within(this.root, markdown_file);
    const source = await readLimited(file, 1024 * 1024);
    const markdown = source.toString('utf8');
    if (/^---\r?\n/.test(markdown)) throw new Error('NAVER_PLAIN_MARKDOWN_REQUIRED: frontmatter 없이 본문만 사용하세요.');
    const html = renderMarkdown(markdown);
    const inspection = await this.engine({ action: 'inspect', markdown });
    // Both parsers must agree: otherwise embedded/reference images could be lost silently.
    const images = [...new Set(inspection.images)];
    if (JSON.stringify([...new Set(imageUrls(html))].sort()) !== JSON.stringify([...images].sort())) throw new Error('NAVER_IMAGE_SYNTAX_UNSUPPORTED: 이미지는 독립된 줄의 ![설명](상대경로)로 작성하세요.');
    const assets = [];
    for (const src of images) {
      if (/^[a-z][a-z0-9+.-]*:|^\/\/|^\//i.test(src)) throw new Error('LOCAL_RELATIVE_IMAGES_REQUIRED');
      const image = await within(path.dirname(file), decodeURIComponent(src));
      await within(this.root, image);
      const bytes = await readLimited(image, 10 * 1024 * 1024);
      const size = imageSize(bytes);
      if (!['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(size.type)) throw new Error('IMAGE_TYPE_UNSUPPORTED');
      assets.push({ src, file: image, digest: hash(bytes), type: size.type });
    }
    for (const [token, plan] of this.plans) if (Date.now() - plan.time > TTL) this.plans.delete(token);
    const token = randomUUID();
    const dir = path.join(this.state, 'previews'); await privateDir(dir);
    const preview_file = path.join(dir, token + '.html');
    const content = rewriteImages(html, new Map(assets.map(a => [a.src, pathToFileURL(a.file).href])));
    await writeNew(preview_file, '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src file:; style-src \'unsafe-inline\'"><style>body{max-width:800px;margin:40px auto;font:18px/1.7 sans-serif}img{max-width:100%}table,td,th{border:1px solid #aaa}</style>' + content);
    const plan = { blog_id, title: title.trim(), file, digest: hash(source), markdown, category, tags, mode, visibility, assets, time: Date.now() };
    this.plans.set(token, plan);
    return { confirmation_token: token, platform: 'naver', blog_id, title: plan.title, mode, visibility, category, tags, preview_file, image_count: assets.length, expires_in_seconds: TTL / 1000,
      warnings: ['미리보기와 네이버 최종 서식은 다를 수 있습니다.', ...inspection.warnings] };
  }

  async commit(token, confirm) {
    if (confirm !== true) throw new Error('CONFIRM_REQUIRED');
    const plan = this.plans.get(token);
    if (!plan || Date.now() - plan.time > TTL) throw new Error('PLAN_EXPIRED');
    await within(this.root, plan.file);
    if (hash(await readLimited(plan.file, 1024 * 1024)) !== plan.digest) throw new Error('FILE_CHANGED');
    const staged = [];
    for (const a of plan.assets) {
      await within(this.root, a.file);
      const bytes = await readLimited(a.file, 10 * 1024 * 1024);
      if (hash(bytes) !== a.digest) throw new Error('IMAGE_CHANGED');
      staged.push({ ...a, bytes });
    }
    const directory = path.join(this.state, 'operations', token); await privateDir(directory);
    const assets = {};
    for (const [i, a] of staged.entries()) {
      const target = path.join(directory, `${i}.${a.type}`);
      await writeNew(target, a.bytes); assets[a.src] = target;
    }
    await writeNew(path.join(directory, 'source.md'), plan.markdown);
    await writeNew(path.join(directory, 'plan.json'), JSON.stringify({ blog_id: plan.blog_id, title: plan.title, mode: plan.mode, visibility: plan.visibility, category: plan.category, tags: plan.tags }));
    await this.close();
    this.plans.delete(token); // Consume before the first remote write; do not retry unknown outcomes.
    const journal = path.join(directory, 'started.json');
    await writeNew(journal, JSON.stringify({ status: 'started', mode: plan.mode, time: Date.now() }));
    try {
      const result = await this.engine({ action: 'write', blog_id: plan.blog_id, title: plan.title, markdown: plan.markdown, category: plan.category, tags: plan.tags, mode: plan.mode, visibility: plan.visibility, staging: directory, assets });
      await writeNew(path.join(directory, 'result.json'), JSON.stringify(result));
      return { ...result, journal };
    } catch (error) {
      await writeNew(path.join(directory, 'error.json'), JSON.stringify({ status: 'outcome_requires_review', error: error.message }));
      throw new Error(`${error.message}; 작업 기록: ${journal}. 이미지나 임시저장이 남았을 수 있으니 자동 재시도하지 마세요.`);
    }
  }
}
