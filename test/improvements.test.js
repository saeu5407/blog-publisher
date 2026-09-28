import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseEditorData, scheduleTimestamp } from '../src/platforms/tistory/core.js';
import { categoryAppend, categoryRevision, flattenCategories } from '../src/platforms/tistory/categories.js';
import { Service } from '../src/platforms/tistory/service.js';

const tree = () => ({ rootLabel: '전체', categories: [{ id: 1, name: '이론', visibility: 20, entries: 3, children: [{ id: 2, name: 'LLM', children: [], visibility: 20 }] }] });
test('current editor Config is normalized without exposing other config', () => {
  const p = { id: '73', title: '글', content: '<p>본문</p>', slogan: 'slug', published: 0, orgPublished: '1738315403', category: '2', visibility: 20, password: '', acceptComment: '1', cclCommercial: '1', cclDerive: '1', tags: ['AI'], daumLikeCategory: null, thumbnail: '', type: '0' };
  const data = { post: p, blog: { uselessMargin: 1 }, postType: 'post', user: { secret: 'hidden' } };
  const read = parseEditorData(`<script>window.Config=${JSON.stringify(data)}</script>`, '73');
  assert.equal(read.type, 'post'); assert.equal(read.category, 2); assert.equal(read.published, 0); assert.equal(read.tag, 'AI'); assert.equal(read.acceptComment, '1'); assert.ok(!JSON.stringify(read).includes('hidden'));
  delete data.post.thumbnail;
  assert.throws(() => parseEditorData(`<script>window.Config=${JSON.stringify(data)}</script>`, '73'), /EDITOR_SCHEMA/);
});
test('schedule requires valid date, timezone and future time', () => {
  const now = Date.parse('2026-09-21T00:00:00Z');
  assert.equal(scheduleTimestamp('2026-10-01T09:00:00+09:00', now), Date.parse('2026-10-01T00:00:00Z') / 1000);
  for (const v of ['2026-10-01T09:00:00', '2027-02-30T00:00:00Z', '2026-01-01T00:00:00Z', 'bad']) assert.throws(() => scheduleTimestamp(v, now));
});
test('category append preserves root, uses parent, rejects duplicate/depth/name', () => {
  const d = tree(); const p = categoryAppend(d, '새 분류', 1);
  assert.equal(p.path, '이론 / 새 분류'); assert.equal(p.body.append[0].priority, 1); assert.equal(p.body.append[0].parent, 1);
  assert.deepEqual(p.body.delete, []); assert.deepEqual(p.body.update, p.body.append); assert.equal(p.body.update[0].id, -1);
  assert.throws(() => categoryAppend(d, 'LLM', 1), /ALREADY_EXISTS/);
  assert.throws(() => categoryAppend(d, '새 분류', 2), /DEPTH_LIMIT/);
  assert.throws(() => categoryAppend(d, 'a/b'), /NAME_INVALID/);
  assert.throws(() => categoryAppend(d, '새 분류', 99), /PARENT_NOT_FOUND/);
  const changed = tree(); changed.categories[0].entries = 5; assert.equal(categoryRevision(d), categoryRevision(changed));
});
test('category creation checks conflict, token type, and consumes token before unknown write', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tistory-category-')); const state = path.join(root, '.state'); await mkdir(state);
  let data = tree(); let writes = 0;
  const api = { categoryTree: async () => data, appendCategory: async () => { writes++; throw new Error('WRITE_OUTCOME_UNKNOWN'); } };
  const s = new Service(root, state, api);
  const p = await s.prepareCategory('x.tistory.com', '새 분류', 1);
  await assert.rejects(s.commit(p.confirmation_token, true), /PLAN_EXPIRED/);
  data = { ...data, rootLabel: '다른 이름' };
  await assert.rejects(s.commitCategory(p.confirmation_token, true), /CATEGORY_CONFLICT/); assert.equal(writes, 0);
  data = tree(); await assert.rejects(s.commitCategory(p.confirmation_token, true), /WRITE_OUTCOME_UNKNOWN/);
  await assert.rejects(s.commitCategory(p.confirmation_token, true), /PLAN_EXPIRED/); assert.equal(writes, 1);
});
test('category commit verifies assigned positive ID from refreshed list', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tistory-category-success-')); const state = path.join(root, '.state'); await mkdir(state);
  const data = tree();
  const api = { categoryTree: async () => data, appendCategory: async (blog, body) => { data.categories.push({ ...body.append[0], id: 3 }); }, categories: async () => ({ items: flattenCategories(data) }) };
  const s = new Service(root, state, api); const p = await s.prepareCategory('x.tistory.com', '새 분류');
  const result = await s.commitCategory(p.confirmation_token, true);
  assert.equal(result.verified, true); assert.equal(result.category.id, 3);
});
