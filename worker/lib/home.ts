/**
 * The home page through the Worker. Cloudflare's static-asset layer applies the `/` rule of _headers and then the
 * `/*` rule again for the file behind it (index.html), so the base policy arrives a second time next to the Talk
 * policy; browsers enforce every Content-Security-Policy they get, which blocks Convai, and every
 * Permissions-Policy, which blocks the microphone. wrangler.jsonc sends `/` here first: the asset is fetched as
 * usual and its two policy headers are replaced by exactly one each, from the same strings tools/headers.ts emits.
 *
 * The build's report-only rollout (REPORT_ONLY=1) is read off the asset itself: when the file carries a
 * Content-Security-Policy-Report-Only header, the base policy stays enforced and the Talk policy is only reported.
 */
import { CSP_PHASE1, CSP_PHASE2_HOME, PERMISSIONS_POLICY_TALK, REPORTING_ENDPOINTS } from '../../tools/policy.ts';

export const HOME_PATHS: ReadonlySet<string> = new Set(['/', '/index.html', '/index']);

export async function home(request: Request, assets: Fetcher): Promise<Response> {
  const response = await assets.fetch(request);
  // Redirects (/index.html -> /) and errors pass through untouched.
  if (response.status !== 200) return response;
  const headers = new Headers(response.headers);
  const reportOnly = headers.has('content-security-policy-report-only');
  headers.set('Content-Security-Policy', reportOnly ? CSP_PHASE1 : CSP_PHASE2_HOME);
  headers.set('Permissions-Policy', PERMISSIONS_POLICY_TALK);
  headers.set('Reporting-Endpoints', REPORTING_ENDPOINTS);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
