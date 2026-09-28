import { z } from 'zod';
import { registerTistoryTools } from './platforms/tistory/tools.js';
import { registerNaverTools } from './platforms/naver/tools.js';

export function commands(api, service, naver) {
  const registry = new Map();
  const register = (name, description, shape, run) => registry.set(name, { description, schema: z.object(shape).strict(), run });
  registerTistoryTools(register, { api, service });
  registerNaverTools(register, naver);
  return registry;
}
