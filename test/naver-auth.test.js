import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NaverService } from '../src/platforms/naver/service.js';

test('authentication failure persists a stop across service instances before engine access', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'naver-auth-'));
  let calls = 0;
  const engine = async () => { calls++; throw new Error('NAVER_AUTH_REQUIRED'); };
  try {
    await assert.rejects(new NaverService(dir, dir, engine).query('status', 'example'), /AUTH_REQUIRED/);
    const next = new NaverService(dir, dir, engine);
    await assert.rejects(next.query('status', 'example'), /AUTH_PAUSED/);
    await assert.rejects(next.login('example'), /AUTH_PAUSED/);
    assert.equal(calls, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('finish login verifies existing editor without engine call or navigation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'naver-auth-'));
  try {
    const service = new NaverService(dir, dir, () => { throw new Error('must not reopen'); });
    await service.pause();
    const visible = () => ({ isVisible: async () => true });
    service.context = { pages: () => [{ frames: () => [{
      url: () => 'https://blog.naver.com/PostWriteForm.naver?blogId=example',
      locator: visible, getByRole: visible,
    }] }] };
    assert.equal((await service.finishLogin('example')).editor_accessible, true);
    await service.checkPaused();
    await assert.rejects(service.finishLogin('other'), /AUTH_PAUSED/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
