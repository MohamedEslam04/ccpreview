/*
 * Where Marsad gets sessions from.
 *
 *  - ServerSource: the page is served by `npx marsad` on 127.0.0.1; sessions come from its API.
 *  - FolderSource: the page is on the web (e.g. GitHub Pages); you pick ~/.claude/projects once and
 *    the browser reads it directly (File System Access API, Chrome / Edge). Nothing is uploaded.
 *
 * Both expose the same interface to app.js:
 *   source.mode                 'server' | 'folder'
 *   source.ready                true when sessions can be listed
 *   source.list({ all, more })  -> Promise<projects>
 *   source.open(ref, handlers)  -> { close() }   handlers: reset(), events(list), ready()
 */
(function () {
  'use strict';
  const core = window.MarsadCore;
  const isLocalServer = location.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(location.hostname) && !!location.port;

  // ---------------------------------------------------------------- server
  class ServerSource {
    constructor() {
      this.mode = 'server';
      this.ready = true;
      this.info = null;
    }
    async init() {
      try { this.info = await (await fetch('/api/info')).json(); } catch (e) { this.info = null; }
      this.ready = !!this.info;
      return this.info ? 'ready' : 'offline';
    }
    async list({ all, more } = {}) {
      const qs = all ? '?all=1' : more && more.length ? '?more=' + encodeURIComponent(more.join(',')) : '';
      const r = await fetch('/api/sessions' + qs);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }
    open(ref, h) {
      const qs = `dir=${encodeURIComponent(ref.dir)}&id=${encodeURIComponent(ref.id)}` + (ref.agent ? `&agent=${encodeURIComponent(ref.agent)}` : '');
      const es = new EventSource('/api/stream?' + qs);
      es.onopen = () => h.reset(); // the server replays the whole file on every (re)connect
      es.onmessage = (e) => h.events(JSON.parse(e.data));
      es.addEventListener('reset', () => h.reset());
      es.addEventListener('ready', () => h.ready());
      return { close: () => es.close() };
    }
  }

  // ---------------------------------------------------------------- folder (File System Access API)
  const IDB_NAME = 'marsad', IDB_STORE = 'handles';
  function idb(mode, fn) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(IDB_NAME, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(IDB_STORE);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction(IDB_STORE, mode);
        const req = fn(tx.objectStore(IDB_STORE));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => reject(tx.error);
      };
    });
  }
  const saveHandle = (h) => idb('readwrite', (s) => s.put(h, 'projects'));
  const loadHandle = () => idb('readonly', (s) => s.get('projects')).catch(() => null);
  const forgetHandle = () => idb('readwrite', (s) => s.delete('projects'));

  async function* dirEntries(dirHandle) {
    for await (const [name, handle] of dirHandle.entries()) yield [name, handle];
  }
  async function hasJsonlChild(dirHandle) {
    for await (const [name, h] of dirEntries(dirHandle)) {
      if (h.kind === 'directory') {
        for await (const [n2, h2] of dirEntries(h)) if (h2.kind === 'file' && n2.endsWith('.jsonl')) return true;
      }
    }
    return false;
  }

  class FolderSource {
    constructor() {
      this.mode = 'folder';
      this.supported = typeof window.showDirectoryPicker === 'function';
      this.root = null;      // FileSystemDirectoryHandle of ~/.claude/projects
      this.pending = null;   // a remembered handle that needs a click to re-grant access
      this.ready = false;
      this.metaCache = new Map();
      this.imgs = new Map();
      this.agentBorn = new Map();
      this.chain = Promise.resolve();
      this.adapter = this.makeAdapter();
    }
    get folderName() { return (this.root || this.pending || {}).name || ''; }

    // On load: reuse the folder picked last time if the browser still lets us read it.
    async init() {
      if (!this.supported) return 'unsupported';
      const h = await loadHandle();
      if (!h) return 'needs-folder';
      const perm = await h.queryPermission({ mode: 'read' });
      if (perm === 'granted') { this.use(h); return 'ready'; }
      this.pending = h;
      return 'needs-permission';
    }
    use(h) {
      this.root = h;
      this.pending = null;
      this.ready = true;
      this.metaCache.clear();
    }
    // Needs a user gesture (button click).
    async reconnect() {
      if (!this.pending) return this.pick();
      const perm = await this.pending.requestPermission({ mode: 'read' });
      if (perm !== 'granted') throw new Error('permission-denied');
      this.use(this.pending);
    }
    async pick() {
      let h = await window.showDirectoryPicker({ id: 'marsad-projects', mode: 'read' });
      // picked ~/.claude (or anything holding a "projects" folder): step into it
      if (!(await hasJsonlChild(h))) {
        try {
          const p = await h.getDirectoryHandle('projects');
          if (await hasJsonlChild(p)) h = p;
        } catch (e) { /* no projects/ inside */ }
      }
      if (!(await hasJsonlChild(h))) throw new Error('not-projects');
      await saveHandle(h);
      this.use(h);
    }
    async disconnect() {
      await forgetHandle();
      this.root = null;
      this.pending = null;
      this.ready = false;
    }

    makeAdapter() {
      const self = this;
      const fileHandle = async (ref) => {
        const dir = await self.root.getDirectoryHandle(ref.dir);
        if (!ref.agent) return dir.getFileHandle(ref.id + '.jsonl');
        const sub = await (await dir.getDirectoryHandle(ref.id)).getDirectoryHandle('subagents');
        return sub.getFileHandle(`agent-${ref.agent}.jsonl`);
      };
      return {
        async listProjects() {
          const out = [];
          for await (const [name, h] of dirEntries(self.root)) if (h.kind === 'directory' && core.safeDir(name)) out.push(name);
          return out;
        },
        async listSessionFiles(dir) {
          const out = [];
          let dh;
          try { dh = await self.root.getDirectoryHandle(dir); } catch (e) { return out; }
          for await (const [name, h] of dirEntries(dh)) {
            if (h.kind !== 'file' || !name.endsWith('.jsonl')) continue;
            try {
              const f = await h.getFile();
              out.push({ id: name.slice(0, -6), size: f.size, mtime: f.lastModified });
            } catch (e) { /* vanished */ }
          }
          return out;
        },
        async listSubagents(dir, id) {
          const out = [];
          let sub;
          try { sub = await (await (await self.root.getDirectoryHandle(dir)).getDirectoryHandle(id)).getDirectoryHandle('subagents'); }
          catch (e) { return out; }
          const metas = new Map();
          const files = [];
          for await (const [name, h] of dirEntries(sub)) {
            const m = name.match(/^agent-([\w-]+)\.(jsonl|meta\.json)$/);
            if (!m || h.kind !== 'file') continue;
            if (m[2] === 'jsonl') files.push([m[1], h]); else metas.set(m[1], h);
          }
          for (const [aid, h] of files) {
            const f = await h.getFile();
            let info = {};
            if (metas.has(aid)) { try { info = JSON.parse(await (await metas.get(aid).getFile()).text()); } catch (e) { /* partial */ } }
            // browsers don't expose creation time: use the transcript's first timestamp
            let born = self.agentBorn.get(`${dir}/${id}/${aid}`);
            if (born == null) {
              try {
                const head = await f.slice(0, 8192).text();
                const t = (head.match(/"timestamp":"([^"]+)"/) || [])[1];
                born = t ? Date.parse(t) : f.lastModified;
              } catch (e) { born = f.lastModified; }
              self.agentBorn.set(`${dir}/${id}/${aid}`, born);
            }
            out.push({ id: aid, mtime: f.lastModified, born, info });
          }
          return out;
        },
        async readLines(ref, offset) {
          let f;
          try { f = await (await fileHandle(ref)).getFile(); } catch (e) { return { lines: [], offset, reset: false }; }
          let reset = false;
          if (f.size < offset) { offset = 0; reset = true; }
          if (f.size === offset) return { lines: [], offset, reset };
          const bytes = new Uint8Array(await f.slice(offset).arrayBuffer());
          const r = core.splitLines(bytes, new TextDecoder());
          return { lines: r.lines, offset: offset + r.used, reset };
        },
        storeImage(src) {
          // decode once per image; the same screenshot shows up on every replay
          const key = src.data.length + ':' + src.data.slice(0, 48) + src.data.slice(-48);
          let url = self.imgs.get(key);
          if (!url) {
            const bin = atob(src.data);
            const buf = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
            url = URL.createObjectURL(new Blob([buf], { type: src.media_type }));
            self.imgs.set(key, url);
          }
          return url;
        },
      };
    }

    // list scans never overlap (the meta cache is not re-entrant)
    list({ all, more } = {}) {
      if (!this.ready) return Promise.reject(new Error('not-connected'));
      const job = this.chain.then(() => core.listSessions(this.adapter, this.metaCache, all ? new Set(['*']) : new Set(more || [])));
      this.chain = job.catch(() => {});
      return job;
    }

    // live view: re-read the file every second and pass on what was appended
    open(ref, h) {
      let offset = 0, closed = false, busy = false, first = true;
      const pump = async () => {
        if (closed || busy || !this.ready) return;
        busy = true;
        try {
          const r = await this.adapter.readLines(ref, offset);
          if (closed) return;
          if (r.reset) h.reset();
          offset = r.offset;
          for (let i = 0; i < r.lines.length && !closed; i += 400) {
            const ev = r.lines.slice(i, i + 400).flatMap((l) => core.convert(l, !!ref.agent, this.adapter.storeImage));
            if (ev.length) h.events(ev);
            await new Promise((res) => setTimeout(res, 0));
          }
          if (first && !closed) { first = false; h.ready(); }
        } finally {
          busy = false;
        }
      };
      h.reset();
      pump();
      const iv = setInterval(pump, 1000);
      return { close() { closed = true; clearInterval(iv); } };
    }
  }

  window.MarsadSource = {
    isLocalServer,
    create: () => (isLocalServer ? new ServerSource() : new FolderSource()),
  };
})();
