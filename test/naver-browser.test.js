import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { connectBrowser, browserEndpoint, parseEndpoint } from '../src/platforms/naver/browser.js';

test('browser discovery only accepts loopback browser endpoints', () => {
  assert.equal(parseEndpoint('1234\n/devtools/browser/abc-123\n'), 'ws://127.0.0.1:1234/devtools/browser/abc-123');
  for (const value of ['0\n/devtools/browser/a', '65536\n/devtools/browser/a', '1234\nhttps://evil.test', '1234\n/devtools/page/a']) {
    assert.throws(() => parseEndpoint(value));
  }
});

test('missing browser does not automatically launch one', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'naver-no-browser-'));
  try { await assert.rejects(connectBrowser(dir), /NOT_CONNECTED/); }
  finally { await rm(dir, { recursive: true, force: true }); }
});

test('Node and Python reconnect to the same live tab without account access', { skip: !process.env.BLOG_BROWSER_TEST }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'naver-live-browser-'));
  let browser;
  try {
    browser = await connectBrowser(dir, { start: true, headless: true });
    const page = await browser.contexts()[0].newPage();
    await page.goto('data:text/html,<title>retained-tab</title>');
    const cdp = await browser.newBrowserCDPSession();
    const before = (await cdp.send('Target.getTargets')).targetInfos.find(t => t.title === 'retained-tab').targetId;
    await browser.close();
    browser = null;
    const result = await promisify(execFile)('uv', ['run', '--frozen', '--offline', '--directory', 'engines/naver', 'python', '-c',
      'import asyncio\nfrom naver_blog_mcp.session import Session\nasync def main():\n async with Session() as ctx:\n  assert any([await p.title() == "retained-tab" for p in ctx.pages])\n  print("same-tab")\nasyncio.run(main())'],
      { env: { ...process.env, NAVER_CDP: await browserEndpoint(dir) }, timeout: 20000 });
    assert.match(result.stdout, /same-tab/);
    browser = await connectBrowser(dir);
    const after = await browser.newBrowserCDPSession();
    assert.equal((await after.send('Target.getTargets')).targetInfos.find(t => t.title === 'retained-tab').targetId, before);
  } finally {
    if (!browser) browser = await connectBrowser(dir).catch(() => null);
    if (browser) {
      const cdp = await browser.newBrowserCDPSession();
      await cdp.send('Browser.close').catch(() => {});
      await browser.close();
    }
    await rm(dir, { recursive: true, force: true });
  }
});
