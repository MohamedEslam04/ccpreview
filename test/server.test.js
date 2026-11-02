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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpreview-test-'));
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
  assert.strictEqual(info.app, 'ccpreview');
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

// ---------- pending question (written by the optional hook) ----------
test('pending question: SSE carries it, the list marks the session asking, both clear again', async () => {
  const dir = path.join(tmp, 'data', 'pending');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'abc-123.json');
  const q = { questions: [{ header: 'Pick', question: 'Which one?', options: [{ label: 'A', description: 'first' }], multiSelect: false }] };
  const write = (extra) => fs.writeFileSync(file, JSON.stringify({ session: 'abc-123', tool: 'AskUserQuestion', id: 'tu9', input: q, at: Date.now(), ...extra }));
  const sessionState = async () => JSON.parse((await request('GET', '/api/sessions')).text)[0].sessions.find((s) => s.id === 'abc-123').state;

  assert.strictEqual(await sessionState(), 'idle');
  write();
  assert.strictEqual(await sessionState(), 'asking');

  const events = [];
  let wake = () => {};
  const req = http.get({ host: '127.0.0.1', port, path: '/api/stream?dir=-home-me-demo&id=abc-123', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
    let buf = '';
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const m = block.match(/^data: (.*)$/m);
        if (m && !block.startsWith('event:')) events.push(...JSON.parse(m[1]));
      }
      wake();
    });
  });
  req.on('error', () => {});
  const until = (pred) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const check = () => { if (pred()) resolve(); else if (Date.now() - t0 > 5000) reject(new Error('timeout: ' + JSON.stringify(events.map((e) => e.k)))); };
    wake = check;
    check();
    const iv = setInterval(() => { check(); if (pred()) clearInterval(iv); }, 100);
    setTimeout(() => clearInterval(iv), 5200);
  });
  try {
    await until(() => events.some((e) => e.k === 'pending' && e.p));
    const ev = events.find((e) => e.k === 'pending' && e.p);
    assert.strictEqual(ev.p.tool, 'AskUserQuestion');
    assert.strictEqual(ev.p.id, 'tu9');
    assert.strictEqual(ev.p.input.questions[0].question, 'Which one?');

    fs.rmSync(file);
    await until(() => events.some((e) => e.k === 'pending' && e.p === null));
    assert.strictEqual(await sessionState(), 'idle');
  } finally {
    req.destroy();
    fs.rmSync(file, { force: true });
  }
});

test('pending question: ignored when older than 12h, malformed, for another tool or without a timestamp', async () => {
  const dir = path.join(tmp, 'data', 'pending');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'abc-123.json');
  const stateNow = async () => JSON.parse((await request('GET', '/api/sessions')).text)[0].sessions.find((s) => s.id === 'abc-123').state;
  try {
    fs.writeFileSync(file, JSON.stringify({ tool: 'AskUserQuestion', input: {}, at: Date.now() - 13 * 3600e3 }));
    assert.strictEqual(await stateNow(), 'idle');
    fs.writeFileSync(file, JSON.stringify({ tool: 'Bash', input: {}, at: Date.now() }));
    assert.strictEqual(await stateNow(), 'idle');
    fs.writeFileSync(file, JSON.stringify({ tool: 'AskUserQuestion', input: {} }));
    assert.strictEqual(await stateNow(), 'idle', 'no timestamp');
    fs.writeFileSync(file, '{ broken');
    assert.strictEqual(await stateNow(), 'idle');
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('pending question: a subagent stream never carries it', async () => {
  const sub = path.join(tmp, 'projects', '-home-me-demo', 'abc-123', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-a1.jsonl'), JSON.stringify({ type: 'user', isSidechain: true, message: { role: 'user', content: 'task' } }) + '\n');
  const dir = path.join(tmp, 'data', 'pending');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'abc-123.json');
  fs.writeFileSync(file, JSON.stringify({ tool: 'AskUserQuestion', input: {}, at: Date.now() }));
  try {
    const text = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/stream?dir=-home-me-demo&id=abc-123&agent=a1', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        setTimeout(() => { req.destroy(); resolve(buf); }, 1600); // two pump rounds
      });
      req.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
    });
    assert.match(text, /event: ready/);
    assert.doesNotMatch(text, /pending/);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

// ---------- /api/mux: many sessions over one SSE connection ----------
function openMux() {
  const mux = { cid: null, msgs: [], req: null };
  let wake = () => {};
  mux.ready = new Promise((resolve, reject) => {
    mux.req = http.get({ host: '127.0.0.1', port, path: '/api/mux', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      assert.strictEqual(res.statusCode, 200);
      assert.match(res.headers['content-type'], /text\/event-stream/);
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const hello = block.match(/^event: hello\ndata: (.*)$/);
          if (hello) { mux.cid = JSON.parse(hello[1]).cid; resolve(mux); continue; }
          const m = block.match(/^data: (.*)$/m);
          if (m && !block.startsWith('event:')) mux.msgs.push(JSON.parse(m[1]));
        }
        wake();
      });
    });
    mux.req.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
  });
  mux.until = (pred) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); resolve(); } else if (Date.now() - t0 > 5000) { clearInterval(iv); reject(new Error('timeout: ' + JSON.stringify(mux.msgs.map((m) => [m.s, m.t])))); }
    }, 20);
  });
  mux.post = (kind, body, headers = {}) => request('POST', '/api/mux/' + kind, {
    headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return mux;
}
const REF = { dir: '-home-me-demo', id: 'abc-123' };

test('/api/mux: hello, then a sub replays events and signals ready tagged with its sid', async () => {
  const mux = openMux();
  await mux.ready;
  try {
    assert.match(mux.cid, /^[0-9a-f]{16}$/);
    const r = await mux.post('sub', { cid: mux.cid, sid: 's1', ...REF });
    assert.strictEqual(r.status, 200);
    await mux.until(() => mux.msgs.some((m) => m.t === 'ready'));
    assert.ok(mux.msgs.every((m) => m.s === 's1'));
    const ev = mux.msgs.filter((m) => m.t === 'events').flatMap((m) => m.d);
    assert.ok(ev.some((e) => e.k === 'user'));
    assert.ok(ev.some((e) => e.text === 'done'));
  } finally {
    mux.req.destroy();
  }
});

test('/api/mux/sub validates like /api/stream, and rejects unknown connections', async () => {
  const mux = openMux();
  await mux.ready;
  try {
    const sub = (o) => mux.post('sub', { cid: mux.cid, sid: 's1', ...REF, ...o });
    assert.strictEqual((await sub({ dir: '..' })).status, 400);
    assert.strictEqual((await sub({ id: '../../x' })).status, 400);
    assert.strictEqual((await sub({ agent: '../x' })).status, 400);
    assert.strictEqual((await sub({ dir: 5 })).status, 400);
    assert.strictEqual((await sub({ sid: '' })).status, 400);
    assert.strictEqual((await sub({ id: 'nope' })).status, 404);
    assert.strictEqual((await sub({ cid: 'deadbeef' })).status, 404);
    assert.strictEqual((await mux.post('unsub', { cid: 'deadbeef', sid: 's1' })).status, 404);
    const bad = await request('POST', '/api/mux/sub', { headers: { Origin: `http://127.0.0.1:${port}` }, body: '{ nope' });
    assert.strictEqual(bad.status, 400);
  } finally {
    mux.req.destroy();
  }
});

test('/api/mux/sub and unsub refuse a foreign or missing Origin', async () => {
  const mux = openMux();
  await mux.ready;
  try {
    for (const kind of ['sub', 'unsub']) {
      for (const Origin of ['https://evil.example', undefined]) {
        const r = await request('POST', '/api/mux/' + kind, { headers: Origin ? { Origin } : {}, body: JSON.stringify({ cid: mux.cid, sid: 's1', ...REF }) });
        assert.strictEqual(r.status, 403, `${kind} ${Origin}`);
      }
    }
  } finally {
    mux.req.destroy();
  }
});

test('/api/mux: two subs on one connection each deliver tagged with their own sid; unsub stops one', async () => {
  const sub = path.join(tmp, 'projects', '-home-me-demo', 'abc-123', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-a1.jsonl'), JSON.stringify({ type: 'user', isSidechain: true, message: { role: 'user', content: 'task' } }) + '\n');
  const mux = openMux();
  await mux.ready;
  try {
    assert.strictEqual((await mux.post('sub', { cid: mux.cid, sid: 'a', ...REF })).status, 200);
    assert.strictEqual((await mux.post('sub', { cid: mux.cid, sid: 'b', ...REF, agent: 'a1' })).status, 200);
    await mux.until(() => ['a', 'b'].every((s) => mux.msgs.some((m) => m.s === s && m.t === 'ready')));
    const texts = (s) => mux.msgs.filter((m) => m.s === s && m.t === 'events').flatMap((m) => m.d).map((e) => e.text);
    assert.ok(texts('a').includes('done'));
    assert.ok(!texts('b').includes('done'));
    // unsub: a line appended to the file reaches the still-subscribed sid only
    assert.strictEqual((await mux.post('sub', { cid: mux.cid, sid: 'd', ...REF })).status, 200);
    await mux.until(() => mux.msgs.some((m) => m.s === 'd' && m.t === 'ready'));
    assert.strictEqual((await mux.post('unsub', { cid: mux.cid, sid: 'a' })).status, 200);
    mux.msgs.length = 0;
    const file = path.join(tmp, 'projects', '-home-me-demo', 'abc-123.jsonl');
    const orig = fs.readFileSync(file);
    try {
      fs.appendFileSync(file, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'appended' }] } }) + '\n');
      await mux.until(() => mux.msgs.some((m) => m.s === 'd' && m.t === 'events' && m.d.some((e) => e.text === 'appended')));
      assert.ok(!mux.msgs.some((m) => m.s === 'a'), 'nothing for a after unsub');
    } finally {
      fs.writeFileSync(file, orig);
    }
  } finally {
    mux.req.destroy();
  }
});

test('/api/mux: a sub with an existing sid replaces it and replays again; closing the connection drops the cid', async () => {
  const mux = openMux();
  await mux.ready;
  const cid = mux.cid;
  try {
    await mux.post('sub', { cid, sid: 's1', ...REF });
    await mux.until(() => mux.msgs.some((m) => m.t === 'ready'));
    mux.msgs.length = 0;
    await mux.post('sub', { cid, sid: 's1', ...REF });
    await mux.until(() => mux.msgs.some((m) => m.t === 'ready'));
    assert.ok(mux.msgs.some((m) => m.t === 'events' && m.d.some((e) => e.text === 'done')));
  } finally {
    mux.req.destroy();
  }
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual((await mux.post('sub', { cid, sid: 's1', ...REF })).status, 404);
});

test('/api/mux/sub caps subscriptions per connection', async () => {
  const mux = openMux();
  await mux.ready;
  try {
    for (let i = 0; i < 32; i++) assert.strictEqual((await mux.post('sub', { cid: mux.cid, sid: 'x' + i, ...REF })).status, 200);
    assert.strictEqual((await mux.post('sub', { cid: mux.cid, sid: 'x32', ...REF })).status, 429);
    assert.strictEqual((await mux.post('sub', { cid: mux.cid, sid: 'x0', ...REF })).status, 200, 'replacing is still fine');
  } finally {
    mux.req.destroy();
  }
});

test('/api/usage is null until the tap records something, then only clamped numbers', async () => {
  assert.strictEqual((await request('GET', '/api/usage')).text, 'null');
  const data = path.join(tmp, 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'usage.json'), JSON.stringify({ five_hour: { pct: 140, resets_at: 1800000000, extra: 'x' }, seven_day: { pct: 'high' }, secret: 's', ts: 5 }));
  const u = JSON.parse((await request('GET', '/api/usage')).text);
  assert.deepStrictEqual(u, { five_hour: { pct: 100, resets_at: 1800000000 }, seven_day: null, ts: 5 });
  fs.rmSync(path.join(data, 'usage.json'));
});
