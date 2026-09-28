import test from 'node:test';
import assert from 'node:assert/strict';
import { Tistory } from '../src/platforms/tistory/api.js';

function adapter(response) {
  const calls = []; const api = new Tistory('/unused');
  api.context = { request: { fetch: async (...args) => { calls.push(args); return response; } } };
  return { api, calls };
}
const response = data => ({ status: () => 200, ok: () => true, json: async () => data });
test('categories retain hierarchy and numeric IDs', async () => {
  const { api } = adapter(response({ rootLabel: '전체', categories: [{ id: '1', name: '이론', children: [{ id: '2', name: 'LLM', children: [] }] }] }));
  const result = await api.categories('https://x.tistory.com');
  assert.equal(result.items[2].path, '이론 / LLM'); assert.equal(result.items[2].parent_id, 1);
});
test('update uses PUT with ID path; create uses POST', async () => {
  const { api, calls } = adapter(response({ entryUrl: 'https://x.tistory.com/12' }));
  await api.save('https://x.tistory.com', '12', { title: 'a' });
  assert.equal(calls[0][0], 'https://x.tistory.com/manage/post/12.json'); assert.equal(calls[0][1].method, 'PUT');
  await api.save('https://x.tistory.com', null, { title: 'b' }); assert.equal(calls[1][1].method, 'POST');
  assert.equal(calls[0][1].maxRedirects, 0);
});
test('login redirects do not get followed; auth response is redacted', async () => {
  const { api } = adapter({ status: () => 302 }); await assert.rejects(api.list('https://x.tistory.com'), /SESSION_OR_CHALLENGE/);
});
test('list results exclude passwords and session-bearing metadata', async () => {
  const { api } = adapter(response({ items: [{ id: '12', title: 'a', postPassword: 'secret', visibility: 'PRIVATE' }] }));
  const result = await api.list('https://x.tistory.com'); assert.equal(result.items[0].id, '12'); assert.ok(!JSON.stringify(result).includes('secret'));
});
