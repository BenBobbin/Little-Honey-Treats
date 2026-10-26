'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const H = { 'X-Requested-With': 'books' };
let proc, dir, cookie;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'books-test-'));
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, APP_PASSWORD: 'hunter2hunter2' }, stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('login is required, wrong password rejected, right password accepted', async () => {
  assert.equal((await fetch(BASE + '/api/c/docs')).status, 401);
  const home = await fetch(BASE + '/', { redirect: 'manual' });
  assert.equal(home.status, 302);
  const bad = await fetch(BASE + '/login', { method: 'POST', body: 'password=nope', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
  assert.equal(bad.status, 401);
  const ok = await fetch(BASE + '/login', { method: 'POST', body: 'password=hunter2hunter2', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
  assert.equal(ok.status, 302);
  cookie = ok.headers.get('set-cookie').split(';')[0];
  const page = await fetch(BASE + '/', { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Little Honey Treats/);
});

test('records: create, list, replace, delete; rejects missing header and unknown collection', async () => {
  const h = { ...H, cookie, 'Content-Type': 'application/json' };
  assert.equal((await fetch(BASE + '/api/c/docs/abc', { method: 'PUT', headers: { cookie }, body: '{}' })).status, 403);
  assert.equal((await fetch(BASE + '/api/c/nope/abc', { method: 'PUT', headers: h, body: '{}' })).status, 404);
  assert.equal((await fetch(BASE + '/api/c/docs/abc', { method: 'PUT', headers: h, body: JSON.stringify({ number: 'INV-0001' }) })).status, 200);
  assert.equal((await fetch(BASE + '/api/c/docs/abc', { method: 'PUT', headers: h, body: JSON.stringify({ number: 'INV-0002' }) })).status, 200);
  const list = await (await fetch(BASE + '/api/c/docs', { headers: { cookie } })).json();
  assert.deepEqual(list, [{ id: 'abc', data: { number: 'INV-0002' } }]);
  assert.equal((await fetch(BASE + '/api/c/docs/abc', { method: 'DELETE', headers: { ...H, cookie } })).status, 200);
  assert.deepEqual(await (await fetch(BASE + '/api/c/docs', { headers: { cookie } })).json(), []);
});

test('receipts: upload then fetch; html is never served inline', async () => {
  const up = await fetch(BASE + '/api/blob', { method: 'PUT', headers: { ...H, cookie, 'Content-Type': 'application/pdf', 'X-Filename': 'bunnings%20receipt.pdf' }, body: Buffer.from('%PDF-1.4 test') });
  const { id } = await up.json();
  assert.match(id, /^[a-f0-9]{32}$/);
  const got = await fetch(BASE + '/_blob/' + id, { headers: { cookie } });
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'application/pdf');
  assert.equal(await got.text(), '%PDF-1.4 test');
  const evil = await (await fetch(BASE + '/api/blob', { method: 'PUT', headers: { ...H, cookie, 'Content-Type': 'text/html' }, body: '<script>alert(1)</script>' })).json();
  const r = await fetch(BASE + '/_blob/' + evil.id, { headers: { cookie } });
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.match(r.headers.get('content-disposition'), /^attachment/);
  assert.equal((await fetch(BASE + '/_blob/../../etc/passwd', { headers: { cookie } })).status, 404);
});

test('live events reach a second client', async () => {
  const ctl = new AbortController();
  const res = await fetch(BASE + '/api/events', { headers: { cookie }, signal: ctl.signal });
  const reader = res.body.getReader();
  await reader.read(); // retry line
  await fetch(BASE + '/api/c/customers/c1', { method: 'PUT', headers: { ...H, cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Sam' }) });
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), /"coll":"customers".*"name":"Sam"/);
  ctl.abort();
});
