'use strict';
/*
 * Little Honey Treats books: a tiny self-hosted server.
 * No npm dependencies. Needs Node 22.13 or newer (uses the built-in node:sqlite).
 *
 *   GET  /                    the app (public/index.html)
 *   GET  /api/c/:coll         list every record in a collection
 *   PUT  /api/c/:coll/:id     create or replace a record
 *   DELETE /api/c/:coll/:id   delete a record
 *   GET  /api/events          live change stream (server-sent events) so other devices stay in sync
 *   PUT  /api/blob            upload a receipt (raw body), returns { id }
 *   GET  /_blob/:id           fetch a receipt
 *   GET  /healthz             liveness check (no login needed)
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PASSWORD = process.env.APP_PASSWORD || '';
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP) || 14;
const PUBLIC_DIR = path.join(__dirname, 'public');

const COLLS = new Set(['customers', 'products', 'ingredients', 'recipes', 'docs', 'expenses', 'time', 'stocktakes', 'balances', 'settings']);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const BLOB_ID_RE = /^[a-f0-9]{32}$/;
const MAX_DOC_BYTES = 1_000_000;
const MAX_BLOB_BYTES = 15 * 1024 * 1024;
const SESSION_MS = 30 * 24 * 3600 * 1000;

fs.mkdirSync(path.join(DATA_DIR, 'blobs'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'backups'), { recursive: true });

/* ---------- database ---------- */
const db = new DatabaseSync(path.join(DATA_DIR, 'books.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS records (
    coll TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL,
    PRIMARY KEY (coll, id)
  );
  CREATE TABLE IF NOT EXISTS blobs (
    id TEXT PRIMARY KEY, name TEXT, type TEXT, size INTEGER, created INTEGER NOT NULL
  );
`);
const qList = db.prepare('SELECT id, data FROM records WHERE coll = ?');
const qUpsert = db.prepare(`INSERT INTO records (coll, id, data, updated) VALUES (?, ?, ?, ?)
  ON CONFLICT (coll, id) DO UPDATE SET data = excluded.data, updated = excluded.updated`);
const qDelete = db.prepare('DELETE FROM records WHERE coll = ? AND id = ?');
const qBlobGet = db.prepare('SELECT id, name, type, size FROM blobs WHERE id = ?');
const qBlobPut = db.prepare('INSERT INTO blobs (id, name, type, size, created) VALUES (?, ?, ?, ?, ?)');

/* ---------- nightly snapshot of the database ---------- */
function dayStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function snapshot() {
  try {
    const dir = path.join(DATA_DIR, 'backups');
    const file = path.join(dir, `books-${dayStamp()}.db`);
    if (!fs.existsSync(file)) {
      db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      console.log('Database snapshot written:', path.basename(file));
    }
    const all = fs.readdirSync(dir).filter((f) => /^books-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    all.slice(0, Math.max(0, all.length - BACKUP_KEEP)).forEach((f) => fs.unlinkSync(path.join(dir, f)));
  } catch (e) {
    console.error('Snapshot failed:', e.message);
  }
}
snapshot();
setInterval(snapshot, 6 * 3600 * 1000).unref();

/* ---------- login ---------- */
const secretFile = path.join(DATA_DIR, '.session-secret');
let SECRET;
try { SECRET = fs.readFileSync(secretFile); } catch {
  SECRET = crypto.randomBytes(32);
  fs.writeFileSync(secretFile, SECRET, { mode: 0o600 });
}
const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function makeToken() { const exp = String(Date.now() + SESSION_MS); return exp + '.' + sign(exp); }
function validToken(t) {
  if (!t) return false;
  const [exp, mac] = String(t).split('.');
  if (!exp || !mac || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  return safeEqual(mac, sign(exp));
}
function cookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
const authed = (req) => !PASSWORD || validToken(cookies(req).lht_session);
const fails = new Map(); // ip -> { n, first }
function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}
function locked(ip) {
  const f = fails.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > 15 * 60 * 1000) { fails.delete(ip); return false; }
  return f.n >= 10;
}
const loginPage = (msg) => `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Little Honey Treats</title>
<style>
:root{--ink:#17140A;--honey:#FFC933;--paper:#FBF8EC;--line:#E7E0C6}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--paper);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
form{width:min(100%,360px);background:#fff;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.band{background:var(--ink);color:var(--honey);padding:18px 20px 22px;font-weight:800;font-size:22px;position:relative}
.band::after{content:"";position:absolute;left:0;right:0;bottom:0;height:6px;background:repeating-linear-gradient(135deg,#FFC933 0 9px,#17140A 9px 18px)}
.body{padding:20px;display:flex;flex-direction:column;gap:12px}
label{font-size:12.5px;font-weight:600;color:#6A6249}
input{width:100%;padding:10px;border:1px solid var(--line);border-radius:6px;font:inherit}
button{padding:10px 14px;border:0;border-radius:6px;background:var(--ink);color:var(--honey);font:inherit;font-weight:600;cursor:pointer}
.err{color:#C2271D;font-size:13.5px}
</style></head><body>
<form method="post" action="/login"><div class="band">Little Honey Treats</div><div class="body">
${msg ? `<div class="err" role="alert">${msg}</div>` : ''}
<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" autofocus required>
<button type="submit">Sign in</button></div></form></body></html>`;

/* ---------- helpers ---------- */
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};
const PAGE_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SEC_HEADERS, ...headers });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function sameOrigin(req) {
  // State-changing calls must carry our custom header (forces a CORS preflight, which we never grant)
  // and, when the browser sends an Origin, it must match the host being used.
  if (req.headers['x-requested-with'] !== 'books') return false;
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

/* ---------- live updates ---------- */
const clients = new Set();
function broadcast(evt) {
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of clients) res.write(line);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

/* ---------- blobs ---------- */
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);
function serveBlob(res, id) {
  const meta = BLOB_ID_RE.test(id) ? qBlobGet.get(id) : null;
  const file = path.join(DATA_DIR, 'blobs', id);
  if (!meta || !fs.existsSync(file)) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  const inline = INLINE_TYPES.has(meta.type);
  const name = String(meta.name || 'receipt').replace(/[\r\n"]/g, '_');
  res.writeHead(200, {
    ...SEC_HEADERS,
    'Content-Type': inline ? meta.type : 'application/octet-stream',
    'Content-Length': meta.size,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Content-Security-Policy': 'sandbox',
    'Cache-Control': 'private, max-age=86400',
  });
  fs.createReadStream(file).pipe(res);
}

/* ---------- routing ---------- */
const indexHtml = () => fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'));
const shimJs = () => fs.readFileSync(path.join(PUBLIC_DIR, 'shim.js'));

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const m = req.method;

  if (p === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });

  if (p === '/login') {
    if (!PASSWORD) return send(res, 302, '', { Location: '/' });
    if (m === 'GET') return send(res, 200, loginPage(''), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    if (m === 'POST') {
      const ip = clientIp(req);
      if (locked(ip)) return send(res, 429, loginPage('Too many attempts. Try again in 15 minutes.'), { 'Content-Type': 'text/html; charset=utf-8' });
      const body = (await readBody(req, 10_000)).toString('utf8');
      const given = new URLSearchParams(body).get('password') || '';
      if (safeEqual(given, PASSWORD)) {
        fails.delete(ip);
        const cookie = `lht_session=${encodeURIComponent(makeToken())}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${COOKIE_SECURE ? '; Secure' : ''}`;
        return send(res, 302, '', { Location: '/', 'Set-Cookie': cookie });
      }
      const f = fails.get(ip) || { n: 0, first: Date.now() };
      f.n += 1; fails.set(ip, f);
      return send(res, 401, loginPage('That password is not right.'), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    }
    return send(res, 405, 'Method not allowed', { 'Content-Type': 'text/plain' });
  }
  if (p === '/logout' && m === 'POST') {
    return send(res, 302, '', { Location: '/login', 'Set-Cookie': 'lht_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
  }

  if (!authed(req)) {
    if (p.startsWith('/api/') || p.startsWith('/_blob/')) return json(res, 401, { error: 'login required' });
    return send(res, 302, '', { Location: '/login' });
  }

  if (m === 'GET' && (p === '/' || p === '/index.html')) {
    return send(res, 200, indexHtml(), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Security-Policy': PAGE_CSP });
  }
  if (m === 'GET' && p === '/shim.js') {
    return send(res, 200, shimJs(), { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
  }
  if (m === 'GET' && p.startsWith('/_blob/')) return serveBlob(res, p.slice(7));

  if (m === 'GET' && p === '/api/events') {
    res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  let mm = p.match(/^\/api\/c\/([a-z]+)$/);
  if (mm && m === 'GET') {
    if (!COLLS.has(mm[1])) return json(res, 404, { error: 'unknown collection' });
    return json(res, 200, qList.all(mm[1]).map((r) => ({ id: r.id, data: JSON.parse(r.data) })));
  }

  mm = p.match(/^\/api\/c\/([a-z]+)\/([A-Za-z0-9_-]+)$/);
  if (mm && (m === 'PUT' || m === 'DELETE')) {
    const [, coll, id] = mm;
    if (!COLLS.has(coll) || !ID_RE.test(id)) return json(res, 404, { error: 'unknown collection or bad id' });
    if (!sameOrigin(req)) return json(res, 403, { error: 'blocked' });
    if (m === 'DELETE') {
      qDelete.run(coll, id);
      broadcast({ coll, id, deleted: true });
      return json(res, 200, { ok: true });
    }
    const raw = await readBody(req, MAX_DOC_BYTES);
    let data;
    try { data = JSON.parse(raw.toString('utf8')); } catch { return json(res, 400, { error: 'bad json' }); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return json(res, 400, { error: 'expected an object' });
    qUpsert.run(coll, id, JSON.stringify(data), Date.now());
    broadcast({ coll, id, data });
    return json(res, 200, { ok: true });
  }

  if (p === '/api/blob' && m === 'PUT') {
    if (!sameOrigin(req)) return json(res, 403, { error: 'blocked' });
    const body = await readBody(req, MAX_BLOB_BYTES);
    if (!body.length) return json(res, 400, { error: 'empty file' });
    let id = url.searchParams.get('id') || crypto.randomBytes(16).toString('hex');
    if (!BLOB_ID_RE.test(id)) return json(res, 400, { error: 'bad id' });
    if (qBlobGet.get(id)) return json(res, 409, { error: 'id already exists' });
    let name = 'receipt';
    try { name = decodeURIComponent(req.headers['x-filename'] || 'receipt').slice(0, 200); } catch { /* keep default */ }
    const type = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim().toLowerCase();
    fs.writeFileSync(path.join(DATA_DIR, 'blobs', id), body, { flag: 'wx' });
    qBlobPut.run(id, name, type, body.length, Date.now());
    return json(res, 200, { id, url: '/_blob/' + id });
  }

  return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (res.headersSent) return res.end();
    json(res, e.status || 500, { error: e.status ? e.message : 'server error' });
    if (!e.status) console.error(e);
  });
});
server.listen(PORT, () => {
  console.log(`Little Honey Treats books on http://0.0.0.0:${PORT}  (data: ${DATA_DIR})`);
  if (!PASSWORD) console.warn('WARNING: APP_PASSWORD is not set. Anyone who can reach this port can read and change the books.');
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); db.close(); process.exit(0); });
