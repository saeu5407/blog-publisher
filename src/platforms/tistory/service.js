import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { load } from 'cheerio';
import { imageSize } from 'image-size';
import { hash, within, privateDir, writeNew, readLimited, splitMarkdown, joinMarkdown, renderMarkdown, htmlToMarkdown, imageUrls, rewriteImages, imageAttachment, expandImages, blogOrigin, scheduleTimestamp } from './core.js';
import { categoryAppend, categoryRevision } from './categories.js';
import { normalizedTags } from '../../shared/formatting.js';

const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
export class Service {
  constructor(root, state, api, imageMaxWidth = 720) { if (!Number.isFinite(imageMaxWidth) || imageMaxWidth < 1) throw new Error('IMAGE_MAX_WIDTH_INVALID'); this.imageMaxWidth = imageMaxWidth; this.root = root; this.state = state; this.api = api; this.plans = new Map(); this.busy = false; }
  async exclusive(fn) {
    if (this.busy) throw new Error('BUSY: 이전 작업이 끝난 뒤 다시 시도하세요.');
    this.busy = true; try { return await fn(); } finally { this.busy = false; }
  }
  async snapshot(post) {
    const dir = path.join(this.state, 'backups'); await privateDir(dir);
    const file = path.join(dir, randomUUID() + '.json'); await writeNew(file, JSON.stringify(post, null, 2)); return file;
  }
  async createMarkdown(blog, title, markdown, category = 0, tags = []) {
    const source = joinMarkdown({ title, blog: blogOrigin(blog), category, tags, visibility: 'private' }, markdown);
    splitMarkdown(source); renderMarkdown(markdown);
    const dir = path.join(this.root, `draft-${randomUUID().slice(0, 8)}`); await privateDir(path.join(dir, 'images'));
    const file = path.join(dir, 'post.md'); await writeNew(file, source);
    return { markdown_file: file, image_directory: path.join(dir, 'images'), remote_saved: false, next_step: '로컬 이미지를 준비하고 upload_post로 미리보기를 확인하세요.' };
  }
  async prepareCategory(blog, name, parentId = 0) {
    blog = blogOrigin(blog);
    const data = await this.api.categoryTree(blog), change = categoryAppend(data, name, parentId);
    const token = randomUUID();
    this.plans.set(token, { operation: 'category_create', blog, change, original: data, revision: categoryRevision(data), time: Date.now() });
    return { confirmation_token: token, blog, operation: 'category_create', name: change.name, parent_id: parentId, path: change.path, expires_in_seconds: 600, warning: '미리보기만 생성했습니다. 실제 생성은 commit_category로 승인 후 진행합니다.' };
  }
  async commitCategory(token, confirm) {
    if (confirm !== true) throw new Error('CONFIRM_REQUIRED');
    const plan = this.plans.get(token);
    if (!plan || plan.operation !== 'category_create' || Date.now() - plan.time > 600000) throw new Error('PLAN_EXPIRED');
    if (categoryRevision(await this.api.categoryTree(plan.blog)) !== plan.revision) throw new Error('CATEGORY_CONFLICT');
    const backup = await this.snapshot({ blog: plan.blog, categories: plan.original, intended: plan.change.body });
    const dir = path.join(this.state, 'operations'); await privateDir(dir);
    const journal = path.join(dir, `${token}.json`);
    this.plans.delete(token);
    await writeNew(journal, JSON.stringify({ status: 'started', operation: plan.operation, blog: plan.blog, path: plan.change.path, backup }));
    await this.api.appendCategory(plan.blog, plan.change.body);
    const result = { saved: true, verified: false, backup, journal };
    try { const { items } = await this.api.categories(plan.blog); result.category = items.find(c => c.name === plan.change.name && c.parent_id === plan.change.parent_id); result.verified = !!result.category; } catch {}
    await writeNew(path.join(dir, `${token}-result.json`), JSON.stringify(result));
    return { ...result, warning: result.verified ? undefined : '저장 응답 후 재조회 검증에 실패했습니다. 재생성하지 말고 카테고리 목록을 확인하세요.' };
  }
  async download(blog, id) {
    const post = await this.api.read(blog, id);
    const expanded = expandImages(post.content);
    if (/\[##_/.test(expanded)) throw new Error('UNSUPPORTED_TISTORY_BLOCK: 갤러리/첨부/임베드 변환은 아직 지원하지 않습니다.');
    const dir = path.join(this.root, `post-${id}-${randomUUID().slice(0, 8)}`);
    await privateDir(path.join(dir, 'images'));
    const mapping = new Map(); let count = 0;
    for (const url of imageUrls(expanded)) {
      const data = await this.api.downloadImage(url);
      const size = imageSize(data); if (!mime[size.type]) throw new Error('IMAGE_TYPE_UNSUPPORTED');
      const name = `images/${++count}-${hash(data).slice(0, 12)}.${size.type}`;
      await writeNew(path.join(dir, name), data); mapping.set(url, name);
    }
    const md = htmlToMarkdown(rewriteImages(expanded, mapping));
    const meta = { title: post.title, blog, post_id: String(id), category: post.category, tags: post.tag ? post.tag.split(',').filter(Boolean) : [], visibility: post.visibility === 20 ? 'public' : 'private', source_revision: hash(post) };
    if (post.published > 1) meta.scheduled_at = new Date(post.published * 1000).toISOString().replace('.000Z', 'Z');
    await writeNew(path.join(dir, 'post.md'), joinMarkdown(meta, md));
    await writeNew(path.join(dir, 'original.html'), post.content);
    await this.snapshot({ blog, id, post });
    return { markdown_file: path.join(dir, 'post.md'), image_count: count, revision: meta.source_revision, warnings: ['HTML에서 변환한 Markdown입니다. 원래 Markdown 및 디자인의 완전 복원은 아닙니다.', '특수 HTML은 original.html에 보존됩니다. 업로드 전 preview를 확인하세요.'] };
  }
  async prepare(file, operation, requestedVisibility, requestedCategory, requestedSchedule) {
    const resolved = await within(this.root, file);
    const source = await readLimited(resolved);
    const { meta, markdown } = splitMarkdown(source.toString('utf8'));
    if (requestedCategory !== undefined) {
      if (!Number.isSafeInteger(requestedCategory) || requestedCategory < 0) throw new Error('CATEGORY_INVALID');
      meta.category = requestedCategory;
    }
    if (operation === 'create' && meta.post_id) throw new Error('POST_ALREADY_HAS_ID: update_post를 사용하세요.');
    if (operation === 'update' && (!meta.post_id || !meta.source_revision)) throw new Error('DOWNLOAD_FIRST: 기존 글을 다운로드한 Markdown으로 수정하세요.');
    let current = null;
    if (operation === 'update') {
      current = await this.api.read(meta.blog, meta.post_id);
      if (hash(current) !== meta.source_revision) throw new Error('CONFLICT: 서버 글이 변경됐습니다. 다시 다운로드 후 병합하세요.');
    }
    const visibility = requestedVisibility ?? (current?.visibility === 20 ? 'public' : 'private');
    const schedule = requestedSchedule ?? meta.scheduled_at;
    if (current?.published > 1 && !schedule) throw new Error('SCHEDULE_CONFIRM_REQUIRED: 기존 예약 시각을 scheduled_at으로 명시하세요.');
    if (schedule && visibility !== 'public') throw new Error('SCHEDULE_PUBLIC_REQUIRED: 예약 발행은 visibility: public으로 명시하세요.');
    if (meta.visibility && meta.visibility !== visibility && requestedVisibility === undefined) throw new Error('VISIBILITY_CONFIRM_REQUIRED: 변경할 공개 상태를 도구 인자로 명시하세요.');
    const html = renderMarkdown(markdown); const assets = [];
    for (const src of imageUrls(html)) {
      if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(src)) throw new Error('LOCAL_IMAGES_REQUIRED: Markdown 이미지는 먼저 로컬 파일로 내려받으세요.');
      const candidate = await within(path.dirname(resolved), decodeURIComponent(src));
      await within(this.root, candidate);
      const data = await readLimited(candidate, 20 * 1024 * 1024);
      const size = imageSize(data); if (!mime[size.type]) throw new Error('IMAGE_TYPE_UNSUPPORTED');
      assets.push({ src, file: candidate, digest: hash(data), size, mime: mime[size.type] });
    }
    const body = current ? { ...current } : { title: '', content: '', slogan: '', visibility: 0, category: 0, tag: '', published: 1, password: '', uselessMarginForEntry: 1, cclCommercial: 0, cclDerive: 0, type: 'post', attachments: [] };
    Object.assign(body, { title: meta.title, content: html, category: meta.category ?? body.category, tag: meta.tags?.join(',') ?? body.tag, visibility: visibility === 'public' ? 20 : 0 });
    if (schedule) { body.published = scheduleTimestamp(schedule); meta.scheduled_at = schedule; }
    const token = randomUUID(); const previewDir = path.join(this.state, 'previews'); await privateDir(previewDir);
    const previewFile = path.join(previewDir, token + '.html');
    const localMap = new Map(assets.map(a => [a.src, 'file://' + a.file]));
    const preview = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src file:; style-src \'unsafe-inline\'"><style>body{max-width:900px;margin:40px auto;font:18px/1.7 sans-serif}img{max-width:100%}table,th,td{border:1px solid #bbb;border-collapse:collapse;padding:8px}pre{overflow:auto;background:#eee;padding:16px}</style>' + rewriteImages(html, localMap);
    await writeNew(previewFile, preview);
    this.plans.set(token, { file: resolved, digest: hash(source), operation, meta, body, assets, current, time: Date.now() });
    return { confirmation_token: token, operation, blog: meta.blog, post_id: meta.post_id ?? null, title: meta.title, visibility, category_id: body.category, category_validation: 'pending_commit', scheduled_at: schedule ?? null, schedule_timezone: schedule ? '입력 시간대 유지; 서버 전송은 Unix 초' : null, live_write_verified: false, image_count: assets.length, preview_file: previewFile, warnings: ['현재는 미리보기만 생성했습니다. 서버 쓰기 요청은 commit_post에서 실행됩니다.', '비공개 업로드도 임시저장이 아닌 실제 글 생성입니다.', 'list_categories로 분류 이름을 확인하세요. 저장 직전에 카테고리 존재 여부를 검사합니다.', ...(schedule ? ['예약 등록 후 실제 공개 전환은 예약 시각 이후 확인합니다.'] : [])], expires_in_seconds: 600 };
  }
  async commit(token, confirm) {
    if (confirm !== true) throw new Error('CONFIRM_REQUIRED');
    const plan = this.plans.get(token);
    if (!plan || !['create', 'update'].includes(plan.operation) || Date.now() - plan.time > 600000) throw new Error('PLAN_EXPIRED');
    if (plan.meta.scheduled_at) scheduleTimestamp(plan.meta.scheduled_at);
    const categories = await this.api.categories(plan.meta.blog);
    if (!categories.items.some(c => c.id === plan.body.category)) throw new Error('CATEGORY_NOT_FOUND: 카테고리 목록을 다시 확인하세요.');
    if (plan.body.visibility === 20 && categories.items.find(c => c.id === plan.body.category)?.visibility === 0) throw new Error('CATEGORY_PRIVATE: 비공개 카테고리에서는 공개/예약 발행하지 않습니다.');
    const liveFile = await within(this.root, plan.file);
    if (liveFile !== plan.file || hash(await readLimited(liveFile)) !== plan.digest) throw new Error('LOCAL_FILE_CHANGED');
    for (const asset of plan.assets) if (hash(await readLimited(await within(this.root, asset.file), 20 * 1024 * 1024)) !== asset.digest) throw new Error('LOCAL_IMAGE_CHANGED');
    if (plan.current && hash(await this.api.read(plan.meta.blog, plan.meta.post_id)) !== hash(plan.current)) throw new Error('CONFLICT');
    const backup = await this.snapshot({ blog: plan.meta.blog, id: plan.meta.post_id, original: plan.current, source_markdown: (await readFile(plan.file)).toString('utf8'), intended: plan.body });
    // Consume BEFORE any write. Ambiguous outcomes must never auto-retry.
    this.plans.delete(token);
    const journalDir = path.join(this.state, 'operations'); await privateDir(journalDir);
    const journal = path.join(journalDir, token + '.json');
    await writeNew(journal, JSON.stringify({ status: 'started', operation: plan.operation, blog: plan.meta.blog, post_id: plan.meta.post_id, backup }));
    const $ = load(plan.body.content, null, false); const attachments = new Set(plan.body.attachments);
    let content = ''; const replacements = [];
    for (const asset of plan.assets) {
      const upload = await this.api.uploadImage(plan.meta.blog, await readFile(asset.file), path.basename(asset.file), asset.mime);
      const attachment = imageAttachment(upload, asset.size, this.imageMaxWidth); attachments.add(attachment.ref);
      const marker = `TISTORYIMAGE${randomUUID().replaceAll('-', '')}`;
      $('img').each((_, el) => {
        if ($(el).attr('src') !== asset.src) return;
        const alt = $(el).attr('alt');
        if (alt) {
          const figure = $('<figure></figure>'); figure.append(marker); figure.append($('<figcaption></figcaption>').text(alt)); $(el).replaceWith(figure);
        } else $(el).replaceWith(marker);
      });
      replacements.push([marker, attachment.token]);
    }
    content = $.html(); for (const [marker, value] of replacements) content = content.replaceAll(marker, value);
    // Check again after potentially slow image upload. Server has no atomic If-Match support.
    if (plan.current && hash(await this.api.read(plan.meta.blog, plan.meta.post_id)) !== hash(plan.current)) throw new Error('CONFLICT_AFTER_IMAGE_UPLOAD: 이미지 일부가 업로드됐지만 본문 수정은 하지 않았습니다.');
    if (plan.meta.scheduled_at) scheduleTimestamp(plan.meta.scheduled_at);
    const result = await this.api.save(plan.meta.blog, plan.meta.post_id, { ...plan.body, content, attachments: [...attachments] });
    await writeNew(path.join(journalDir, token + '-result.json'), JSON.stringify(result));
    const id = plan.meta.post_id ?? new URL(result.url).pathname.match(/^\/(\d+)\/?$/)?.[1];
    let verified = false; let revision;
    try { const post = await this.api.read(plan.meta.blog, id); verified = post.title === plan.body.title && post.visibility === plan.body.visibility && post.category === plan.body.category && normalizedTags(post.tag) === normalizedTags(plan.body.tag) && (!plan.meta.scheduled_at || post.published === plan.body.published); if (verified) revision = hash(post); } catch {}
    let workingCopy;
    if (verified) {
      const { markdown } = splitMarkdown((await readFile(plan.file)).toString('utf8'));
      workingCopy = path.join(path.dirname(plan.file), `post-${id}-${token.slice(0, 8)}.md`);
      await writeNew(workingCopy, joinMarkdown({ ...plan.meta, category: plan.body.category, post_id: String(id), source_revision: revision, visibility: plan.body.visibility === 20 ? 'public' : 'private' }, markdown));
    }
    return { ...result, post_id: id, verified_metadata: verified, working_copy: workingCopy, backup, journal, warning: '저장 응답을 받았습니다. 본문·이미지의 실제 렌더링과 장기 유지 여부는 브라우저에서 확인해야 합니다. 다시 생성하지 마세요.' };
  }
}
