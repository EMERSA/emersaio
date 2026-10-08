import type { ApiContext } from '../lib/compose.ts';
import { json } from '../lib/http.ts';
import { VERSION } from '../lib/version.ts';

/** The edge location that answered, when the platform says so (wrangler dev and the tests do not). */
const colo = (request: Request): string | null => {
  const cf = request.cf;
  return cf !== undefined && 'colo' in cf && typeof cf.colo === 'string' ? cf.colo : null;
};

/** GET /api/health: for the status line on the site and for the smoke test after a deploy. */
export const health = (c: ApiContext): Response =>
  json({ ok: true, version: VERSION, colo: colo(c.request), env: c.env.ENV });
