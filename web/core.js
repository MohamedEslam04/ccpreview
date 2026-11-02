/*
 * ccpreview core: turns Claude Code transcript files (~/.claude/projects/<project>/<session>.jsonl)
 * into compact events for the UI, and builds the session list.
 *
 * Runs unchanged in Node (the `ccpreview` local server) and in the browser (folder mode, where the
 * page reads the folder itself through the File System Access API). Anything environment-specific
 * comes in through an adapter:
 *
 *   adapter.listProjects()              -> Promise<string[]>                       project folder names
 *   adapter.listSessionFiles(dir)       -> Promise<{id, size, mtime}[]>            top-level *.jsonl
 *   adapter.listSubagents(dir, id)      -> Promise<{id, mtime, born, info}[]>      <id>/subagents/agent-*.jsonl
 *   adapter.readLines(ref, offset)      -> Promise<{lines, offset, reset}>         complete lines after byte offset
 *   adapter.storeImage(source)          -> string | null                           URL the page can show
 *
 * `ref` is { dir, id, agent? }. The transcript format is not a public API; keep parsing defensive.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CCPreviewCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PER_PROJECT = 15;
  // Listing sessions only needs a title, a working folder and the turn state, so a first scan reads the
  // start and the end of each transcript (EDGE_BYTES each) instead of the whole file, which can be 100+ MB.
  const EDGE_BYTES = 256 * 1024;
  const META_CONCURRENCY = 8; // transcripts read at once while listing
  // Bump when scanLine / emptyMeta change what they extract: meta saved by an older version is dropped.
  const META_V = 1;
  const MAX_RESULT = 2500;
  const MAX_INPUT = 4000;
  const MAX_DIFF = 30000;
  const IMG_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  const IMAGE_MARK = '\u0000img\u0000'; // placeholder for images inside text; the UI drops it

  const clip = (s, n) => {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n) + `\n… (+${s.length - n} chars)` : s;
  };
  const stripReminders = (s) => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  const dropImageMarks = (s) => s.split(IMAGE_MARK).join('').replace(/\[Image #\d+\]\s*/g, '').trim();

  function textOf(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .map((b) => (b && b.type === 'text' ? b.text : b && b.type === 'image' ? IMAGE_MARK : ''))
      .filter(Boolean)
      .join('\n');
  }

  function cleanPrompt(t) {
    t = stripReminders(t || '');
    const cmd = t.match(/<command-name>([\s\S]*?)<\/command-name>/);
    if (cmd) {
      const args = (t.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1] || '';
      return `${cmd[1].trim()} ${args.trim()}`.trim();
    }
    return t.replace(/<local-command-(stdout|stderr|caveat)>[\s\S]*?<\/local-command-\1>/g, '').trim();
  }

  function toolSummary(input) {
    input = input || {};
    // Bash: the human description reads better than the raw command (the full command is in the details)
    const v = input.description || input.command || input.file_path || input.notebook_path || input.pattern ||
      input.url || input.query || input.skill || input.prompt || '';
    return String(v).split('\n')[0].slice(0, 300);
  }

  function imagesOf(content, storeImage) {
    if (!Array.isArray(content) || !storeImage) return [];
    return content
      .filter((b) => b && b.type === 'image' && b.source)
      .map((b) => {
        const src = b.source;
        if (src.type === 'url') return /^https:\/\//.test(src.url || '') ? src.url : null;
        if (src.type !== 'base64' || !IMG_TYPES.includes(src.media_type) || typeof src.data !== 'string') return null;
        return storeImage(src);
      })
      .filter(Boolean);
  }

  // A tool call. File edits carry old/new text so the UI can draw a diff; TodoWrite / ExitPlanMode
  // carry the todo list / plan so the UI can pin it; AskUserQuestion carries the questions and options.
  function toolEvent(b, ts) {
    const input = b.input || {};
    const ev = { k: 'tool', id: b.id, name: b.name, sum: toolSummary(input), ts };
    const str = (v) => (typeof v === 'string' ? clip(v, MAX_DIFF) : '');
    if (b.name === 'Edit' && typeof input.old_string === 'string') {
      ev.diff = { file: input.file_path || '', edits: [{ old: str(input.old_string), new: str(input.new_string) }], all: !!input.replace_all };
    } else if (b.name === 'MultiEdit' && Array.isArray(input.edits)) {
      ev.diff = { file: input.file_path || '', edits: input.edits.slice(0, 50).map((e) => ({ old: str(e.old_string), new: str(e.new_string) })) };
    } else if (b.name === 'Write' && typeof input.content === 'string') {
      ev.diff = { file: input.file_path || '', write: true, edits: [{ old: '', new: str(input.content) }] };
    } else if (b.name === 'TodoWrite' && Array.isArray(input.todos)) {
      ev.todos = input.todos.slice(0, 100).map((t) => ({ text: String(t.content || t.activeForm || ''), status: String(t.status || 'pending') }));
    } else if (b.name === 'ExitPlanMode' && typeof input.plan === 'string') {
      ev.plan = clip(input.plan, MAX_DIFF);
    } else if (b.name === 'AskUserQuestion' && Array.isArray(input.questions)) {
      ev.ask = input.questions.slice(0, 8).map((q) => ({
        question: String(q.question || ''),
        header: String(q.header || ''),
        multi: !!q.multiSelect,
        options: (Array.isArray(q.options) ? q.options : []).slice(0, 12).map((o) => ({ label: String(o.label || ''), description: String(o.description || '') })),
      }));
    }
    // a command left running in the background (Bash run_in_background, or a Monitor watcher): the full command
    // for the Background bar, since `sum` keeps only the first line of the description
    if ((b.name === 'Bash' && input.run_in_background === true) || b.name === 'Monitor') {
      ev.bg = { cmd: clip(input.command || '', MAX_INPUT), desc: String(input.description || ''), monitor: b.name === 'Monitor' };
    } else if ((b.name === 'TaskStop' || b.name === 'KillShell') && typeof (input.task_id || input.shell_id) === 'string') {
      ev.stop = input.task_id || input.shell_id;
    }
    if (!ev.diff && !ev.ask) ev.input = clip(JSON.stringify(input, null, 2), MAX_INPUT);
    return ev;
  }

  // One transcript line -> zero or more events for the UI.
  // `sidechain` is true for subagent transcripts, where every line is a sidechain line.
  function convert(line, sidechain, storeImage) {
    let o;
    try { o = JSON.parse(line); } catch (e) { return []; }
    if (o.isSidechain && !sidechain) return [];
    const ts = o.timestamp;
    switch (o.type) {
      case 'ai-title':
        return o.aiTitle ? [{ k: 'title', text: o.aiTitle }] : [];
      case 'custom-title':
        return o.customTitle ? [{ k: 'title', text: o.customTitle }] : [];
      case 'attachment': {
        const a = o.attachment || {};
        // a message sent while Claude was working; with a pasted image it's a content-block list, not a string
        if (a.type === 'queued_command' && (typeof a.prompt === 'string' || Array.isArray(a.prompt))) {
          const images = imagesOf(a.prompt, storeImage);
          const { tasks, rest: text } = takeTasks(dropImageMarks(cleanPrompt(textOf(a.prompt))), ts);
          return tasks.concat(text || images.length ? [{ k: 'user', text, ts, queued: true, images: images.length ? images : undefined }] : []);
        }
        return [];
      }
      case 'system': {
        if (o.subtype !== 'compact_boundary') return [];
        const m = o.compactMetadata || {};
        return [{ k: 'divider', ts, pre: m.preTokens || 0, post: m.postTokens || 0, trigger: m.trigger || '' }];
      }
      case 'permission-mode':
        return o.permissionMode ? [{ k: 'pmode', v: o.permissionMode }] : [];
      case 'user': {
        if (o.isMeta) return [];
        const c = o.message && o.message.content;
        const out = [];
        if (Array.isArray(c)) {
          for (const b of c) {
            if (b && b.type === 'tool_result') {
              const tr = o.toolUseResult;
              const agent = tr && typeof tr === 'object' && typeof tr.agentId === 'string' ? tr.agentId : undefined;
              const images = imagesOf(b.content, storeImage);
              const text = clip(stripReminders(dropImageMarks(textOf(b.content))), MAX_RESULT);
              // AskUserQuestion: the chosen answers, when Claude Code records them
              const answers = tr && typeof tr === 'object' && tr.answers && typeof tr.answers === 'object' ? tr.answers : undefined;
              // starting a background command / monitor answers with the id its output file is named after
              const task = tr && typeof tr === 'object' ? tr.backgroundTaskId || tr.taskId : undefined;
              out.push({ k: 'result', id: b.tool_use_id, err: !!b.is_error, agent, text, answers, images: images.length ? images : undefined,
                task: typeof task === 'string' ? task : undefined });
            }
          }
        }
        if (!out.length) {
          const images = imagesOf(c, storeImage);
          const { tasks, rest: text } = takeTasks(dropImageMarks(cleanPrompt(textOf(c))), ts);
          out.push(...tasks);
          if (text || images.length) out.push({ k: text.startsWith('<') ? 'note' : 'user', text, ts, images: images.length ? images : undefined });
        }
        // working folder / git branch over time, for the info panel (added last: the check above relies on out.length)
        if (o.cwd) out.push({ k: 'ctx', cwd: o.cwd, branch: o.gitBranch || '', ts });
        return out;
      }
      case 'assistant': {
        const c = o.message && o.message.content;
        if (!Array.isArray(c)) return [];
        const out = [];
        // token usage + model for the session info panel (one API message spans several lines; the UI dedupes by id)
        const u = o.message.usage;
        if (u && o.message.id) {
          out.push({ k: 'usage', mid: o.message.id, model: o.message.model || '', ts, eff: o.perTurnEffort || o.effort || '',
            u: { i: u.input_tokens || 0, o: u.output_tokens || 0, cr: u.cache_read_input_tokens || 0, cw: u.cache_creation_input_tokens || 0 } });
        }
        for (const b of c) {
          if (!b) continue;
          if (b.type === 'text' && b.text && b.text.trim()) out.push({ k: 'text', text: b.text, ts });
          // With thinkingDisplay "updates", the short progress notes you see in the terminal are stored as
          // thinking blocks. Show them like replies; other non-empty thinking goes in a collapsed block.
          else if (b.type === 'thinking' && b.thinking && b.thinking.trim()) {
            out.push(o.thinkingDisplay === 'updates' ? { k: 'text', text: b.thinking, ts, update: true } : { k: 'thinking', text: clip(b.thinking, MAX_DIFF), ts });
          }
          else if (b.type === 'tool_use') out.push(toolEvent(b, ts));
        }
        return out;
      }
      default:
        return [];
    }
  }

  // Claude Code reports a finished background command, agent or monitor event as a <task-notification> block
  // inside a message (queued while it works, or a user line with origin task-notification). The terminal shows
  // its <summary> as one line; so do we. Only blocks at the start of the message count: a prompt that merely
  // mentions the tag stays the user's text, and an unclosed block isn't guessed at.
  const TASK_HEAD = /^\s*<task-notification>([\s\S]*?)<\/task-notification>/;
  const tagIn = (body, tag) => { const m = body.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)); return m ? m[1].trim() : ''; };
  // A subagent's final report (or a message from another Claude session) arrives as an <agent-message> block,
  // not as something the user typed. The harness indents every line of the report and puts a warning frame in
  // front of it; the terminal shows it as a short line, so do we: the frame is dropped, the report de-indented.
  const AGENT_HEAD = /^\s*(?:Another Claude session sent a message:\s*)?<agent-message(?:\s+from="([^"]*)")?>([\s\S]*?)<\/agent-message>/;
  const HAND_BACK = /^\s*\[Subagent hand-back\][^\n]*?The report follows:[ \t]*\n?/;
  function agentMessage(m, ts) {
    let body = m[2];
    const sub = HAND_BACK.test(body);
    body = body.replace(HAND_BACK, '').replace(/^ {2}/gm, '').trim();
    return { k: 'agentmsg', ts, from: m[1] || '', sub, detail: clip(body, MAX_RESULT * 4) };
  }
  function takeTasks(text, ts) {
    const tasks = [];
    for (;;) {
      const t = TASK_HEAD.exec(text);
      const a = t ? null : AGENT_HEAD.exec(text);
      if (!t && !a) break;
      if (a) tasks.push(agentMessage(a, ts));
      else {
        const b = t[1];
        tasks.push({ k: 'task', ts, status: tagIn(b, 'status'), summary: tagIn(b, 'summary'), taskId: tagIn(b, 'task-id'),
          detail: clip(tagIn(b, 'result') || tagIn(b, 'event'), MAX_RESULT) });
      }
      text = text.slice((t || a)[0].length);
    }
    return { tasks, rest: text.trim() };
  }

  // The files a shell command touches, for the Background view: `> f`, `>> f`, `tee f` write; `< f` and the file
  // arguments of tail / cat / grep & co read; any other path is only mentioned. A heuristic on the command text
  // (no shell parsing): anything held in a variable is missed, /dev/* is left out.
  const READ_VERBS = new Set(['tail', 'cat', 'head', 'less', 'more', 'grep', 'egrep', 'rg', 'wc', 'sort', 'jq', 'diff', 'source', 'sed', 'awk']);
  const PATH_RE = /(>>?|&>>?|\btee(?:\s+-a)?\s+|<)?[ \t]*((?:~|\.{1,2})?\/[^\s"'`;|&<>()$,]+)/g;
  function cmdPaths(cmd) {
    const found = new Map();
    for (const seg of String(cmd || '').split(/[|;&\n]+/)) {
      const words = seg.trim().split(/\s+/).filter((w) => !/^\w+=/.test(w));
      const reads = READ_VERBS.has((words[0] || '').replace(/^.*\//, ''));
      for (const m of seg.matchAll(PATH_RE)) {
        const path = m[2].replace(/[.:]+$/, '');
        if (path.length < 2 || path.startsWith('/dev/')) continue;
        const mode = m[1] ? (m[1] === '<' ? 'r' : 'w') : reads ? 'r' : '';
        const old = found.get(path);
        if (!old || (mode === 'w' && old !== 'w') || (mode === 'r' && !old)) found.set(path, mode);
      }
    }
    return [...found].map(([path, mode]) => ({ path, mode }));
  }

  // ---------- session metadata (title, first prompt, cwd, turn state), updated incrementally ----------
  const emptyMeta = () => ({ offset: 0, title: '', custom: false, prompt: '', cwd: '', state: '' });

  function scanLine(m, l) {
    // turn state for notifications: working -> idle (turn ended) or asking (waiting on you)
    if (!l.startsWith('{"type":"api-request') && !l.startsWith('{"type":"file-history')) {
      if (l.includes('"subtype":"stop_hook_summary"') || l.includes('"subtype":"turn_duration"')) m.state = 'idle';
      else if (l.includes('"type":"user","message"') && !l.includes('"isSidechain":true')) m.state = 'working';
      else if (l.includes('"type":"tool_use"') && !l.includes('"isSidechain":true') &&
               (l.includes('"name":"AskUserQuestion"') || l.includes('"name":"ExitPlanMode"'))) m.state = 'asking';
    }
    if (l.length < 4000 && (l.includes('"type":"ai-title"') || l.includes('"type":"custom-title"'))) {
      try {
        const o = JSON.parse(l);
        if (o.customTitle) { m.title = o.customTitle; m.custom = true; }
        else if (o.aiTitle && !m.custom) m.title = o.aiTitle;
      } catch (e) { /* partial or odd line */ }
      return;
    }
    if (!m.cwd) {
      const c = l.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
      if (c) { try { m.cwd = JSON.parse(`"${c[1]}"`); } catch (e) { /* ignore */ } }
    }
    if (!m.prompt && l.length < 300000 && l.includes('"type":"user"') && !l.includes('"isMeta":true') &&
        !l.includes('"tool_use_id"') && !l.includes('"isSidechain":true')) {
      try {
        const t = dropImageMarks(cleanPrompt(textOf(JSON.parse(l).message.content)));
        if (t && !t.startsWith('<')) m.prompt = t.split('\n')[0].slice(0, 120);
      } catch (e) { /* ignore */ }
    }
  }

  const yieldNow = () => new Promise((r) => setTimeout(r, 0));

  async function scanLines(m, lines) {
    for (let i = 0; i < lines.length; i++) {
      if (i % 2000 === 1999) await yieldNow(); // keep the page / server responsive on huge files
      scanLine(m, lines[i]);
    }
  }

  // The complete lines at the start and at the end of a big file, given its first and last bytes and its size,
  // plus the offset right after the last complete line (where an incremental read can pick up). A tail that
  // holds no line break can't be split safely: null, and the caller reads the whole file.
  function edgeLines(head, tail, size) {
    const nl = tail.indexOf(10);
    if (nl < 0) return null; // the first tail line is a fragment, dropped: it may start before the window
    const decoder = new TextDecoder();
    const t = splitLines(tail.subarray(nl + 1), decoder);
    const lines = splitLines(head, decoder).lines.concat(t.lines);
    return lines.length ? { lines, offset: size - tail.length + nl + 1 + t.used } : null;
  }

  async function updateMeta(adapter, cache, ref) {
    const key = `${ref.dir}/${ref.id}`;
    let m = cache.get(key);
    if (!m) {
      cache.set(key, (m = emptyMeta()));
      // first sight of a big transcript: its start (first prompt, folder) and end (title, state) are enough
      const e = adapter.readEdges ? await adapter.readEdges(ref, EDGE_BYTES) : null;
      if (e) {
        await scanLines(m, e.lines);
        m.offset = e.offset;
        if (m.title || m.prompt) return m;
        Object.assign(m, emptyMeta()); // nothing to show in the edges: read the whole file below
      }
    }
    const r = await adapter.readLines(ref, m.offset);
    if (r.reset) Object.assign(m, emptyMeta());
    m.offset = r.offset;
    await scanLines(m, r.lines);
    return m;
  }

  // map with at most `limit` calls in flight; results keep the input order
  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }

  // The meta cache as plain data (to keep it between page loads) and back. Anything that doesn't look
  // exactly right is dropped, and a cache from another META_V is ignored: it is only a speed-up.
  const packMeta = (cache) => ({ v: META_V, entries: [...cache] });
  function unpackMeta(cache, data) {
    if (!data || data.v !== META_V || !Array.isArray(data.entries)) return 0;
    let n = 0;
    for (const e of data.entries) {
      const m = Array.isArray(e) && typeof e[0] === 'string' ? e[1] : null;
      if (!m || !Number.isSafeInteger(m.offset) || m.offset < 0 || typeof m.custom !== 'boolean' ||
          ['title', 'prompt', 'cwd', 'state'].some((k) => typeof m[k] !== 'string')) continue;
      cache.set(e[0], { offset: m.offset, title: m.title, custom: m.custom, prompt: m.prompt, cwd: m.cwd, state: m.state });
      n++;
    }
    return n;
  }

  const basename = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop();

  // The session list, newest project first. `more`: project folders to list in full ('*' = all);
  // the others get their latest PER_PROJECT sessions.
  // `onProgress(projects)` is called with the list so far each time another project is done (newest first),
  // so a first load can show something before the whole scan ends.
  async function listSessions(adapter, cache, more, onProgress) {
    more = more instanceof Set ? more : new Set(more || []);
    // directory listings first (cheap), so projects can then be scanned newest first
    const listed = (await mapLimit(await adapter.listProjects(), META_CONCURRENCY, async (dir) => ({
      dir, files: (await adapter.listSessionFiles(dir)).sort((a, b) => b.mtime - a.mtime),
    }))).filter((x) => x.files.length);
    listed.sort((a, b) => b.files[0].mtime - a.files[0].mtime);
    const projects = [];
    for (const { dir, files } of listed) {
      const rows = await mapLimit(more.has('*') || more.has(dir) ? files : files.slice(0, PER_PROJECT), META_CONCURRENCY, async (f) => {
        const m = await updateMeta(adapter, cache, { dir, id: f.id });
        if (!(m.title || m.prompt)) return null; // nothing typed yet
        const agents = (await adapter.listSubagents(dir, f.id)).map((a) => ({
          id: a.id, mtime: a.mtime, born: a.born,
          description: (a.info && a.info.description) || '', type: (a.info && a.info.agentType) || '',
          model: (a.info && a.info.model) || '', toolUseId: (a.info && a.info.toolUseId) || '', finished: !!(a.info && a.info.finished),
          worktree: (a.info && a.info.worktreePath) || '', worktreeBranch: (a.info && a.info.worktreeBranch) || '',
          background: !!(a.info && a.info.requestShape === 'background'),
        })).sort((a, b) => a.born - b.born);
        const active = Math.max(f.mtime, ...agents.map((a) => a.mtime));
        return { id: f.id, mtime: f.mtime, size: f.size, active, title: m.title || m.prompt, cwd: m.cwd, agents, state: m.state || 'idle' };
      });
      const sessions = rows.filter(Boolean);
      if (!sessions.length) continue;
      const cwd = (sessions.find((s) => s.cwd) || {}).cwd || dir;
      const wt = dir.split('-claude-worktrees-')[1]; // sessions started inside a git worktree
      projects.push({ dir, cwd, name: basename(cwd) + (wt ? ` · ${wt}` : ''), mtime: files[0].mtime, total: files.length, sessions });
      if (onProgress) onProgress(projects.slice());
    }
    projects.sort((a, b) => b.mtime - a.mtime);
    return projects;
  }

  // Split a byte chunk into complete UTF-8 lines; returns the lines and how many bytes they used.
  function splitLines(bytes, decoder) {
    const lines = [];
    let start = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 10) {
        if (i > start) lines.push(decoder.decode(bytes.subarray(start, i)));
        start = i + 1;
      }
    }
    return { lines, used: start };
  }

  // Valid path parts (folder / session / subagent ids) — never let a "../" through.
  const SAFE_DIR = /^[\w.-]+$/;
  const SAFE_ID = /^[\w-]+$/;
  const safeDir = (d) => typeof d === 'string' && SAFE_DIR.test(d) && !d.startsWith('.');
  const safeId = (d) => typeof d === 'string' && SAFE_ID.test(d);

  // The question the optional hook reports as waiting is already on screen when the transcript
  // holds the same AskUserQuestion call unanswered (newer Claude Code writes it before you answer).
  // A plan waiting for approval keeps its own card: the transcript only lists it as a tool call.
  const pendingInTranscript = (p, unanswered) => !!(p && p.tool === 'AskUserQuestion' && p.id && unanswered.has(p.id));

  return {
    PER_PROJECT, EDGE_BYTES, META_CONCURRENCY, META_V, convert, toolEvent, toolSummary, textOf, cleanPrompt, stripReminders,
    updateMeta, listSessions, cmdPaths, edgeLines, mapLimit, packMeta, unpackMeta, splitLines, safeDir, safeId, basename, pendingInTranscript,
  };
});
