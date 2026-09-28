import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, readFile, symlink } from 'node:fs/promises';
import { NaverService, naverBlogId } from '../src/platforms/naver/service.js';
import { commands } from '../src/commands.js';
import { imageUrls, renderMarkdown } from '../src/platforms/tistory/core.js';

async function fixture(remote = async () => ({ saved: true, verified: 'draft_list' })) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blog-mcp-naver-'));
  const calls = [];
  const engine = async payload => {
    calls.push(payload);
    if (payload.action === 'inspect') return { images: imageUrls(renderMarkdown(payload.markdown)), warnings: [] };
    return remote(payload);
  };
  const service = new NaverService(root, path.join(root, '.state'), engine);
  const file = path.join(root, 'post.md');
  await writeFile(file, '## 제목\n\n**본문**입니다.');
  return { root, file, service, calls, args: { blog: 'example_blog', title: '테스트', markdown_file: file } };
}

test('Naver blog targets reject foreign origins, query strings and paths', () => {
  assert.equal(naverBlogId('https://blog.naver.com/example_blog/'), 'example_blog');
  for (const value of ['https://evil.example/id', 'https://user@blog.naver.com/id', 'https://blog.naver.com/id?x=1', 'a/b', 'https://blog.naver.com/id/123', 'file:///etc/passwd']) assert.throws(() => naverBlogId(value));
});

test('Naver prepare is local-only and defaults to private draft', async () => {
  const f = await fixture(); const result = await f.service.prepare(f.args);
  assert.equal(result.mode, 'draft'); assert.equal(result.visibility, 'private');
  assert.deepEqual(f.calls.map(c => c.action), ['inspect']);
  assert.match(await readFile(result.preview_file, 'utf8'), /Content-Security-Policy/);
});

test('Naver commit needs approval and rejects changed source', async () => {
  const f = await fixture(); const p = await f.service.prepare(f.args);
  await assert.rejects(f.service.commit(p.confirmation_token, false), /CONFIRM_REQUIRED/);
  await writeFile(f.file, '바뀐 본문');
  await assert.rejects(f.service.commit(p.confirmation_token, true), /FILE_CHANGED/);
  assert.equal(f.calls.filter(c => c.action === 'write').length, 0);
});

test('Naver failed write consumes token and retains a durable record', async () => {
  const f = await fixture(async () => { throw new Error('PUBLISH_OUTCOME_UNKNOWN'); });
  const p = await f.service.prepare({ ...f.args, mode: 'publish', visibility: 'public' });
  await assert.rejects(f.service.commit(p.confirmation_token, true), /PUBLISH_OUTCOME_UNKNOWN/);
  await assert.rejects(f.service.commit(p.confirmation_token, true), /PLAN_EXPIRED/);
  const journal = path.join(f.root, '.state/naver/operations', p.confirmation_token, 'error.json');
  assert.equal(JSON.parse(await readFile(journal)).status, 'outcome_requires_review');
  assert.equal(f.calls.filter(c => c.action === 'write').length, 1);
});

test('Naver commit forwards only approved metadata and frozen image copies', async () => {
  const f = await fixture();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  await writeFile(path.join(f.root, 'image.png'), png);
  await writeFile(f.file, '본문\n\n![설명](image.png)');
  const p = await f.service.prepare({ ...f.args, category: '기술', tags: ['MCP'], mode: 'publish' });
  const result = await f.service.commit(p.confirmation_token, true);
  const call = f.calls.find(c => c.action === 'write');
  assert.equal(call.visibility, 'private'); assert.equal(call.category, '기술');
  assert.deepEqual(call.tags, ['MCP']); assert.notEqual(call.assets['image.png'], path.join(f.root, 'image.png'));
  assert.deepEqual(await readFile(call.assets['image.png']), png);
  assert.ok(result.journal);
});

test('Naver rejects external images, frontmatter and escaping symlinks', async () => {
  const f = await fixture();
  await writeFile(f.file, '![x](https://example.com/image.png)');
  await assert.rejects(f.service.prepare(f.args), /LOCAL_RELATIVE_IMAGES_REQUIRED/);
  await writeFile(f.file, '---\ntitle: test\n---\nbody');
  await assert.rejects(f.service.prepare(f.args), /NAVER_PLAIN_MARKDOWN_REQUIRED/);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'blog-mcp-outside-'));
  await writeFile(path.join(outside, 'image.png'), 'not an image');
  await symlink(path.join(outside, 'image.png'), path.join(f.root, 'escape.png'));
  await writeFile(f.file, '![x](escape.png)');
  await assert.rejects(f.service.prepare(f.args), /PATH_OUTSIDE_WORKSPACE/);
});

test('Naver rejects expired tokens, invalid modes and too many tags', async () => {
  const f = await fixture();
  await assert.rejects(f.service.prepare({ ...f.args, mode: 'delete' }), /WRITE_OPTIONS_INVALID/);
  await assert.rejects(f.service.prepare({ ...f.args, tags: Array(31).fill('tag') }), /TAGS_INVALID/);
  const p = await f.service.prepare(f.args);
  f.service.plans.get(p.confirmation_token).time = 0;
  await assert.rejects(f.service.commit(p.confirmation_token, true), /PLAN_EXPIRED/);
});

test('both platforms expose validated CLI commands', () => {
  const registry = commands({}, {}, {});
  assert.equal(registry.size, 18);
  assert.ok(registry.has('upload_post')); assert.ok(registry.has('naver_prepare_post'));
  assert.throws(() => registry.get('commit_post').schema.parse({ confirmation_token: 'bad', confirm: false }));
});
