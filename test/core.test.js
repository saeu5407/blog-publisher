import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { blogOrigin, splitMarkdown, renderMarkdown, htmlToMarkdown, imageAttachment, parseEditorData, within, mediaUrl, expandImages, imageDisplaySize, fitImageTokens } from '../src/platforms/tistory/core.js';

export const fixture = { id: '12', title: '테스트', content: '<h2>제목</h2><p>본문</p>', visibility: 0, category: 3, tag: 'AI,논문', slogan: 'test', cclCommercial: 0, cclDerive: 0, uselessMarginForEntry: 1, attachments: [], type: 'post', published: 1 };
test('scheduled public editor visibility normalizes while preserving timestamp', () => {
  const post = { ...fixture, visibility: -20, published: 1790578560 };
  const parsed = parseEditorData(`<script>const post=${JSON.stringify(post)}</script>`, '12');
  assert.equal(parsed.visibility, 20);
  assert.equal(parsed.published, post.published);
  post.published = 1;
  assert.throws(() => parseEditorData(`<script>const post=${JSON.stringify(post)}</script>`, '12'), /POST_TYPE_UNSUPPORTED/);
});
test('large images shrink, small images do not upscale, originals remain intact', () => {
  assert.deepEqual(imageDisplaySize({ width: 1536, height: 1024 }), { originWidth:1536, originHeight:1024, style:'alignCenter', width:720, height:480 });
  assert.equal(imageDisplaySize({ width:300, height:200 }).width, 300);
  const token = '[##_Image|kage@a/img.png?x=1&amp;y=2|CDM|1.3|{"originWidth":1536,"originHeight":1024,"width":400,"caption":"설명"}_##]';
  const result = fitImageTokens(token);
  assert.match(fitImageTokens('[##_Image|kage@a/img.png|CDM|1.3|{"originWidth":"1536","originHeight":"1024"}_##]'), /"width":720/);
  assert.match(result, /"width":400/); assert.match(result, /"caption":"설명"/); assert.ok(result.includes('kage@a/img.png?x=1&amp;y=2'));
  assert.throws(() => imageDisplaySize({width:0,height:1}));
});
test('blog domain restricted; credentials/custom origins blocked', () => {
  assert.equal(blogOrigin('my-blog.tistory.com'), 'https://my-blog.tistory.com');
  for (const bad of ['http://x.tistory.com', 'https://tistory.com.evil.test', 'https://a:b@x.tistory.com', 'https://x.tistory.com/manage', 'https://127.0.0.1']) assert.throws(() => blogOrigin(bad));
});
test('markdown frontmatter validates metadata', () => {
  const p = splitMarkdown('---\ntitle: 테스트\nblog: x.tistory.com\ntags: [AI]\n---\n# 본문'); assert.equal(p.meta.blog, 'https://x.tistory.com');
  assert.throws(() => splitMarkdown('# 제목'));
  assert.throws(() => splitMarkdown('---\ntitle: t\nblog: x.tistory.com\ncategory: -1\n---\ntext'));
});
test('GFM tables, fenced code, Korean and images round trip', () => {
  const text = '# 제목\n\n| 이름 | 값 |\n| --- | --- |\n| 모델 | 4 |\n\n```js\nconst x = 1;\n```\n\n![설명](images/a.png)';
  const html = renderMarkdown(text); assert.match(html, /<table\b/); assert.match(html, /language-js/); assert.match(html, /images\/a.png/);
  const md = htmlToMarkdown(html); assert.match(md, /제목/); assert.match(md, /모델/); assert.match(md, /const x/); assert.match(md, /images\/a.png/);
});
test('active HTML and opaque tistory macros are blocked', () => {
  for (const s of ['<script>alert(1)</script>', '<img src="a.png" onerror="alert(1)">', '<iframe src="https://x.test"></iframe>', '[##_Image|bad_##]']) assert.throws(() => renderMarkdown(s));
});
test('media cannot access private hosts or credentials', () => {
  assert.match(mediaUrl('https://blog.kakaocdn.net/dna/a/img.png'), /kakaocdn/);
  for (const s of ['https://localhost/a', 'http://blog.kakaocdn.net/a', 'https://blog.kakaocdn.net.evil.test/a', 'https://a:b@blog.kakaocdn.net/a']) assert.throws(() => mediaUrl(s));
});
test('image token and attachments use exact same escaped reference', () => {
  const a = imageAttachment({ url: 'https://blog.kakaocdn.net/dna/abc/img.png?a=1&b=2', key: 'abc', filename: 'img.png' }, { width: 2, height: 3 });
  assert.match(a.ref, /a=1&amp;b=2/); assert.ok(a.token.includes(a.ref));
  assert.match(expandImages(a.token), /<img/);
});
test('editor reads only matching literal objects, never executes scripts', () => {
  const p = parseEditorData(`<script>window.entry=${JSON.stringify(fixture)}; throw Error('bad');</script>`, '12');
  assert.equal(p.category, 3); assert.equal(p.content, fixture.content);
  assert.throws(() => parseEditorData(`<script>window.entry=${JSON.stringify(fixture)}</script>`, '99'));
  assert.throws(() => parseEditorData('<script>window.entry = {id:12,title:"x",content:steal()}</script>', '12'));
  assert.throws(() => parseEditorData('<p>로그인</p>', '12'));
});
test('workspace traversal and symlinks cannot escape', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tistory-path-test-')); const root = path.join(dir, 'root'); await mkdir(root);
  await writeFile(path.join(dir, 'secret'), 'secret'); await symlink(path.join(dir, 'secret'), path.join(root, 'link'));
  await assert.rejects(within(root, '../secret')); await assert.rejects(within(root, 'link'));
});
