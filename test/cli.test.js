import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { lockState, savePlan, claimPlan } from '../src/plans.js';
import { Service } from '../src/platforms/tistory/service.js';

const script = fileURLToPath(new URL('../scripts/blog.mjs', import.meta.url));
async function fixture() { const root = await mkdtemp(path.join(os.tmpdir(), 'blog-skill-test-')); return { root, state: path.join(root, '.state') }; }
function cli(f, command, args) {
  const p = spawnSync(process.execPath, [script, command, JSON.stringify(args)], { encoding: 'utf8', env: { ...process.env, BLOG_WORKSPACE: f.root, BLOG_STATE_DIR: f.state } });
  return { status: p.status, data: JSON.parse(p.stdout.trim()) };
}
test('CLI prepares a durable plan without an MCP server or remote access', async () => {
  const f = await fixture();
  const made = cli(f, 'create_markdown', { blog: 'https://example.tistory.com', title: 'Example', markdown: '```txt\nhello\n```' });
  assert.equal(made.status, 0);
  const p = cli(f, 'upload_post', { markdown_file: made.data.result.markdown_file });
  assert.equal(p.status, 0); assert.equal(p.data.result.visibility, 'private');
  const token = p.data.result.confirmation_token;
  const file = path.join(f.state, 'plans', token + '.json');
  const envelope = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(envelope.plan.body.title, 'Example');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(cli(f, 'commit_post', { confirmation_token: token, confirm: false }).status, 1);
  assert.ok(await readFile(file));
  const plan = await claimPlan(f.state, token, 'tistory', f.root);
  await writeFile(plan.file, 'changed');
  const api = { categories: async () => ({ items: [{ id: 0, visibility: 20 }] }) };
  const service = new Service(f.root, f.state, api); service.plans.set(token, plan);
  await assert.rejects(service.commit(token, true), /LOCAL_FILE_CHANGED/);
  await assert.rejects(claimPlan(f.state, token, 'tistory', f.root), /PLAN_UNAVAILABLE/);
});
test('durable plans enforce scope, expiry and one-time claim', async () => {
  const f = await fixture(), token = randomUUID();
  await savePlan(f.state, token, { kind: 'naver', root: f.root, plan: { time: Date.now() } });
  await assert.rejects(claimPlan(f.state, token, 'tistory', f.root), /SCOPE/);
  await assert.rejects(claimPlan(f.state, token, 'naver', '/elsewhere'), /SCOPE/);
  const outcomes = await Promise.allSettled([claimPlan(f.state, token, 'naver', f.root), claimPlan(f.state, token, 'naver', f.root)]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  const expired = randomUUID();
  await savePlan(f.state, expired, { kind: 'tistory', root: f.root, plan: { time: 0 } });
  await assert.rejects(claimPlan(f.state, expired, 'tistory', f.root), /EXPIRED/);
  await assert.rejects(claimPlan(f.state, '../escape', 'tistory', f.root), /TOKEN_INVALID/);
});
test('state lock blocks concurrent CLI processes and releases explicitly', async () => {
  const f = await fixture(); const unlock = await lockState(f.state);
  const r = cli(f, 'create_markdown', { blog: 'https://example.tistory.com', title: 'x', markdown: 'x' });
  assert.equal(r.status, 1); assert.match(r.data.error, /BUSY/);
  await unlock(); const again = await lockState(f.state); await again();
});
test('login requires a persistent terminal and malformed input fails closed', async () => {
  const f = await fixture();
  assert.match(cli(f, 'login', { blog: 'https://example.tistory.com' }).data.error, /TTY/);
  assert.equal(cli(f, 'upload_post', { markdown_file: 'x', visibility: 'typo' }).status, 1);
  assert.equal(cli(f, 'unknown', {}).status, 1);
});
