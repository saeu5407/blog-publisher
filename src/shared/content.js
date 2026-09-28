import { createHash } from 'node:crypto';
import { realpath, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { markdownParser, styleTables, styleCodeBlocks } from './formatting.js';
import sanitize from 'sanitize-html';
import Turndown from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { load } from 'cheerio';

export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export async function within(root, input) {
  const base = await realpath(root);
  const resolved = await realpath(path.resolve(base, input));
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error('PATH_OUTSIDE_WORKSPACE');
  return resolved;
}
export async function privateDir(dir) { await mkdir(dir, { recursive: true, mode: 0o700 }); }
export async function writeNew(file, value) { await writeFile(file, value, { flag: 'wx', mode: 0o600 }); }
export async function readLimited(file, limit = 10 * 1024 * 1024) {
  const { stat } = await import('node:fs/promises');
  if ((await stat(file)).size > limit) throw new Error('FILE_TOO_LARGE');
  return readFile(file);
}
export function joinMarkdown(meta, markdown) { return `---\n${YAML.stringify(meta)}---\n\n${markdown}\n`; }
export function renderMarkdown(markdown) {
  if (/\[##_/.test(markdown)) throw new Error('UNSUPPORTED_HTML: 티스토리 토큰은 로컬 이미지로 변환하세요.');
  const html = markdownParser.parse(markdown);
  const clean = sanitize(html, {
    allowedTags: [...sanitize.defaults.allowedTags, 'img', 'figure', 'figcaption', 'del', 'input'],
    allowedAttributes: { ...sanitize.defaults.allowedAttributes, '*': ['class', 'id'], img: ['src', 'alt', 'title', 'width', 'height'], input: ['type', 'checked', 'disabled'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'] },
    allowedSchemes: ['https', 'http', 'mailto'], allowProtocolRelative: false,
  });
  // Fail rather than silently deleting embeds or dangerous HTML.
  if (/<(?:script|iframe|video|audio|object|embed|style)\b|\son\w+\s*=|javascript:|\[##_/i.test(html)) throw new Error('UNSUPPORTED_HTML: 실행 콘텐츠/임베드/티스토리 토큰을 먼저 검토하세요.');
  const $ = load(clean, null, false);
  if ($('img').toArray().some(el => !$(el).attr('src'))) throw new Error('IMAGE_SOURCE_INVALID');
  return styleCodeBlocks(styleTables(clean));
}
export function htmlToMarkdown(html) {
  const service = new Turndown({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  service.use(gfm);
  service.keep(['figure', 'figcaption', 'iframe', 'video', 'audio', 'details', 'summary']);
  return service.turndown(html);
}
export function imageUrls(html) {
  const $ = load(html, null, false);
  return [...new Set($('img').map((_, el) => $(el).attr('src')).get())];
}
export function rewriteImages(html, mapping) {
  const $ = load(html, null, false);
  $('img').each((_, el) => { const src = $(el).attr('src'); if (mapping.has(src)) $(el).attr('src', mapping.get(src)); });
  return $.html();
}
