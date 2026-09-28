#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { Tistory } from '../src/platforms/tistory/api.js';
import { Service } from '../src/platforms/tistory/service.js';
import { NaverService } from '../src/platforms/naver/service.js';
import { commands } from '../src/commands.js';
import { lockState, savePlan, claimPlan } from '../src/plans.js';

process.umask(0o077);
const project = fileURLToPath(new URL('../', import.meta.url));
const root = path.resolve(process.env.BLOG_WORKSPACE || path.join(project, 'workspace'));
const state = path.resolve(process.env.BLOG_STATE_DIR || path.join(project, '.state'));
const api = new Tistory(state);
const service = new Service(root, state, api, Number(process.env.BLOG_IMAGE_MAX_WIDTH || 720));
const naver = new NaverService(root, state);
const registry = commands(api, service, naver);
const [command = 'help', input = '{}'] = process.argv.slice(2);
const output = value => process.stdout.write(JSON.stringify(value) + '\n');
let unlock;
try {
  if (command === 'help') {
    output({ usage: 'node scripts/blog.mjs COMMAND JSON_OR_@FILE', commands: [...registry].map(([name, c]) => ({ name, description: c.description })) });
  } else {
    const entry = registry.get(command);
    if (!entry) throw new Error('COMMAND_UNKNOWN');
    const args = entry.schema.parse(JSON.parse(input.startsWith('@') ? await readFile(input.slice(1), 'utf8') : input));
    if (['login', 'naver_login'].includes(command) && !process.stdin.isTTY) throw new Error('LOGIN_TTY_REQUIRED: 터미널 세션(tty=true)에서 실행하세요.');
    unlock = await lockState(state);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const kind = command === 'commit_category' ? 'category' : command.startsWith('naver_') ? 'naver' : 'tistory';
    const owner = kind === 'naver' ? naver : service;
    if (['commit_post', 'commit_category', 'naver_commit_post'].includes(command)) {
      owner.plans.set(args.confirmation_token, await claimPlan(state, args.confirmation_token, kind, root));
    }
    let result = await entry.run(args);
    if (['login', 'naver_login'].includes(command)) {
      output({ status: 'login_window_open', instruction: '브라우저에서 로그인한 뒤 이 터미널에 Enter를 입력하세요. 창은 직접 닫지 마세요.' });
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try { await rl.question('로그인 완료 후 Enter: '); } finally { rl.close(); }
      result = command === 'login' ? await api.status(args.blog) : await naver.finishLogin(args.blog);
    }
    if (result.confirmation_token) {
      const planKind = command === 'create_category' ? 'category' : kind;
      await savePlan(state, result.confirmation_token, { kind: planKind, root, plan: owner.plans.get(result.confirmation_token) });
    }
    output({ ok: true, result });
  }
} catch (error) {
  output({ ok: false, error: error?.issues ? 'INPUT_INVALID: 명령 입력을 확인하세요.' : error.message });
  process.exitCode = 1;
} finally {
  try { await api.close(); await naver.close(); }
  finally { if (unlock) await unlock(); }
}
