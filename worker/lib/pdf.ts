/**
 * Plain text from a common text PDF, in pure JS: every content stream (inflated when FlateDecode), then the strings
 * shown by Tj, TJ, ' and " between BT and ET. Fonts with custom encodings (most CID fonts) give unreadable bytes;
 * those are caught by the readability check and the caller answers 422. Scans, encryption and object streams that
 * hide content are not supported. The file is never stored.
 */
const latin1 = new TextDecoder('latin1');

async function inflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/** The streams of the file with their dictionaries, inflated where needed. */
async function streams(pdf: string, bytes: Uint8Array): Promise<string[]> {
  const out: string[] = [];
  const re = /<<((?:[^<>]|<<(?:[^<>]|<<[^<>]*>>)*>>|<[^<>]*>)*)>>\s*stream\r?\n/g;
  for (let m = re.exec(pdf); m; m = re.exec(pdf)) {
    const start = m.index + m[0].length;
    let end = pdf.indexOf('endstream', start);
    if (end < 0) break;
    // The end-of-line before endstream belongs to the syntax, not the data (LF, or CR LF).
    if (pdf.charCodeAt(end - 1) === 10) end -= 1;
    if (pdf.charCodeAt(end - 1) === 13) end -= 1;
    const dict = m[1] ?? '';
    if (/\/Type\s*\/(?:XObject|XRef|Metadata|EmbeddedFile)/.test(dict) || /\/Subtype\s*\/Image/.test(dict)) continue;
    if (/\/Length1|\/FontFile/.test(dict)) continue;
    const raw = bytes.subarray(start, end);
    if (/\/FlateDecode/.test(dict)) {
      const inflated = await inflate(raw);
      if (inflated) out.push(latin1.decode(inflated));
    } else if (!/\/Filter/.test(dict)) {
      out.push(latin1.decode(raw));
    }
  }
  return out;
}

const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };

/** A literal string starting just after "(" at `i`; returns the text and the index after the closing ")". */
function literal(s: string, i: number): [string, number] {
  let depth = 1;
  let text = '';
  while (i < s.length) {
    const ch = s[i] ?? '';
    if (ch === '\\') {
      const next = s[i + 1] ?? '';
      if (/[0-7]/.test(next)) {
        const oct = /^[0-7]{1,3}/.exec(s.slice(i + 1, i + 4))?.[0] ?? '0';
        text += String.fromCharCode(Number.parseInt(oct, 8));
        i += 1 + oct.length;
        continue;
      }
      if (next === '\r' || next === '\n') {
        i += next === '\r' && s[i + 2] === '\n' ? 3 : 2;
        continue;
      }
      text += ESCAPES[next] ?? next;
      i += 2;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return [text, i + 1];
    }
    text += ch;
    i += 1;
  }
  return [text, i];
}

function hex(s: string): string {
  const digits = s.replace(/[^0-9a-f]/gi, '');
  let text = '';
  for (let i = 0; i < digits.length; i += 2)
    text += String.fromCharCode(Number.parseInt(digits.slice(i, i + 2).padEnd(2, '0'), 16));
  return text;
}

/** The shown text of one content stream. */
export function contentText(s: string): string {
  let out = '';
  let pending: string[] = [];
  let inText = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i] ?? '';
    if (ch === '(') {
      const [text, next] = literal(s, i + 1);
      if (inText) pending.push(text);
      i = next;
      continue;
    }
    if (ch === '<' && s[i + 1] !== '<') {
      const end = s.indexOf('>', i);
      if (end < 0) break;
      if (inText) pending.push(hex(s.slice(i + 1, end)));
      i = end + 1;
      continue;
    }
    if (ch === '%') {
      const end = s.indexOf('\n', i);
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    const op = /^[A-Za-z'"*]+/.exec(s.slice(i, i + 3))?.[0];
    if (op) {
      if (op === 'BT') inText = true;
      else if (op === 'ET') {
        inText = false;
        out += '\n';
      } else if (op === 'Tj' || op === 'TJ') out += pending.join('');
      else if (op === "'" || op === '"') out += `\n${pending.join('')}`;
      else if (op === 'Td' || op === 'TD' || op === 'T*') out += '\n';
      pending = [];
      i += op.length;
      continue;
    }
    i += 1;
  }
  return out;
}

/** Readable text is mostly letters, digits, spaces and punctuation. */
const readable = (text: string): boolean => {
  const sample = text.slice(0, 4000);
  if (sample.replace(/\s/g, '').length < 20) return false;
  const good = sample.match(/[\p{L}\p{N}\s.,;:!?'"()\-–—/&%@]/gu)?.length ?? 0;
  return good / sample.length > 0.85;
};

/** The text of a PDF, collapsed and cut at `maxChars`, or null when it cannot be read. */
export async function pdfText(bytes: Uint8Array, maxChars: number): Promise<string | null> {
  const pdf = latin1.decode(bytes);
  if (!pdf.startsWith('%PDF-')) return null;
  if (/\/Encrypt\s/.test(pdf)) return null;
  let text = '';
  for (const s of await streams(pdf, bytes)) {
    if (!/\bBT\b/.test(s)) continue;
    text += contentText(s);
    if (text.length > maxChars * 2) break;
  }
  const collapsed = text
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return readable(collapsed) ? collapsed.slice(0, maxChars) : null;
}
