#!/usr/bin/env node
/**
 * Workspace Live Preview Server
 * --------------------------------
 * Serves any file under /home/z/sandboxes (and /home/z for legacy paths) so the
 * user can watch what the agent builds — HTML pages, images, anything static —
 * updating live WHILE the agent writes.
 *
 * - Injects a tiny auto-reload script into HTML: the page polls its own
 *   mtime every 1.5s and reloads itself when the file changes on disk.
 * - Directory listings let the user browse workspace files.
 * - Listens on 127.0.0.1:3111; exposed through fence-fix-proxy at
 *   /preview/... so it works on the public preview URL.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3111;
const ROOTS = ['/home/z/sandboxes', '/home/z'];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.csv': 'text/csv',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

const RELOAD_SCRIPT = `
<script>
(function () {
  var m = '${'\\u0024'}{mtime}';
  setInterval(function () {
    fetch(location.pathname.replace(/\\/$/, '') + '?__mtime=' + Date.now(), { method: 'HEAD' })
      .then(function (r) { var t = r.headers.get('X-File-Mtime'); if (m && t && t !== m) location.reload(); })
      .catch(function () {});
  }, 1500);
})();
</script>`;

function safeResolve(root, urlPath) {
  const clean = decodeURIComponent(urlPath).replace(/\.\./g, '').replace(/^\/+/, '');
  const resolved = path.resolve(root, clean);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

function findRoot(urlPath) {
  for (const root of ROOTS) {
    const resolved = safeResolve(root, urlPath);
    if (resolved && fs.existsSync(resolved)) return { root, resolved };
  }
  // Fall back to first root for directory listings of nonexistent-but-parent paths
  const resolved = safeResolve(ROOTS[0], urlPath);
  return resolved ? { root: ROOTS[0], resolved } : null;
}

function dirListing(dir, urlPath, prefix = '') {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => !e.name.startsWith('.'))
    .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : (a.isDirectory() ? -1 : 1)));
  const rows = entries.map(e => {
    const href = `${prefix}${path.posix.join(urlPath, e.name)}` + (e.isDirectory() ? '/' : '');
    const size = e.isDirectory() ? '-' : fs.statSync(path.join(dir, e.name)).size + ' B';
    return `<tr><td><a href="${href}">${e.name}${e.isDirectory() ? '/' : ''}</a></td><td>${size}</td></tr>`;
  }).join('\n');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Index of ${urlPath}</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px}
a{color:#4f8ef7;text-decoration:none}a:hover{text-decoration:underline}
table{border-collapse:collapse;width:100%}td{padding:6px 10px;border-bottom:1px solid #eee}
h1{font-size:1.3rem}</style></head>
<body><h1>📁 Index of ${urlPath}</h1><table>${rows || '<tr><td>(empty)</td></tr>'}</table>
<p style="color:#888;font-size:.85rem;margin-top:24px">Live preview — files refresh automatically as the agent writes them.</p>
</body></html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  // Public prefix under the proxy: /preview/... (empty when hit directly).
  const prefix = (url.pathname.match(/^(\/preview)?\//) || [])[1] || '';
  const urlPath = url.pathname.replace(/^\/preview/, '') || '/';

  if (req.method === 'HEAD' || req.method === 'GET') {
    const found = findRoot(urlPath);
    if (!found || !fs.existsSync(found.resolved)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const stat = fs.statSync(found.resolved);

    if (stat.isDirectory()) {
      // Serve index.html inside directories when present
      const indexFile = path.join(found.resolved, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.writeHead(302, { Location: `${prefix}${path.posix.join(urlPath, 'index.html')}` });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(dirListing(found.resolved, urlPath, prefix));
    }

    const ext = path.extname(found.resolved).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const mtime = String(stat.mtimeMs);

    if (ext === '.html' || ext === '.htm') {
      let content = fs.readFileSync(found.resolved, 'utf8');
      const script = RELOAD_SCRIPT.replace('${mtime}', mtime);
      content = content.replace(/<\/body>/i, script + '</body>') || (content + script);
      res.writeHead(200, {
        'Content-Type': mime,
        'X-File-Mtime': mtime,
        'Cache-Control': 'no-store',
      });
      return res.end(content);
    }

    res.writeHead(200, {
      'Content-Type': mime,
      'X-File-Mtime': mtime,
      'Cache-Control': 'no-store',
      'Content-Length': stat.size,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(found.resolved).pipe(res);
  } else {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[preview] live workspace preview on http://127.0.0.1:${PORT}/ (roots: ${ROOTS.join(', ')})`);
});
