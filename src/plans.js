import path from 'node:path';
import { mkdir, readFile, rename, rmdir, writeFile } from 'node:fs/promises';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function lockState(state) {
  await mkdir(state, { recursive: true, mode: 0o700 });
  const lock = path.join(state, 'cli.lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('BUSY: cli.lock이 있습니다. 실행 중인 프로세스를 먼저 확인하세요.'); throw e; }
  return () => rmdir(lock);
}
export async function savePlan(state, token, envelope) {
  if (!uuid.test(token)) throw new Error('TOKEN_INVALID');
  const directory = path.join(state, 'plans');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, token + '.json'), JSON.stringify(envelope), { flag: 'wx', mode: 0o600 });
}
export async function claimPlan(state, token, kind, root) {
  if (!uuid.test(token)) throw new Error('TOKEN_INVALID');
  const file = path.join(state, 'plans', token + '.json');
  let envelope;
  try { envelope = JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') throw new Error('PLAN_UNAVAILABLE: 없거나 이미 사용한 토큰입니다. 저장 결과를 먼저 확인하세요.'); throw e; }
  if (envelope.kind !== kind || envelope.root !== root) throw new Error('PLAN_SCOPE_MISMATCH');
  if (!Number.isFinite(envelope.plan?.time) || Date.now() - envelope.plan.time > 600000) throw new Error('PLAN_EXPIRED');
  // Claim before any remote write; a crash never makes the token reusable.
  await rename(file, file + '.consumed');
  return envelope.plan;
}
