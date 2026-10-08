/**
 * POST /api/csp: where browsers send Content-Security-Policy reports (report-uri, application/csp-report) and
 * Reporting API batches (report-to, application/reports+json). A request is reduced to one point, the directive,
 * blocked host and disposition of its first report, before anything reaches Analytics Engine; the document URL,
 * the script sample, the user agent and everything else in it stop here. Once the content type and size pass, the
 * answer is 204 whatever the body said, so a sender learns nothing. The chain reads no body for this route: the
 * caps are applied here.
 */
import type { ApiContext } from '../lib/compose.ts';
import { contentType, fail, noContent } from '../lib/http.ts';
import { writePoint } from '../lib/metrics.ts';

export const MAX_REPORT_BYTES = 16 * 1024;
/**
 * Points one request may write. The route takes headerless posts and a forged Origin passes it, and its points
 * come out of the one Analytics Engine budget every other count shares, so a request costs one point however many
 * reports a Reporting API batch carries: the first violation is counted and the rest are dropped.
 */
const MAX_POINTS = 1;
const TYPES: ReadonlySet<string> = new Set(['application/csp-report', 'application/reports+json']);

export interface Violation {
  directive: string;
  blocked: string;
  disposition: 'enforce' | 'report' | 'unknown';
}

const DIRECTIVE = /^[a-z][a-z-]{0,39}$/;
const KEYWORD = /^[a-z][a-z0-9:.-]{0,79}$/;

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hostOf = (raw: string): string | null => {
  try {
    return new URL(raw).hostname;
  } catch {
    return null;
  }
};

/** "script-src-elem" from either report shape (the directive name alone), or "unknown". */
const directiveOf = (body: Record<string, unknown>): string => {
  const named =
    asString(body['effective-directive']) ||
    asString(body.effectiveDirective) ||
    asString(body['violated-directive']) ||
    asString(body.violatedDirective);
  const [raw = ''] = named.trim().toLowerCase().split(' ');
  return DIRECTIVE.test(raw) ? raw : 'unknown';
};

/** The host of a blocked URL, a keyword such as "inline" or "eval", or "none". Never the full URL. */
const blockedOf = (body: Record<string, unknown>): string => {
  const raw = (asString(body['blocked-uri']) || asString(body.blockedURL)).trim().toLowerCase();
  if (!raw) return 'none';
  const host = hostOf(raw);
  if (host !== null) return host || 'none';
  return KEYWORD.test(raw) ? raw : 'other';
};

const dispositionOf = (body: Record<string, unknown>): Violation['disposition'] => {
  const raw = asString(body.disposition).toLowerCase();
  return raw === 'enforce' || raw === 'report' ? raw : 'unknown';
};

/**
 * The violations in a body of either type, at most MAX_POINTS of them. Anything that does not fit is skipped; an
 * unparsable body is empty.
 */
export function parseReports(text: string, type: string): Violation[] {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return [];
  }
  const bodies: Record<string, unknown>[] = [];
  if (type === 'application/csp-report') {
    if (isRecord(payload) && isRecord(payload['csp-report'])) bodies.push(payload['csp-report']);
  } else if (Array.isArray(payload)) {
    for (const report of payload) {
      if (isRecord(report) && report.type === 'csp-violation' && isRecord(report.body)) bodies.push(report.body);
    }
  }
  return bodies.slice(0, MAX_POINTS).map((body) => ({
    directive: directiveOf(body),
    blocked: blockedOf(body),
    disposition: dispositionOf(body),
  }));
}

export const cspReport = async (c: ApiContext): Promise<Response> => {
  const type = contentType(c.request);
  if (!TYPES.has(type)) return fail(415, 'Send a CSP report.');
  const length = Number(c.request.headers.get('content-length'));
  if (!Number.isFinite(length) || length <= 0) return fail(411, 'That report had no length.');
  if (length > MAX_REPORT_BYTES) return fail(413, 'That report is too large.');

  let text: string;
  try {
    text = await c.request.text();
  } catch {
    return noContent();
  }
  if (text.length > MAX_REPORT_BYTES) return fail(413, 'That report is too large.');

  const [violation] = parseReports(text, type);
  if (!violation) {
    writePoint(c.env, c.route, 'malformed');
    return noContent();
  }
  writePoint(c.env, c.route, `${violation.directive} ${violation.blocked}`, violation.disposition);
  return noContent();
};
