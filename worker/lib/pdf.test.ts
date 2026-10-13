import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { MAX_INFLATED_STREAM, pdfText } from './pdf.ts';

/** A one-stream PDF whose FlateDecode content stream holds `content`. */
const flatePdf = (content: string | Buffer): Uint8Array => {
  const z = deflateSync(content, { level: 9 });
  const head = Buffer.from(`%PDF-1.4\n1 0 obj << /Length ${z.length} /Filter /FlateDecode >>\nstream\n`, 'latin1');
  const tail = Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1');
  return new Uint8Array(Buffer.concat([head, z, tail]));
};

test('a FlateDecode content stream is inflated and its text read', async () => {
  const text = await pdfText(flatePdf('BT (Hello from a compressed page, with enough words to read.) Tj ET'), 20000);
  assert.equal(text, 'Hello from a compressed page, with enough words to read.');
});

test('a decompression bomb is cut at the inflate cap: the text before it is read, nothing beyond it is inflated', async () => {
  // 64 MB of spaces deflate to under 128 KB; without a cap this expands to 64 MB inside the Worker.
  const bomb = Buffer.alloc(64 * 1024 * 1024, 0x20);
  bomb.write('BT (hello world hello world hello world) Tj ET ', 0);
  const file = flatePdf(bomb);
  assert.ok(file.byteLength < 128 * 1024, `bomb file is ${file.byteLength} bytes`);
  assert.equal(await pdfText(file, 20000), 'hello world hello world hello world');

  // Text placed just past the per-stream cap is never reached, so the file reads as having no text.
  const beyond = Buffer.alloc(MAX_INFLATED_STREAM + 64 * 1024, 0x20);
  beyond.write('BT (text beyond the cap is never inflated or read, however long) Tj ET', MAX_INFLATED_STREAM + 1024);
  assert.equal(await pdfText(flatePdf(beyond), 20000), null);
});

test('a corrupt FlateDecode stream is skipped, not thrown', async () => {
  const head = Buffer.from('%PDF-1.4\n1 0 obj << /Length 12 /Filter /FlateDecode >>\nstream\n', 'latin1');
  const junk = Buffer.from('not deflate!', 'latin1');
  const tail = Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1');
  assert.equal(await pdfText(new Uint8Array(Buffer.concat([head, junk, tail])), 20000), null);
});
