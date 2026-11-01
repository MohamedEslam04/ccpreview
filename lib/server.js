'use strict';
// ccpreview local server: serves the web app and reads ~/.claude/projects for it.
// Binds to 127.0.0.1 only. Transcripts can contain secrets and code: never expose this server.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { claudeDir } = require('./paths');
const os = require('os');
const crypto = require('crypto');
const core = require('../web/core.js');
const { gitInfo } = require('./git.js');

const WEB = path.join(__dirname, '..', 'web');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/core.js': ['core.js', 'text/javascript; charset=utf-8'],
  '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
  '/source.js': ['source.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/logo.svg': ['logo.svg', 'image/svg+xml'],
  '/favicon.svg': ['logo.svg', 'image/svg+xml'],
};
const MAX_IMG_BYTES = 150e6;

function createServer(opts = {}) {
  const PROJECTS = opts.projects || path.join(claudeDir(), 'projects');
  const DATA = opts.dataDir || path.join(os.homedir(), '.ccpreview');
  const PAGES = path.join(DATA, 'pages.json');
  const BACKUPS = path.join(DATA, 'backups');
  const PENDING = path.join(DATA, 'pending'); // written by the optional hook (lib/hook.js)
  const version = opts.version || '0.0.0';
  let allowedHosts = new Set();

  // ---------- filesystem adapter for core ----------
  const safeReaddir = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return []; } };
  const fileOf = (ref) => (ref.agent
    ? path.join(PROJECTS, ref.dir, ref.id, 'subagents', `agent-${ref.agent}.jsonl`)
    : path.join(PROJECTS, ref.dir, ref.id + '.jsonl'));

  async function readLines(ref, offset) {
    let fh;
    try { fh = await fs.promises.open(fileOf(ref), 'r'); } catch (e) { return { lines: [], offset, reset: false }; }
    try {
      const { size } = await fh.stat();
      let reset = false;
      if (size < offset) { offset = 0; reset = true; } // file was rewritten
      const lines = [];
      const decoder = new TextDecoder();
      const buf = Buffer.alloc(1 << 20);
      let carry = Buffer.alloc(0);
      let pos = offset;
      while (pos < size) {
        const { bytesRead: n } = await fh.read(buf, 0, Math.min(buf.length, size - pos), pos);
        if (!n) break;
        pos += n;
        const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
        const r = core.splitLines(chunk, decoder);
        lines.push(...r.lines);
        carry = chunk.subarray(r.used);
      }
      return { lines, offset: pos - carry.length, reset };
    } finally {
      await fh.close();
    }
  }

  // images: kept in memory only (LRU); a session stream re-registers them on every replay
  const imgCache = new Map();
  let imgBytes = 0;
  function storeImage(src) {
    const key = crypto.createHash('sha1').update(src.data).digest('hex').slice(0, 20);
    const hit = imgCache.get(key);
    if (hit) { imgCache.delete(key); imgCache.set(key, hit); return `/api/img/${key}`; }
    const buf = Buffer.from(src.data, 'base64');
    imgCache.set(key, { mime: src.media_type, buf });
    imgBytes += buf.length;
    for (const [k, v] of imgCache) {
      if (imgBytes <= MAX_IMG_BYTES) break;
      imgCache.delete(k);
      imgBytes -= v.buf.length;
    }
    return `/api/img/${key}`;
  }

  const agentInfo = new Map();
  const adapter = {
    async listProjects() {
      return safeReaddir(PROJECTS).filter((e) => e.isDirectory() && core.safeDir(e.name)).map((e) => e.name);
    },
    async listSessionFiles(dir) {
      const out = [];
      for (const e of safeReaddir(path.join(PROJECTS, dir))) {
        if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
        try {
          const st = fs.statSync(path.join(PROJECTS, dir, e.name));
          out.push({ id: e.name.slice(0, -6), size: st.size, mtime: st.mtimeMs });
        } catch (err) { /* vanished */ }
      }
      return out;
    },
    async listSubagents(dir, id) {
      const sub = path.join(PROJECTS, dir, id, 'subagents');
      const out = [];
      for (const e of safeReaddir(sub)) {
        const m = e.name.match(/^agent-([\w-]+)\.jsonl$/);
        if (!m) continue;
        let st;
        try { st = fs.statSync(path.join(sub, e.name)); } catch (err) { continue; }
        const metaFile = path.join(sub, `agent-${m[1]}.meta.json`);
        let info = {};
        try {
          const ms = fs.statSync(metaFile).mtimeMs;
          const c = agentInfo.get(metaFile);
          if (c && c.ms === ms) info = c.info;
          else { info = JSON.parse(fs.readFileSync(metaFile, 'utf8')); agentInfo.set(metaFile, { ms, info }); }
        } catch (err) { /* no meta yet */ }
        out.push({ id: m[1], mtime: st.mtimeMs, born: st.birthtimeMs || st.ctimeMs, info });
      }
      return out;
    },
    readLines,
    storeImage,
  };

  // identical concurrent list requests share one scan, and scans never overlap (the meta cache is not re-entrant)
  const metaCache = new Map();
  const listJobs = new Map();
  let scanChain = Promise.resolve();
  function refreshSessions(more = []) {
    const key = [...more].sort().join(',');
    if (!listJobs.has(key)) {
      const job = scanChain.then(() => core.listSessions(adapter, metaCache, new Set(more)));
      scanChain = job.catch(() => {});
      listJobs.set(key, job.finally(() => listJobs.delete(key)));
    }
    return listJobs.get(key);
  }

  // ---------- pending question (optional hook) ----------
  // The question or plan a session is waiting on, or null. Only the hook knows about it until it is
  // answered. Stale after 12h (a hook that never got its clearing event).
  function pendingOf(id) {
    if (!core.safeId(id)) return null;
    try {
      const p = JSON.parse(fs.readFileSync(path.join(PENDING, id + '.json'), 'utf8'));
      if (!p || !Number.isFinite(p.at) || Date.now() - p.at > 12 * 3600e3 || !/^(AskUserQuestion|ExitPlanMode)$/.test(p.tool)) return null;
      return { tool: p.tool, id: String(p.id || ''), input: p.input || {}, at: p.at };
    } catch (e) { return null; }
  }
  // sessions that are asking right now: one directory read instead of a file read per session
  function askingIds() {
    const ids = new Set();
    for (const e of safeReaddir(PENDING)) {
      const m = e.name.match(/^([\w-]+)\.json$/);
      if (m && pendingOf(m[1])) ids.add(m[1]);
    }
    return ids;
  }
  const withAsking = (projects) => {
    const asking = askingIds();
    if (!asking.size) return projects;
    return projects.map((pr) => ({ ...pr, sessions: pr.sessions.map((s) => (asking.has(s.id) ? { ...s, state: 'asking' } : s)) }));
  };

  // ---------- live stream (Server-Sent Events) ----------
  const tick = () => new Promise((r) => setImmediate(r));
  function stream(req, res, ref) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    let offset = 0, closed = false, busy = false, pendingSig = '';
    const pump = async () => {
      if (closed || busy) return;
      busy = true;
      try {
        const r = await readLines(ref, offset);
        if (closed) return;
        if (r.reset) { res.write('event: reset\ndata: {}\n\n'); pendingSig = ''; }
        offset = r.offset;
        if (!ref.agent) {
          // send the pending question when it appears, changes or goes away (and again after a reset)
          const p = pendingOf(ref.id);
          const sig = p ? `${p.id}:${p.at}` : '';
          if (sig !== pendingSig) { pendingSig = sig; res.write(`data: ${JSON.stringify([{ k: 'pending', p }])}\n\n`); }
        }
        // convert in slices so a huge transcript does not stall other requests
        for (let i = 0; i < r.lines.length && !closed; i += 400) {
          const ev = r.lines.slice(i, i + 400).flatMap((l) => core.convert(l, !!ref.agent, storeImage));
          if (ev.length) res.write(`data: ${JSON.stringify(ev)}\n\n`);
          await tick();
        }
      } finally {
        busy = false;
      }
    };
    pump().then(() => { if (!closed) res.write('event: ready\ndata: {}\n\n'); });
    const iv = setInterval(pump, 700);
    const hb = setInterval(() => res.write(': hb\n\n'), 20000);
    req.on('close', () => { closed = true; clearInterval(iv); clearInterval(hb); });
  }

  // ---------- notes pages ----------
  function readPages() {
    try { return JSON.parse(fs.readFileSync(PAGES, 'utf8')); } catch (e) { return {}; }
  }
  function writePages(body) {
    fs.mkdirSync(BACKUPS, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const bak = path.join(BACKUPS, `pages-${day}.json`);
    if (fs.existsSync(PAGES) && !fs.existsSync(bak)) {
      fs.copyFileSync(PAGES, bak);
      fs.readdirSync(BACKUPS).sort().slice(0, -14).forEach((f) => fs.unlinkSync(path.join(BACKUPS, f)));
    }
    const tmp = PAGES + '.tmp';
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, PAGES);
  }
  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const parts = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(new Error('too large')); req.destroy(); } else parts.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
      req.on('error', reject);
    });
  }

  // ---------- http ----------
  const send = (res, code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
  const sendJson = (res, obj) => send(res, 200, 'application/json; charset=utf-8', JSON.stringify(obj));
  const sameOrigin = (req) => req.headers.origin === `http://${req.headers.host}`;

  const server = http.createServer((req, res) => {
    // Host check blocks DNS rebinding; no CORS headers, so other sites cannot read responses.
    if (!allowedHosts.has(req.headers.host)) return send(res, 403, 'text/plain', 'forbidden host');
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      const file = STATIC[url.pathname];
      if (req.method === 'GET' && file) {
        const p = path.join(WEB, file[0]);
        if (!fs.existsSync(p)) return send(res, 404, 'text/plain', 'not found');
        res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
        return res.end(fs.readFileSync(p));
      }
      if (req.method === 'GET' && url.pathname === '/api/info') {
        return sendJson(res, { app: 'ccpreview', version, mode: 'server', service: !!opts.activated, projects: PROJECTS });
      }
      if (url.pathname === '/api/pages') {
        if (req.method === 'GET') return sendJson(res, readPages());
        if (req.method === 'PUT') {
          if (!sameOrigin(req)) return send(res, 403, 'text/plain', 'bad origin');
          return readBody(req, 50e6)
            .then((b) => { JSON.parse(b); writePages(b); sendJson(res, { ok: true }); })
            .catch((e) => send(res, 400, 'text/plain', e.message));
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/shutdown') {
        if (!sameOrigin(req)) return send(res, 403, 'text/plain', 'bad origin');
        sendJson(res, { ok: true });
        // under systemd socket activation the socket stays open, so the next request starts us again
        setTimeout(() => process.exit(0), 150);
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/img/')) {
        const img = imgCache.get(url.pathname.slice(9));
        if (!img) return send(res, 404, 'text/plain', 'image expired, reopen the session');
        res.writeHead(200, { 'Content-Type': img.mime, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
        return res.end(img.buf);
      }
      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        // all=1: every session of every project (the date filter and time grouping need the full list)
        const more = url.searchParams.get('all') === '1' ? ['*']
          : (url.searchParams.get('more') || '').split(',').filter(core.safeDir).slice(0, 50);
        return refreshSessions(more).then((list) => sendJson(res, withAsking(list)), (e) => send(res, 500, 'text/plain', e.message));
      }
      if (req.method === 'GET' && (url.pathname === '/api/stream' || url.pathname === '/api/git')) {
        const ref = { dir: url.searchParams.get('dir') || '', id: url.searchParams.get('id') || '', agent: url.searchParams.get('agent') || '' };
        if (!core.safeDir(ref.dir) || !core.safeId(ref.id) || (ref.agent && !core.safeId(ref.agent))) return send(res, 400, 'text/plain', 'bad id');
        if (!fs.existsSync(fileOf(ref))) return send(res, 404, 'text/plain', 'no session');
        // git status of the folder named inside the transcript (never one from the request)
        if (url.pathname === '/api/git') return gitInfo(fileOf(ref)).then((g) => sendJson(res, g), (e) => send(res, 500, 'text/plain', e.message));
        return stream(req, res, ref);
      }
      send(res, 404, 'text/plain', 'not found');
    } catch (e) {
      send(res, 500, 'text/plain', e.message);
    }
  });

  return {
    server,
    listen(port, cb) {
      const done = () => {
        const p = server.address().port;
        allowedHosts = new Set([`127.0.0.1:${p}`, `localhost:${p}`]);
        refreshSessions().catch(() => {}); // warm the session cache in the background
        if (cb) cb(p);
      };
      if (opts.activated) server.listen({ fd: 3 }, done); // systemd socket activation
      else server.listen(port, '127.0.0.1', done);
      return server;
    },
  };
}

module.exports = { createServer };
