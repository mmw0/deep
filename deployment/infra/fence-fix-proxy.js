// Fence-fix proxy: makes the dsh web app (on 127.0.0.1:3100) reachable through
// the platform preview domain (any Host header) by rewriting Host -> loopback
// and stripping browser origin markers before the request reaches dsh's
// /api browser-trust fence. Handles plain HTTP and WebSocket upgrades.
//
// ALSO routes /preview/* to the workspace live-preview server (:3111) so
// users can watch agent-written files (HTML etc.) live in the browser.
const http = require('http');
const net = require('net');

const UP_HOST = '127.0.0.1';
const UP_PORT = 3100;
const PREVIEW_PORT = 3111;
const LISTEN_PORT = 3000;

function rewriteHeaders(headers) {
  const h = { ...headers };
  h.host = `${UP_HOST}:${UP_PORT}`;
  // The fence: absent Origin is fine; present Origin must match Host.
  // sec-fetch-site: cross-site is refused outright. Strip both.
  delete h.origin;
  delete h['sec-fetch-site'];
  delete h['sec-fetch-mode'];
  delete h['sec-fetch-dest'];
  delete h.referer;
  return h;
}

const server = http.createServer((req, res) => {
  // Workspace live preview: /preview/* -> preview server (no fence rewriting
  // needed; static files carry no Origin trust requirements).
  if (req.url === '/preview' || req.url.startsWith('/preview/')) {
    const pv = http.request(
      { host: UP_HOST, port: PREVIEW_PORT, method: req.method, path: req.url, headers: req.headers },
      (pvRes) => {
        res.writeHead(pvRes.statusCode, pvRes.headers);
        pvRes.pipe(res);
      },
    );
    pv.on('error', (e) => {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`preview upstream error: ${e.message}`);
    });
    req.pipe(pv);
    return;
  }
  const headers = rewriteHeaders(req.headers);
  const up = http.request(
    { host: UP_HOST, port: UP_PORT, method: req.method, path: req.url, headers },
    (upRes) => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    },
  );
  up.on('error', (e) => {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`fence-fix proxy: upstream error: ${e.message}`);
  });
  req.pipe(up);
});

// WebSocket upgrades: raw TCP pipe with rewritten headers.
server.on('upgrade', (req, socket, head) => {
  const headers = rewriteHeaders(req.headers);
  let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const vv of v) raw += `${k}: ${vv}\r\n`;
    else raw += `${k}: ${v}\r\n`;
  }
  raw += '\r\n';
  const up = net.connect(UP_PORT, UP_HOST, () => {
    up.write(raw);
    if (head && head.length) up.write(head);
    socket.pipe(up);
    up.pipe(socket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`fence-fix proxy listening on 127.0.0.1:${LISTEN_PORT} -> ${UP_HOST}:${UP_PORT}`);
});
