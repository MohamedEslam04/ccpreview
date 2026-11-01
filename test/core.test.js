'use strict';
const test = require('node:test');
const assert = require('node:assert');
const core = require('../web/core.js');

const line = (o) => JSON.stringify(o);
const fakeStore = (src) => `img:${src.media_type}:${src.data.length}`;
const PNG = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };

test('convert: ignores invalid JSON and unknown types', () => {
  assert.deepStrictEqual(core.convert('not json', false), []);
  assert.deepStrictEqual(core.convert(line({ type: 'file-history-snapshot' }), false), []);
});

test('convert: user prompt as string', () => {
  const ev = core.convert(line({ type: 'user', timestamp: 't1', message: { role: 'user', content: 'hello' } }), false);
  assert.deepStrictEqual(ev, [{ k: 'user', text: 'hello', ts: 't1', images: undefined }]);
});

test('convert: user prompt as block array with an image', () => {
  const content = [{ type: 'text', text: 'look [Image #1]' }, PNG];
  const [ev] = core.convert(line({ type: 'user', timestamp: 't', message: { content } }), false, fakeStore);
  assert.strictEqual(ev.k, 'user');
  assert.strictEqual(ev.text, 'look');
  assert.deepStrictEqual(ev.images, ['img:image/png:4']);
});

test('convert: image-only prompt still yields an event', () => {
  const [ev] = core.convert(line({ type: 'user', message: { content: [PNG] } }), false, fakeStore);
  assert.strictEqual(ev.text, '');
  assert.strictEqual(ev.images.length, 1);
});

test('convert: unsupported image types are dropped', () => {
  const bad = { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: 'AAAA' } };
  const [ev] = core.convert(line({ type: 'user', message: { content: [{ type: 'text', text: 'x' }, bad] } }), false, fakeStore);
  assert.strictEqual(ev.images, undefined);
});

test('convert: queued_command attachment with image blocks', () => {
  const o = { type: 'attachment', timestamp: 't', attachment: { type: 'queued_command', prompt: [{ type: 'text', text: 'also this' }, PNG] } };
  const [ev] = core.convert(line(o), false, fakeStore);
  assert.strictEqual(ev.k, 'user');
  assert.strictEqual(ev.queued, true);
  assert.strictEqual(ev.text, 'also this');
  assert.deepStrictEqual(ev.images, ['img:image/png:4']);
});

test('convert: queued_command with a plain string, other attachments ignored', () => {
  const [ev] = core.convert(line({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'next' } }), false);
  assert.strictEqual(ev.text, 'next');
  assert.deepStrictEqual(core.convert(line({ type: 'attachment', attachment: { type: 'hook_success' } }), false), []);
});

test('convert: assistant text and empty text', () => {
  const o = { type: 'assistant', timestamp: 't', message: { content: [{ type: 'text', text: 'hi' }, { type: 'text', text: '  ' }] } };
  assert.deepStrictEqual(core.convert(line(o), false), [{ k: 'text', text: 'hi', ts: 't' }]);
});

test('convert: thinking with thinkingDisplay "updates" becomes a text event', () => {
  const block = { type: 'thinking', thinking: 'checking the config' };
  const upd = core.convert(line({ type: 'assistant', thinkingDisplay: 'updates', message: { content: [block] } }), false);
  assert.strictEqual(upd[0].k, 'text');
  assert.strictEqual(upd[0].update, true);
  const plain = core.convert(line({ type: 'assistant', message: { content: [block] } }), false);
  assert.strictEqual(plain[0].k, 'thinking');
});

test('convert: Edit tool_use carries a diff', () => {
  const b = { type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: '/a.js', old_string: 'a', new_string: 'b', replace_all: true } };
  const [ev] = core.convert(line({ type: 'assistant', message: { content: [b] } }), false);
  assert.strictEqual(ev.k, 'tool');
  assert.strictEqual(ev.id, 'tu1');
  assert.deepStrictEqual(ev.diff, { file: '/a.js', edits: [{ old: 'a', new: 'b' }], all: true });
  assert.strictEqual(ev.input, undefined);
});

test('convert: Write tool_use is a diff with write=true', () => {
  const b = { type: 'tool_use', id: 'w', name: 'Write', input: { file_path: '/n.txt', content: 'x' } };
  const [ev] = core.convert(line({ type: 'assistant', message: { content: [b] } }), false);
  assert.strictEqual(ev.diff.write, true);
  assert.deepStrictEqual(ev.diff.edits, [{ old: '', new: 'x' }]);
});

test('convert: TodoWrite carries todos', () => {
  const todos = [{ content: 'one', status: 'completed', activeForm: 'doing one' }, { activeForm: 'two' }];
  const b = { type: 'tool_use', id: 't', name: 'TodoWrite', input: { todos } };
  const [ev] = core.convert(line({ type: 'assistant', message: { content: [b] } }), false);
  assert.deepStrictEqual(ev.todos, [{ text: 'one', status: 'completed' }, { text: 'two', status: 'pending' }]);
});

test('convert: ExitPlanMode carries the plan', () => {
  const b = { type: 'tool_use', id: 'p', name: 'ExitPlanMode', input: { plan: '# Plan\n1. do it' } };
  const [ev] = core.convert(line({ type: 'assistant', message: { content: [b] } }), false);
  assert.strictEqual(ev.plan, '# Plan\n1. do it');
});

test('convert: AskUserQuestion carries questions and options', () => {
  const input = { questions: [{ question: 'Which?', header: 'Pick', multiSelect: true, options: [{ label: 'A', description: 'first' }, { label: 'B' }] }] };
  const b = { type: 'tool_use', id: 'q', name: 'AskUserQuestion', input };
  const [ev] = core.convert(line({ type: 'assistant', message: { content: [b] } }), false);
  assert.deepStrictEqual(ev.ask, [{
    question: 'Which?', header: 'Pick', multi: true,
    options: [{ label: 'A', description: 'first' }, { label: 'B', description: '' }],
  }]);
});

test('convert: tool_result with toolUseResult.agentId links the subagent', () => {
  const o = {
    type: 'user',
    toolUseResult: { agentId: 'abc123' },
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu9', content: [{ type: 'text', text: 'done' }] }] },
  };
  const [ev] = core.convert(line(o), false);
  assert.strictEqual(ev.k, 'result');
  assert.strictEqual(ev.id, 'tu9');
  assert.strictEqual(ev.agent, 'abc123');
  assert.strictEqual(ev.text, 'done');
  assert.strictEqual(ev.err, false);
});

test('convert: tool_result error flag and AskUserQuestion answers', () => {
  const o = {
    type: 'user',
    toolUseResult: { answers: { 'Which?': 'A' } },
    message: { content: [{ type: 'tool_result', tool_use_id: 'q', is_error: true, content: 'boom' }] },
  };
  const [ev] = core.convert(line(o), false);
  assert.strictEqual(ev.err, true);
  assert.deepStrictEqual(ev.answers, { 'Which?': 'A' });
});

test('convert: sidechain lines are dropped in the main transcript, kept in a subagent one', () => {
  const o = { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'sub' }] } };
  assert.deepStrictEqual(core.convert(line(o), false), []);
  assert.strictEqual(core.convert(line(o), true)[0].text, 'sub');
});

test('convert: strips system-reminder blocks', () => {
  const text = 'real question\n<system-reminder>secret hint</system-reminder>';
  const [ev] = core.convert(line({ type: 'user', message: { content: text } }), false);
  assert.strictEqual(ev.text, 'real question');
  assert.strictEqual(core.stripReminders('<system-reminder>x</system-reminder>'), '');
});

test('convert: slash command becomes "/name args"', () => {
  const text = '<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>PR 12</command-args>';
  const [ev] = core.convert(line({ type: 'user', message: { content: text } }), false);
  assert.strictEqual(ev.text, '/review PR 12');
});

test('convert: meta lines, titles and compaction', () => {
  assert.deepStrictEqual(core.convert(line({ type: 'user', isMeta: true, message: { content: 'x' } }), false), []);
  assert.deepStrictEqual(core.convert(line({ type: 'ai-title', aiTitle: 'T' }), false), [{ k: 'title', text: 'T' }]);
  assert.deepStrictEqual(core.convert(line({ type: 'custom-title', customTitle: 'C' }), false), [{ k: 'title', text: 'C' }]);
  assert.strictEqual(core.convert(line({ type: 'system', subtype: 'compact_boundary', timestamp: 't' }), false)[0].k, 'divider');
});

test('convert: compact_boundary carries the token counts and trigger', () => {
  const [ev] = core.convert(line({ type: 'system', subtype: 'compact_boundary', timestamp: 't', compactMetadata: { trigger: 'auto', preTokens: 170000, postTokens: 12000 } }), false);
  assert.deepStrictEqual(ev, { k: 'divider', ts: 't', pre: 170000, post: 12000, trigger: 'auto' });
  const [bare] = core.convert(line({ type: 'system', subtype: 'compact_boundary', timestamp: 't' }), false);
  assert.deepStrictEqual(bare, { k: 'divider', ts: 't', pre: 0, post: 0, trigger: '' });
});

test('convert: permission-mode lines become a pmode event', () => {
  assert.deepStrictEqual(core.convert(line({ type: 'permission-mode', permissionMode: 'auto' }), false), [{ k: 'pmode', v: 'auto' }]);
  assert.deepStrictEqual(core.convert(line({ type: 'permission-mode' }), false), []);
});

test('convert: usage events carry the effort', () => {
  const mk = (extra) => line({ type: 'assistant', timestamp: 't', ...extra, message: { id: 'm1', model: 'x', usage: { input_tokens: 1 }, content: [] } });
  assert.strictEqual(core.convert(mk({ perTurnEffort: 'high', effort: 'low' }), false)[0].eff, 'high');
  assert.strictEqual(core.convert(mk({ effort: 'low' }), false)[0].eff, 'low');
  assert.strictEqual(core.convert(mk({}), false)[0].eff, '');
});

test('splitLines: keeps a partial trailing line for the next read', () => {
  const dec = new TextDecoder();
  const bytes = Buffer.from('{"a":1}\n{"b":2}\n{"c"');
  const r = core.splitLines(bytes, dec);
  assert.deepStrictEqual(r.lines, ['{"a":1}', '{"b":2}']);
  assert.strictEqual(r.used, Buffer.byteLength('{"a":1}\n{"b":2}\n'));
});

test('splitLines: counts bytes, not characters, for multibyte UTF-8', () => {
  const dec = new TextDecoder();
  const first = '{"t":"مرصد ✓"}';
  const bytes = Buffer.from(first + '\n{"t":"نصف');
  const r = core.splitLines(bytes, dec);
  assert.deepStrictEqual(r.lines, [first]);
  assert.strictEqual(r.used, Buffer.byteLength(first + '\n'));
  assert.ok(r.used > (first + '\n').length);
});

test('splitLines: skips empty lines', () => {
  const r = core.splitLines(Buffer.from('a\n\n\nb\n'), new TextDecoder());
  assert.deepStrictEqual(r.lines, ['a', 'b']);
});

test('safeDir rejects traversal and hidden names', () => {
  for (const bad of ['..', '.', '.hidden', 'a/b', 'a\\b', '', '../x', null, undefined, 5]) {
    assert.strictEqual(core.safeDir(bad), false, String(bad));
  }
  assert.strictEqual(core.safeDir('-home-me-project'), true);
  assert.strictEqual(core.safeDir('proj.v2'), true);
});

test('safeId rejects traversal and separators', () => {
  for (const bad of ['..', '.hidden', 'a/b', 'a.b', '', null]) {
    assert.strictEqual(core.safeId(bad), false, String(bad));
  }
  assert.strictEqual(core.safeId('0f3a-bc12'), true);
});

// ---------- listSessions with an in-memory adapter ----------
function memAdapter(projects) {
  // projects: { dir: { sessionId: { mtime, lines: [objects|strings], agents?: [] } } }
  const enc = (l) => (typeof l === 'string' ? l : JSON.stringify(l));
  return {
    async listProjects() { return Object.keys(projects); },
    async listSessionFiles(dir) {
      return Object.entries(projects[dir]).map(([id, s]) => ({ id, size: 1, mtime: s.mtime }));
    },
    async listSubagents(dir, id) { return projects[dir][id].agents || []; },
    async readLines(ref, offset) {
      const all = projects[ref.dir][ref.id].lines.map(enc);
      return { lines: all.slice(offset), offset: all.length, reset: false };
    },
    storeImage: () => null,
  };
}
// Real transcripts put "type":"user","message" next to each other (scanLine matches on that text), with cwd earlier.
const userLine = (text) => ({ cwd: '/home/me/app', type: 'user', message: { role: 'user', content: text } });

test('listSessions: title from ai-title, falls back to the first prompt', async () => {
  const ad = memAdapter({
    p1: {
      titled: { mtime: 2000, lines: [userLine('first prompt'), { type: 'ai-title', aiTitle: 'Nice title' }] },
      plain: { mtime: 1000, lines: [userLine('only a prompt\nsecond line')] },
      empty: { mtime: 500, lines: [{ type: 'file-history-snapshot' }] },
    },
  });
  const [p] = await core.listSessions(ad, new Map());
  assert.strictEqual(p.name, 'app');
  assert.strictEqual(p.cwd, '/home/me/app');
  assert.deepStrictEqual(p.sessions.map((s) => [s.id, s.title]), [['titled', 'Nice title'], ['plain', 'only a prompt']]);
  assert.strictEqual(p.total, 3);
});

test('listSessions: custom title wins over ai-title', async () => {
  const ad = memAdapter({
    p: { s: { mtime: 1, lines: [userLine('x'), { type: 'custom-title', customTitle: 'Mine' }, { type: 'ai-title', aiTitle: 'Auto' }] } },
  });
  const [p] = await core.listSessions(ad, new Map());
  assert.strictEqual(p.sessions[0].title, 'Mine');
});

test('listSessions: state is working, idle or asking', async () => {
  const ask = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'q', name: 'AskUserQuestion', input: { questions: [] } }] } };
  const ad = memAdapter({
    p: {
      working: { mtime: 3, lines: [userLine('go')] },
      idle: { mtime: 2, lines: [userLine('go'), { type: 'system', subtype: 'turn_duration' }] },
      asking: { mtime: 1, lines: [userLine('go'), ask] },
    },
  });
  const [p] = await core.listSessions(ad, new Map());
  const st = Object.fromEntries(p.sessions.map((s) => [s.id, s.state]));
  assert.deepStrictEqual(st, { working: 'working', idle: 'idle', asking: 'asking' });
});

test('listSessions: PER_PROJECT limit, and more=["*"] lists everything', async () => {
  const sessions = {};
  const n = core.PER_PROJECT + 5;
  for (let i = 0; i < n; i++) sessions[`s${i}`] = { mtime: i, lines: [userLine(`prompt ${i}`)] };
  const ad = memAdapter({ big: sessions });
  const [limited] = await core.listSessions(ad, new Map());
  assert.strictEqual(limited.sessions.length, core.PER_PROJECT);
  assert.strictEqual(limited.total, n);
  assert.strictEqual(limited.sessions[0].id, `s${n - 1}`); // newest first
  const [all] = await core.listSessions(ad, new Map(), ['*']);
  assert.strictEqual(all.sessions.length, n);
  const [one] = await core.listSessions(ad, new Map(), new Set(['big']));
  assert.strictEqual(one.sessions.length, n);
});

test('listSessions: projects sorted newest first, empty projects skipped, subagents attached', async () => {
  const ad = memAdapter({
    old: { a: { mtime: 100, lines: [userLine('old')] } },
    fresh: {
      b: {
        mtime: 200, lines: [userLine('fresh')],
        agents: [
          { id: 'ag2', mtime: 900, born: 20, info: { description: 'second', agentType: 'Explore', finished: true } },
          { id: 'ag1', mtime: 300, born: 10, info: { description: 'first' } },
        ],
      },
    },
    blank: {},
  });
  const list = await core.listSessions(ad, new Map());
  assert.deepStrictEqual(list.map((p) => p.dir), ['fresh', 'old']);
  const s = list[0].sessions[0];
  assert.deepStrictEqual(s.agents.map((a) => a.id), ['ag1', 'ag2']); // by birth time
  assert.strictEqual(s.agents[1].type, 'Explore');
  assert.strictEqual(s.agents[1].finished, true);
  assert.strictEqual(s.active, 900); // newest of file and subagents
});

test('listSessions: reads incrementally through the meta cache', async () => {
  const lines = [userLine('hello')];
  const proj = { p: { s: { mtime: 1, lines } } };
  const ad = memAdapter(proj);
  const cache = new Map();
  await core.listSessions(ad, cache);
  lines.push({ type: 'ai-title', aiTitle: 'Later title' });
  const [p] = await core.listSessions(ad, cache);
  assert.strictEqual(p.sessions[0].title, 'Later title');
});

test('listSessions: worktree project names get a suffix', async () => {
  const ad = memAdapter({ '-home-me-app--claude-worktrees-feat': { s: { mtime: 1, lines: [userLine('x')] } } });
  const [p] = await core.listSessions(ad, new Map());
  assert.strictEqual(p.name, 'app · feat');
});
