import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { discover, localAddresses } from './lib/discovery.mjs';
import { isPrivateIPv4 } from './lib/tv.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
]);

for (const icon of ['netflix', 'primevideo', 'disneyplus', 'appletv', 'youtube']) {
  const file = `icons/${icon}.svg`;
  files.set('/' + file, [file, 'image/svg+xml']);
}

export function createServer(remote, { lanIP } = {}) {
  if (lanIP && !isPrivateIPv4(lanIP)) throw new Error('Expected a private LAN IPv4 address.');
  let searching;
  const csrf = randomBytes(32).toString('hex');
  const json = (res, code, value) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const port = server.address()?.port;
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (lanIP) allowedHosts.push(`${lanIP}:${port}`);
    if (!allowedHosts.includes(req.headers.host)) return json(res, 403, { error: 'Use the local app address.' });
    if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Cross-site access is disabled.' });
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(res, 403, { error: 'Use the app’s own page.' });
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { return json(res, 400, { error: 'Invalid request.' }); }
    try {
      if (req.method === 'GET' && pathname === '/api/status') return json(res, 200, { ...remote.status(), csrf, computerIPs: localAddresses() });
      if (req.method === 'GET' && files.has(pathname)) {
        const [file, type] = files.get(pathname);
        res.writeHead(200, { 'Content-Type': type });
        return res.end(await readFile(join(root, 'public', file)));
      }
      if (req.method !== 'POST' || !pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found.' });
      const provided = Buffer.from(req.headers['x-remote-token'] || '');
      const expected = Buffer.from(csrf);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return json(res, 403, { error: 'Reload the remote page and try again.' });
      if (req.headers['content-type'] !== 'application/json') return json(res, 415, { error: 'Expected JSON.' });
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 1024) return json(res, 413, { error: 'Request too large.' });
      }
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { return json(res, 400, { error: 'Invalid JSON.' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'Expected a JSON object.' });
      if (pathname === '/api/connect') return json(res, 200, await remote.connect());
      if (pathname === '/api/check') return json(res, 200, await remote.check());
      if (pathname === '/api/launch') return json(res, 200, await remote.launch(body.app));
      if (pathname === '/api/key') return json(res, 200, await remote.send(body.key));
      if (pathname === '/api/discover') {
        searching ??= discover(lanIP ? [lanIP] : localAddresses()).finally(() => { searching = null; });
        return json(res, 200, { devices: await searching });
      }
      if (pathname === '/api/settings') return json(res, 200, await remote.setHost(body.host));
      return json(res, 404, { error: 'Not found.' });
    } catch (error) {
      // Only these application messages reach the browser, never a WebSocket URL/token.
      json(res, 400, { error: error.code ? 'Local settings could not be saved.' : error.message });
    }
  });
  server.requestTimeout = 60000;
  return server;
}
