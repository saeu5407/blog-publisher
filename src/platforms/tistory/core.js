import YAML from 'yaml';
import { load } from 'cheerio';
import { parse } from 'acorn';
export * from '../../shared/content.js';

export function blogOrigin(value) {
  const u = new URL(value.includes('://') ? value : `https://${value}`);
  if (u.protocol !== 'https:' || !/^[a-z0-9][a-z0-9-]*\.tistory\.com$/.test(u.hostname) || u.port || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('BLOG_INVALID: https://name.tistory.com 형태를 사용하세요.');
  return u.origin;
}
export function postId(value) {
  if (!/^[1-9]\d*$/.test(String(value))) throw new Error('POST_ID_INVALID');
  return String(value);
}
export function splitMarkdown(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) throw new Error('FRONTMATTER_REQUIRED: title, blog를 지정하세요.');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) throw new Error('FRONTMATTER_INVALID');
  const meta = YAML.parse(match[1], { maxAliasCount: 0 });
  if (!meta || typeof meta.title !== 'string' || !meta.title.trim()) throw new Error('TITLE_REQUIRED');
  if (['reservedDate', 'isScheduled', 'published', 'schedule', 'publish_at'].some(k => k in meta)) throw new Error('SCHEDULE_FIELD_INVALID: 예약은 scheduled_at에 시간대를 포함해 지정하세요.');
  if (meta.scheduled_at != null) scheduleTimestamp(meta.scheduled_at);
  meta.blog = blogOrigin(meta.blog ?? '');
  if (meta.post_id != null) meta.post_id = postId(meta.post_id);
  if (meta.tags != null && (!Array.isArray(meta.tags) || meta.tags.some(t => typeof t !== 'string' || t.includes(',')))) throw new Error('TAGS_INVALID');
  if (meta.category != null && (!Number.isSafeInteger(meta.category) || meta.category < 0)) throw new Error('CATEGORY_INVALID');
  if (meta.visibility != null && !['private', 'public'].includes(meta.visibility)) throw new Error('VISIBILITY_UNSUPPORTED: private/public만 지원합니다.');
  if (!match[2].trim()) throw new Error('EMPTY_BODY');
  return { meta, markdown: match[2] };
}
export function scheduleTimestamp(value, now = Date.now()) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error('SCHEDULE_TIMEZONE_REQUIRED: 예: 2026-10-01T09:00:00+09:00');
  const ms = Date.parse(value);
  const [y, m, d, hh, mm, ss] = value.match(/\d+/g).slice(0, 6).map(Number);
  if (!Number.isFinite(ms) || m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate() || hh > 23 || mm > 59 || ss > 59) throw new Error('SCHEDULE_DATE_INVALID');
  if (ms < now + 60000) throw new Error('SCHEDULE_MUST_BE_FUTURE: 최소 1분 이후로 지정하세요.');
  return Math.floor(ms / 1000);
}
export function attachmentRefs(content) {
  return [...new Set([...content.matchAll(/\[##_(?:Image|ImageGrid|ImageSlide|File)\|([^|]+)\|[\s\S]*?_##\]/g)].flatMap(m => m[1].split(',')))];
}
export function mediaUrl(value) {
  const u = new URL(value);
  const domains = ['kakaocdn.net', 'daumcdn.net', 'tistory.com'];
  if (u.protocol !== 'https:' || u.port || u.username || u.password || !domains.some(d => u.hostname === d || u.hostname.endsWith('.' + d))) throw new Error('MEDIA_HOST_NOT_ALLOWED: 원격 이미지는 티스토리/카카오 CDN만 허용합니다. 다른 이미지는 로컬 파일로 준비하세요.');
  return u.href;
}
export function imageDisplaySize(size, maxWidth = 720) {
  if (!Number.isFinite(maxWidth) || maxWidth < 1 || !Number.isFinite(size.width) || size.width < 1 || !Number.isFinite(size.height) || size.height < 1) throw new Error('IMAGE_DIMENSIONS_INVALID');
  const width = Math.min(size.width, maxWidth);
  return { originWidth: size.width, originHeight: size.height, style: 'alignCenter', width, height: Math.max(1, Math.round(size.height * width / size.width)) };
}
export function fitImageTokens(html, maxWidth = 720) {
  return html.replace(/(\[##_Image\|[^|]+\|CDM\|1\.3\|)([\s\S]*?)(_##\])/g, (_, start, json, end) => {
    const data = JSON.parse(json);
    const fitted = imageDisplaySize({ width: Number(data.originWidth), height: Number(data.originHeight) }, maxWidth);
    // Keep an explicitly smaller display size, including its aspect ratio.
    if (Number(data.width) > 0 && Number(data.width) < fitted.width) { fitted.width = Number(data.width); fitted.height = Math.max(1, Math.round(data.originHeight * fitted.width / data.originWidth)); }
    return start + JSON.stringify({ ...data, ...fitted }) + end;
  });
}
export function imageAttachment(upload, size, maxWidth = 720) {
  const u = new URL(mediaUrl(upload.url));
  if (!u.pathname.startsWith('/dna/') || !upload.key || !upload.filename || u.pathname !== `/dna/${upload.key}/${upload.filename}`) throw new Error('UPLOAD_SCHEMA_CHANGED');
  const ref = ('kage@' + u.pathname.slice(5) + u.search).replaceAll('&', '&amp;');
  if (/[|<>\r\n]/.test(ref)) throw new Error('UPLOAD_REFERENCE_INVALID');
  return { ref, token: `[##_Image|${ref}|CDM|1.3|${JSON.stringify(imageDisplaySize(size, maxWidth))}_##]` };
}
// Parse literal data only: no eval of downloaded scripts.
function literal(node) {
  if (!node) return undefined;
  if (node.type === 'Literal') return node.value;
  if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'Literal') return -node.argument.value;
  if (node.type === 'ArrayExpression') return node.elements.map(literal);
  if (node.type === 'ObjectExpression') {
    const result = Object.create(null);
    for (const p of node.properties) {
      if (p.type !== 'Property' || p.computed || p.kind !== 'init') continue;
      const key = p.key.name ?? p.key.value;
      if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
      const value = literal(p.value); if (value !== undefined) result[key] = value;
    }
    return result;
  }
}
export function parseEditorData(html, id) {
  const $ = load(html); const candidates = []; let config;
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ObjectExpression') {
      const value = literal(node);
      if (value?.post && value?.blog && value.postType === 'post' && String(value.post.id) === String(id)) config = value;
      if (typeof value?.content === 'string' && typeof value?.title === 'string' && String(value.id ?? value.entryId) === String(id)) candidates.push(value);
    }
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') walk(value);
  }
  $('script:not([src])').each((_, el) => { try { walk(parse($(el).html() || '', { ecmaVersion: 'latest' })); } catch {} });
  let full = candidates.find(c => ['visibility', 'category', 'tag', 'slogan', 'cclCommercial', 'cclDerive', 'uselessMarginForEntry', 'attachments', 'type', 'published'].every(k => k in c));
  if (config) {
    const p = config.post;
    const required = ['title', 'content', 'slogan', 'published', 'category', 'visibility', 'password', 'acceptComment', 'cclCommercial', 'cclDerive', 'tags', 'daumLikeCategory', 'thumbnail'];
    if (!required.every(k => k in p) || !Array.isArray(p.tags) || p.tags.some(t => typeof t !== 'string') || ![0, 1].includes(Number(config.blog.uselessMargin)) || p.restrictLocked || p.restrictType) throw new Error('EDITOR_SCHEMA_UNSUPPORTED');
    full = { title: p.title, content: p.content, slogan: p.slogan, published: Number(p.published), category: Number(p.category), visibility: Number(p.visibility), password: p.password, acceptComment: p.acceptComment, cclCommercial: Number(p.cclCommercial), cclDerive: Number(p.cclDerive), tag: p.tags.join(','), daumLike: p.daumLikeCategory, thumbnail: p.thumbnail, uselessMarginForEntry: Number(config.blog.uselessMargin), attachments: attachmentRefs(p.content), type: 'post' };
  }
  if (!full) throw new Error('EDITOR_SCHEMA_UNSUPPORTED: 수정 설정을 온전히 읽을 수 없습니다. 실제 편집 화면 스키마 확인이 필요합니다.');
  if (!Number.isSafeInteger(full.published) || full.published < 0) throw new Error('PUBLISHED_INVALID');
  // The editor returns -20 for scheduled public posts; save requests use 20
  // with the future published timestamp.
  if (full.visibility === -20 && full.published > 1) full.visibility = 20;
  if (![0, 20].includes(full.visibility) || full.type !== 'post') throw new Error('POST_TYPE_UNSUPPORTED: 일반 공개/비공개 글만 지원합니다.');
  if (!Number.isInteger(full.category) || typeof full.tag !== 'string' || !Array.isArray(full.attachments) || full.attachments.some(a => typeof a !== 'string')) throw new Error('EDITOR_SCHEMA_UNSUPPORTED');
  const allowed = ['title', 'content', 'visibility', 'category', 'tag', 'slogan', 'cclCommercial', 'cclDerive', 'uselessMarginForEntry', 'attachments', 'type', 'published', 'password', 'serviceCategoryId', 'acceptComment', 'daumLike', 'thumbnail'];
  return Object.fromEntries(allowed.filter(k => k in full).map(k => [k, full[k]]));
}
export function expandImages(html) {
  return html.replace(/\[##_Image\|([^|]+)\|CDM\|1\.3\|([\s\S]*?)_##\]/g, (all, ref, json) => {
    if (!ref.startsWith('kage@')) throw new Error('IMAGE_TOKEN_UNSUPPORTED');
    JSON.parse(json); // reject malformed embedded metadata
    return `<img src="https://blog.kakaocdn.net/dna/${ref.slice(5).replaceAll('"', '&quot;')}" alt="">`;
  });
}
