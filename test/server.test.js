'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createServer } = require('../lib/server.js');

let app, port, tmp;

// http.request instead of fetch: fetch refuses to send a custom Host header and normalizes paths.
function request(method, reqPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(parts).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'marsad-test-'));
  const projects = path.join(tmp, 'projects');
  const dir = path.join(projects, '-home-me-demo');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'user', cwd: '/home/me/demo', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'build a thing' } },
    { type: 'ai-title', aiTitle: 'Build a thing' },
    { type: 'assistant', timestamp: '2026-01-01T00:00:01Z', message: { content: [{ type: 'text', text: 'done' }] } },
    { type: 'system', subtype: 'turn_duration' },
  ];
  fs.writeFileSync(path.join(dir, 'abc-123.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  // sessions whose cwd is a real git repo, a plain folder and a folder that is gone
  const repo = path.join(tmp, 'repo');
  const plain = path.join(tmp, 'plain');
  fs.mkdirSync(repo);
  fs.mkdirSync(plain);
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first commit');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'x\n');
  // no prompt or title, so these stay out of the session list; the last cwd in the file is the one that counts
  const session = (id, cwd) => fs.writeFileSync(path.join(dir, id + '.jsonl'), [
    { type: 'system', subtype: 'x', cwd: '/old/place' },
    { type: 'system', subtype: 'x', cwd },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  session('git-repo', repo);
  session('git-plain', plain);
  session('git-gone', path.join(tmp, 'deleted'));
  app = createServer({ projects, dataDir: path.join(tmp, 'data'), version: '9.9.9' });
  await new Promise((resolve) => app.listen(0, (p) => { port = p; resolve(); }));
});

test.after(() => {
  app.server.closeAllConnections();
  app.server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('GET /api/info', async () => {
  const r = await request('GET', '/api/info');
  assert.strictEqual(r.status, 200);
  const info = JSON.parse(r.text);
  assert.strictEqual(info.app, 'marsad');
  assert.strictEqual(info.version, '9.9.9');
  assert.strictEqual(info.mode, 'server');
  assert.strictEqual(info.service, false);
});

test('responses carry no CORS headers', async () => {
  const r = await request('GET', '/api/info', { headers: { Origin: 'https://evil.example' } });
  assert.strictEqual(r.headers['access-control-allow-origin'], undefined);
});

test('GET /api/sessions lists the fake session', async () => {
  const r = await request('GET', '/api/sessions');
  assert.strictEqual(r.status, 200);
  const list = JSON.parse(r.text);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].dir, '-home-me-demo');
  assert.strictEqual(list[0].name, 'demo');
  assert.strictEqual(list[0].sessions[0].id, 'abc-123');
  assert.strictEqual(list[0].sessions[0].title, 'Build a thing');
  assert.strictEqual(list[0].sessions[0].state, 'idle');
});

test('a forbidden Host header gets 403 (DNS rebinding guard)', async () => {
  for (const host of ['evil.example', `evil.example:${port}`, '127.0.0.1']) {
    const r = await request('GET', '/api/info', { headers: { Host: host } });
    assert.strictEqual(r.status, 403, host);
  }
  const ok = await request('GET', '/api/info', { headers: { Host: `localhost:${port}` } });
  assert.strictEqual(ok.status, 200);
});

test('/api/stream rejects dir=.. with 400', async () => {
  const r = await request('GET', '/api/stream?dir=..&id=abc-123');
  assert.strictEqual(r.status, 400);
  const r2 = await request('GET', '/api/stream?dir=-home-me-demo&id=..%2F..%2Fx');
  assert.strictEqual(r2.status, 400);
});

test('/api/stream for a missing session is 404', async () => {
  const r = await request('GET', '/api/stream?dir=-home-me-demo&id=nope');
  assert.strictEqual(r.status, 404);
});

test('/api/stream replays converted events then signals ready', async () => {
  const text = await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/stream?dir=-home-me-demo&id=abc-123', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      assert.strictEqual(res.statusCode, 200);
      assert.match(res.headers['content-type'], /text\/event-stream/);
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        if (buf.includes('event: ready')) { req.destroy(); resolve(buf); }
      });
    });
    req.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
  });
  assert.match(text, /"k":"user"/);
  assert.match(text, /"text":"done"/);
});

test('/api/git reports the repo of the cwd found in the transcript', async () => {
  const r = await request('GET', '/api/git?dir=-home-me-demo&id=git-repo');
  assert.strictEqual(r.status, 200);
  const g = JSON.parse(r.text);
  assert.strictEqual(g.repo, true);
  assert.strictEqual(g.cwd, path.join(tmp, 'repo'));
  assert.strictEqual(g.branch, 'main');
  assert.strictEqual(g.upstream, '');
  assert.strictEqual(g.total, 2);
  assert.deepStrictEqual(g.files.map((f) => [f.x, f.y, f.f]).sort(), [[' ', 'M', 'a.txt'], ['?', '?', 'new.txt']]);
  assert.strictEqual(g.last.subject, 'first commit');
  assert.strictEqual(g.stash, 0);
});

test('/api/git for a non-repo folder is repo:false, and a deleted folder is gone', async () => {
  const plain = JSON.parse((await request('GET', '/api/git?dir=-home-me-demo&id=git-plain')).text);
  assert.strictEqual(plain.repo, false);
  assert.ok(!plain.gone);
  const gone = JSON.parse((await request('GET', '/api/git?dir=-home-me-demo&id=git-gone')).text);
  assert.deepStrictEqual([gone.repo, gone.gone], [false, true]);
});

test('/api/git validates dir, id and agent like /api/stream', async () => {
  for (const q of ['dir=..&id=git-repo', 'dir=-home-me-demo&id=..%2F..%2Fx', 'dir=-home-me-demo&id=git-repo&agent=..%2Fx', 'dir=.hidden&id=git-repo']) {
    assert.strictEqual((await request('GET', '/api/git?' + q)).status, 400, q);
  }
  assert.strictEqual((await request('GET', '/api/git?dir=-home-me-demo&id=nope')).status, 404);
});

test('/api/git ignores a cwd or path passed in the request', async () => {
  const r = await request('GET', `/api/git?dir=-home-me-demo&id=git-plain&cwd=${encodeURIComponent(path.join(tmp, 'repo'))}`);
  assert.strictEqual(JSON.parse(r.text).repo, false);
});

test('/api/git keeps the Host check', async () => {
  const r = await request('GET', '/api/git?dir=-home-me-demo&id=git-repo', { headers: { Host: 'evil.example' } });
  assert.strictEqual(r.status, 403);
});

test('PUT /api/pages without Origin is 403 and writes nothing', async () => {
  const r = await request('PUT', '/api/pages', { headers: { 'Content-Type': 'application/json' }, body: '{"pages":[]}' });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(fs.existsSync(path.join(tmp, 'data', 'pages.json')), false);
});

test('PUT /api/pages with a foreign Origin is 403', async () => {
  const r = await request('PUT', '/api/pages', { headers: { Origin: 'https://evil.example' }, body: '{"pages":[]}' });
  assert.strictEqual(r.status, 403);
});

test('PUT /api/pages with the same Origin saves, GET returns it', async () => {
  const body = JSON.stringify({ pages: [{ id: 'p1', name: 'one' }], cur: 0 });
  const put = await request('PUT', '/api/pages', { headers: { Origin: `http://127.0.0.1:${port}` }, body });
  assert.strictEqual(put.status, 200);
  const get = await request('GET', '/api/pages');
  assert.deepStrictEqual(JSON.parse(get.text), JSON.parse(body));
  assert.ok(fs.existsSync(path.join(tmp, 'data', 'pages.json')));
});

test('PUT /api/pages with invalid JSON is 400', async () => {
  const r = await request('PUT', '/api/pages', { headers: { Origin: `http://127.0.0.1:${port}` }, body: '{nope' });
  assert.strictEqual(r.status, 400);
});

test('POST /api/shutdown without Origin is 403 (and the process survives)', async () => {
  const r = await request('POST', '/api/shutdown');
  assert.strictEqual(r.status, 403);
});

test('static: the app is served, path traversal is not', async () => {
  const idx = await request('GET', '/');
  assert.strictEqual(idx.status, 200);
  assert.match(idx.headers['content-type'], /text\/html/);
  const core = await request('GET', '/core.js');
  assert.strictEqual(core.status, 200);

  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'server.js'), 'utf8');
  for (const p of ['/../lib/server.js', '/%2e%2e/lib/server.js', '/..%2flib/server.js', '/web/../lib/server.js', '/lib/server.js']) {
    const r = await request('GET', p);
    assert.notStrictEqual(r.status, 200, p);
    assert.ok(!r.text.includes("createServer(opts = {})"), p);
    assert.notStrictEqual(r.text, serverSrc, p);
  }
});

test('unknown paths are 404', async () => {
  assert.strictEqual((await request('GET', '/nope')).status, 404);
});
