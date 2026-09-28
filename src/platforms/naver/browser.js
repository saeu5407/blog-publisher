import path from 'node:path';
import { readFile, mkdir, chmod, lstat, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

export function parseEndpoint(value) {
  const [port, route] = value.trim().split(/\r?\n/);
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 ||
      !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(route)) throw new Error('NAVER_BROWSER_STATE_INVALID');
  return `ws://127.0.0.1:${port}${route}`;
}

export async function browserEndpoint(profile) {
  try { return parseEndpoint(await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') throw new Error('NAVER_BROWSER_NOT_RUNNING'); throw error; }
}

export async function connectBrowser(profile, { start = false, headless = false } = {}) {
  try {
    return await chromium.connectOverCDP(await browserEndpoint(profile), { timeout: 3000 });
  } catch (error) {
    if (!start) throw new Error('NAVER_BROWSER_NOT_CONNECTED: 기존 전용 브라우저 연결을 확인하세요. 로그인 창은 자동으로 열지 않습니다.');
    // Never start a second process against an already-open/locked profile.
    if (error.message === 'NAVER_BROWSER_STATE_INVALID') throw error;
    try {
      await lstat(path.join(profile, 'SingletonLock'));
      throw new Error('NAVER_BROWSER_RECONNECT_FAILED');
    } catch (lockError) { if (lockError.code !== 'ENOENT') throw lockError; }
    await unlink(path.join(profile, 'DevToolsActivePort')).catch(e => { if (e.code !== 'ENOENT') throw e; });
  }
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await chmod(profile, 0o700);
  const child = spawn(chromium.executablePath(), [
    `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', ...(headless ? ['--headless=new'] : []), 'about:blank',
  ], { detached: true, stdio: 'ignore' });
  let failed = false;
  child.on('error', () => { failed = true; });
  child.unref();
  for (let attempt = 0; attempt < 150; attempt++) {
    if (failed || child.exitCode !== null) break;
    try { return await chromium.connectOverCDP(await browserEndpoint(profile), { timeout: 1000 }); }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  throw new Error('NAVER_BROWSER_START_FAILED');
}
