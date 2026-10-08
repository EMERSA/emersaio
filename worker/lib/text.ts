/**
 * Visitor text on its way to an email, a log line or a JSON reply: control characters out, length bounded.
 * Header injection is impossible over a JSON mail API, but a stray control character is still noise in an inbox.
 */
const isControl = (code: number): boolean => code < 0x20 || code === 0x7f;

/** One line: every control character becomes a space, then trimmed and cut at `max` UTF-16 units. */
export function oneLine(value: string | undefined, max = Number.POSITIVE_INFINITY): string {
  if (!value) return '';
  let out = '';
  for (const ch of value) out += isControl(ch.codePointAt(0) ?? 0) ? ' ' : ch;
  return out.trim().slice(0, max);
}

/** Several lines: newlines survive (CRLF folded to LF); other control characters become spaces. */
export function multiLine(value: string | undefined, max = Number.POSITIVE_INFINITY): string {
  if (!value) return '';
  let out = '';
  for (const ch of value.replace(/\r\n?/g, '\n')) out += ch === '\n' || !isControl(ch.codePointAt(0) ?? 0) ? ch : ' ';
  return out.trim().slice(0, max);
}
