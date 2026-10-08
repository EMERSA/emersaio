/**
 * Serves a built site the way Cloudflare's static assets do, close enough for the browser checks and Lighthouse:
 * "/docs" -> docs.html, "/docs/" -> 307 "/docs", unknown -> 404.html with a 404 status, the headers of
 * dist/_headers applied through the same simulator the build uses, so the Content-Security-Policy is enforced
 * in the browser tests, and text compressed at the edge (Brotli for browsers that accept it, else gzip), so the
 * transfer sizes Lighthouse measures are the ones a visitor pays. Two Worker routes are stubbed so pages that
 * poll them do not log 404s.
 *
 *   node tests/browser/static-serve.mjs <dist> [port]         (port 0 picks a free one)
 * or import { startStaticServer } from './static-serve.mjs'.
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { applyRules, parseHeaders } from '../../tools/headers.ts';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.glb': 'model/gltf-binary',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

/** The text types Cloudflare compresses at the edge; fonts, images, audio and binaries go out as they are. */
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.mjs', '.json', '.xml', '.txt', '.svg', '.webmanifest']);

/** What the Worker would answer for the routes a page may call on load; everything else under /api/ is a JSON 404. */
const API_STUBS = {
  '/api/health': { ok: true, colo: 'LOCAL', env: 'static-serve' },
};
const API_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
};

/** Brotli when the client accepts it (every current browser), else gzip, else nothing. */
function pickEncoding(req) {
  const accept = String(req.headers['accept-encoding'] ?? '');
  if (/(^|[\s,])br($|[\s,;])/.test(accept)) return 'br';
  if (/(^|[\s,])gzip($|[\s,;])/.test(accept)) return 'gzip';
  return null;
}

export function startStaticServer({ dist, port = 0, host = '127.0.0.1' }) {
  const base = resolve(dist);
  const headersFile = join(base, '_headers');
  const rules = existsSync(headersFile) ? parseHeaders(readFileSync(headersFile, 'utf8')) : [];
  const notFoundPage = join(base, '404.html');
  /** Compressed bodies by file, modification time and encoding, so three Lighthouse runs compress each file once. */
  const compressed = new Map();

  const encode = (file, encoding) => {
    const key = `${file}\0${statSync(file).mtimeMs}\0${encoding}`;
    let body = compressed.get(key);
    if (!body) {
      const raw = readFileSync(file);
      body =
        encoding === 'br'
          ? brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } })
          : gzipSync(raw, { level: 9 });
      compressed.set(key, body);
    }
    return body;
  };

  /** Writes the response: a body buffer or string, a streamed file, or headers only (HEAD and redirects). */
  const send = (res, status, headers, { body, file } = {}) => {
    res.writeHead(status, headers);
    if (body !== undefined) return res.end(body);
    if (file) return createReadStream(file).pipe(res);
    return res.end();
  };

  const server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { allow: 'GET, HEAD' });
    let url;
    let pathname;
    try {
      url = new URL(req.url ?? '/', `http://${host}`);
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return send(res, 400, { 'content-type': 'text/plain' }, { body: 'bad request' });
    }

    const head = req.method === 'HEAD';
    if (pathname.startsWith('/api/')) {
      const stub = API_STUBS[pathname];
      const body = JSON.stringify(stub ?? { error: 'Not found' });
      return send(res, stub ? 200 : 404, API_HEADERS, head ? {} : { body });
    }

    // Cloudflare never serves its own configuration file.
    if (pathname === '/_headers' || pathname === '/_redirects' || pathname.includes('\0')) return notFound();

    // drop-trailing-slash, as wrangler.jsonc configures it.
    if (pathname.length > 1 && pathname.endsWith('/')) {
      return send(res, 307, { location: pathname.replace(/\/+$/, '') + url.search });
    }
    if (pathname.endsWith('.html')) {
      const clean = pathname === '/index.html' ? '/' : pathname.replace(/(\/index)?\.html$/, '');
      return send(res, 307, { location: clean + url.search });
    }

    const candidates =
      pathname === '/'
        ? ['index.html']
        : [pathname.slice(1), `${pathname.slice(1)}.html`, join(pathname.slice(1), 'index.html')];
    for (const candidate of candidates) {
      const file = resolve(base, candidate);
      // The resolved file must stay inside dist, whatever the path looked like.
      if (file !== base && !file.startsWith(base + sep)) continue;
      if (!existsSync(file) || !statSync(file).isFile()) continue;
      return sendFile(200, file);
    }
    return notFound();

    /** The file with its _headers, compressed when it is text and the client accepts it; HEAD gets the same headers. */
    function sendFile(status, file) {
      const headers = {
        'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-length': statSync(file).size,
      };
      let body;
      if (COMPRESSIBLE.has(extname(file).toLowerCase())) {
        headers.vary = 'accept-encoding';
        const encoding = pickEncoding(req);
        if (encoding) {
          body = encode(file, encoding);
          headers['content-encoding'] = encoding;
          headers['content-length'] = body.length;
        }
      }
      for (const [name, value] of Object.entries(applyRules(rules, pathname).headers)) {
        headers[name.toLowerCase()] = value;
      }
      if (head) return send(res, status, headers);
      return send(res, status, headers, body ? { body } : { file });
    }

    function notFound() {
      if (existsSync(notFoundPage)) return sendFile(404, notFoundPage);
      return send(res, 404, { 'content-type': 'text/plain' }, { body: 'not found' });
    }
  });

  return new Promise((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolveServer({
        port: actual,
        url: `http://${host}:${actual}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const entry = process.argv[1];
if (entry && pathToFileURL(resolve(entry)).href === import.meta.url) {
  const [dir, port] = process.argv.slice(2);
  if (!dir) {
    console.error('usage: node tests/browser/static-serve.mjs <dist> [port]');
    process.exit(2);
  }
  const { url } = await startStaticServer({ dist: dir, port: Number(port ?? 0) });
  console.log(`serving ${resolve(dir)} on ${url}`);
}
