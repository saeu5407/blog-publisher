import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Service } from '../src/platforms/tistory/service.js';
import { hash, joinMarkdown } from '../src/platforms/tistory/core.js';

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tistory-service-test-')); const state = path.join(root, '.state'); await mkdir(state);
  let post = { title: '기존', content: '<p>기존 본문</p>', visibility: 20, category: 9, tag: 'AI', slogan: 'old-slug', cclCommercial: 1, cclDerive: 2, uselessMarginForEntry: 0, attachments: [], type: 'post', published: 1 };
  const calls = [];
  const api = { read: async () => ({ ...post }), uploadImage: async () => { calls.push('image'); return { url: 'https://blog.kakaocdn.net/dna/abc/img.png?a=1&b=2', key: 'abc', filename: 'img.png' }; }, save: async (blog, id, body) => { calls.push({ id, body }); post = body; return { url: blog + '/' + (id || 13) }; } };
  const service = new Service(root, state, api);
  api.categories = async () => ({ items: [{ id: 0 }, { id: 9 }] });
  const file = path.join(root, 'post.md');
  return { root, state, file, calls, api, service, getPost: () => post, change: () => { post = { ...post, title: '웹 수정' }; } };
}
test('prepare is read-only remotely and create defaults private', async () => {
  const s = await setup(); await writeFile(s.file, joinMarkdown({ title: '새 글', blog: 'x.tistory.com' }, '본문'));
  const plan = await s.service.prepare(s.file, 'create'); assert.equal(plan.visibility, 'private'); assert.equal(s.calls.length, 0);
  const result = await s.service.commit(plan.confirmation_token, true); assert.equal(s.calls[0].body.visibility, 0); assert.equal(result.verified_metadata, true);
  await assert.rejects(s.service.commit(plan.confirmation_token, true), /PLAN_EXPIRED/);
});
test('update preserves metadata and uses ID, not create', async () => {
  const s = await setup(); await writeFile(s.file, joinMarkdown({ title: '수정', blog: 'x.tistory.com', post_id: '12', source_revision: hash(s.getPost()) }, '새 본문'));
  const plan = await s.service.prepare(s.file, 'update'); await s.service.commit(plan.confirmation_token, true);
  assert.equal(s.calls[0].id, '12'); for (const [k, v] of Object.entries({ visibility: 20, category: 9, tag: 'AI', slogan: 'old-slug', cclCommercial: 1, cclDerive: 2 })) assert.equal(s.calls[0].body[k], v);
});
test('server change after preview blocks write', async () => {
  const s = await setup(); await writeFile(s.file, joinMarkdown({ title: '수정', blog: 'x.tistory.com', post_id: '12', source_revision: hash(s.getPost()) }, '본문'));
  const plan = await s.service.prepare(s.file, 'update'); s.change(); await assert.rejects(s.service.commit(plan.confirmation_token, true), /CONFLICT/); assert.equal(s.calls.length, 0);
});
test('local edit after preview blocks write', async () => {
  const s = await setup(); await writeFile(s.file, joinMarkdown({ title: '새 글', blog: 'x.tistory.com' }, '본문'));
  const plan = await s.service.prepare(s.file, 'create'); await writeFile(s.file, 'changed'); await assert.rejects(s.service.commit(plan.confirmation_token, true), /LOCAL_FILE_CHANGED/);
});
test('image bytes uploaded and exact reference registered', async () => {
  const s = await setup(); await mkdir(path.join(s.root, 'images'));
  await writeFile(path.join(s.root, 'images/a.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=', 'base64'));
  await writeFile(s.file, joinMarkdown({ title: '그림', blog: 'x.tistory.com' }, '![그림](images/a.png)'));
  const p = await s.service.prepare(s.file, 'create'); await s.service.commit(p.confirmation_token, true);
  assert.equal(s.calls[0], 'image'); assert.ok(s.calls[1].body.content.includes(s.calls[1].body.attachments[0]));
});
test('ambiguous save consumes token, leaving durable journal', async () => {
  const s = await setup(); s.api.save = async () => { throw new Error('WRITE_OUTCOME_UNKNOWN'); };
  await writeFile(s.file, joinMarkdown({ title: '글', blog: 'x.tistory.com' }, '본문')); const p = await s.service.prepare(s.file, 'create');
  await assert.rejects(s.service.commit(p.confirmation_token, true), /UNKNOWN/); await assert.rejects(s.service.commit(p.confirmation_token, true), /PLAN_EXPIRED/);
  assert.match(await readFile(path.join(s.state, 'operations', p.confirmation_token + '.json'), 'utf8'), /started/);
});
test('download produces editable metadata and HTML backup', async () => {
  const s = await setup(); const result = await s.service.download('https://x.tistory.com', '12'); const md = await readFile(result.markdown_file, 'utf8'); assert.match(md, /source_revision:/); assert.match(md, /기존 본문/);
});
test('category override is previewed and checked before writes', async () => {
  const s = await setup(); await writeFile(s.file, joinMarkdown({ title: '분류', blog: 'x.tistory.com' }, '본문'));
  const p = await s.service.prepare(s.file, 'create', undefined, 9);
  assert.equal(p.category_id, 9);
  s.api.categories = async () => ({ items: [{ id: 0 }] });
  await assert.rejects(s.service.commit(p.confirmation_token, true), /CATEGORY_NOT_FOUND/);
  assert.equal(s.calls.length, 0);
});
test('schedule cannot silently publish privately or immediately', async () => {
  const s = await setup(); const future = new Date(Date.now() + 3600000).toISOString().replace('.000', '').replace(/\.\d{3}/, '');
  await writeFile(s.file, joinMarkdown({ title: '예약', blog: 'x.tistory.com', scheduled_at: future }, '본문'));
  await assert.rejects(s.service.prepare(s.file, 'create'), /SCHEDULE_PUBLIC_REQUIRED/);
  assert.equal(s.calls.length, 0);
  const p = await s.service.prepare(s.file, 'create', 'public'); assert.equal(p.scheduled_at, future);
  await s.service.commit(p.confirmation_token, true);
  assert.equal(s.calls[0].body.published, Date.parse(future) / 1000);
});
test('expired schedule is rejected again at commit', async () => {
  const s = await setup(); await writeFile(s.file, joinMarkdown({ title: '예약', blog: 'x.tistory.com' }, '본문'));
  const p = await s.service.prepare(s.file, 'create');
  s.service.plans.get(p.confirmation_token).meta.scheduled_at = '2020-01-01T00:00:00Z';
  await assert.rejects(s.service.commit(p.confirmation_token, true), /SCHEDULE_MUST_BE_FUTURE/); assert.equal(s.calls.length, 0);
});
test('local draft creates a valid editable Markdown without remote writes', async () => {
  const s = await setup(); const d = await s.service.createMarkdown('x.tistory.com', '초안', '본문', 9, ['AI']);
  assert.match(await readFile(d.markdown_file, 'utf8'), /category: 9/); assert.equal(s.calls.length, 0);
});
test('downloaded scheduled post round-trips an explicit timezone', async () => {
  const s = await setup(); s.getPost().published = Math.floor(Date.now() / 1000) + 3600;
  const result = await s.service.download('https://x.tistory.com', '12');
  const p = await s.service.prepare(result.markdown_file, 'update');
  assert.match(p.scheduled_at, /Z$/); assert.equal(Date.parse(p.scheduled_at) / 1000, s.getPost().published);
});
