'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const hookInstall = require('../lib/hook-install.js');

const HOOK = path.join(__dirname, '..', 'lib', 'hook.js');
const BIN = path.join(__dirname, '..', 'bin', 'marsad.js');
const mkHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'marsad-hook-'));
const envFor = (home) => ({ ...process.env, HOME: home, USERPROFILE: home });
const pendingFile = (home, id) => path.join(home, '.marsad', 'pending', id + '.json');

// ---------- the hook script ----------
function runHook(home, payload, raw) {
  return spawnSync(process.execPath, [HOOK], { input: raw !== undefined ? raw : JSON.stringify(payload), env: envFor(home), encoding: 'utf8' });
}
const ask = { hook_event_name: 'PreToolUse', session_id: 'sess-1', tool_name: 'AskUserQuestion', tool_use_id: 'tu1', transcript_path: '/t.jsonl', tool_input: { questions: [{ question: 'Which?', options: [{ label: 'A' }] }] } };

test('hook: PreToolUse on AskUserQuestion writes a private pending file and prints nothing', () => {
  const home = mkHome();
  const r = runHook(home, ask);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(r.stderr, '');
  const f = pendingFile(home, 'sess-1');
  const p = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.strictEqual(p.tool, 'AskUserQuestion');
  assert.strictEqual(p.id, 'tu1');
  assert.strictEqual(p.input.questions[0].question, 'Which?');
  assert.ok(Math.abs(p.at - Date.now()) < 60e3);
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(path.dirname(f)).mode & 0o777, 0o700);
  }
  assert.deepStrictEqual(fs.readdirSync(path.dirname(f)), ['sess-1.json'], 'no tmp file left behind');
  assert.ok(!fs.existsSync(path.join(home, '.claude')), 'nothing is written inside ~/.claude');
});

test('hook: every other event clears the pending file', () => {
  for (const ev of [{ hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion' }, { hook_event_name: 'PostToolUseFailure', tool_name: 'ExitPlanMode' }, { hook_event_name: 'Stop' }, { hook_event_name: 'UserPromptSubmit' }]) {
    const home = mkHome();
    runHook(home, ask);
    assert.ok(fs.existsSync(pendingFile(home, 'sess-1')));
    const r = runHook(home, { session_id: 'sess-1', ...ev });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
    assert.ok(!fs.existsSync(pendingFile(home, 'sess-1')), ev.hook_event_name);
  }
});

test('hook: PreToolUse for other tools does not write, and ExitPlanMode does', () => {
  const home = mkHome();
  runHook(home, { ...ask, tool_name: 'Bash' });
  assert.ok(!fs.existsSync(pendingFile(home, 'sess-1')));
  runHook(home, { ...ask, tool_name: 'ExitPlanMode', tool_input: { plan: '# Plan' } });
  assert.strictEqual(JSON.parse(fs.readFileSync(pendingFile(home, 'sess-1'), 'utf8')).input.plan, '# Plan');
});

test('hook: bad input never fails, prints nothing and cannot escape the pending dir', () => {
  const home = mkHome();
  for (const raw of ['not json', '', '{}', JSON.stringify({ ...ask, session_id: '../../evil' })]) {
    const r = runHook(home, null, raw);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
  }
  assert.ok(!fs.existsSync(path.join(home, '.marsad', 'evil.json')));
  assert.ok(!fs.existsSync(path.join(home, 'evil.json')));
});

// ---------- installer ----------
const settingsOf = (home) => path.join(home, '.claude', 'settings.json');
const scriptOf = (home) => path.join(home, '.marsad', 'hooks', 'pending-ask.js');
const readSettings = (home) => JSON.parse(fs.readFileSync(settingsOf(home), 'utf8'));
function writeSettings(home, obj, text) {
  fs.mkdirSync(path.dirname(settingsOf(home)), { recursive: true });
  fs.writeFileSync(settingsOf(home), text !== undefined ? text : JSON.stringify(obj, null, 2) + '\n');
}
const other = () => ({
  model: 'opus',
  permissions: { allow: ['Bash(ls)'] },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other-tool pre' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'other-tool stop', timeout: 10 }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: 'other-tool start' }] }],
  },
});
const ownCmds = (obj) => Object.values(obj.hooks || {}).flat().flatMap((g) => g.hooks).filter((h) => h.command.includes('pending-ask.js'));

test('install: adds only its own entries next to other hooks and keeps every other key', () => {
  const home = mkHome();
  writeSettings(home, other());
  const r = hookInstall.install({ home });
  assert.strictEqual(r.changed, true);
  const s = readSettings(home);
  const o = other();
  assert.strictEqual(s.model, 'opus');
  assert.deepStrictEqual(s.permissions, o.permissions);
  assert.deepStrictEqual(s.hooks.SessionStart, o.hooks.SessionStart);
  assert.deepStrictEqual(s.hooks.PreToolUse[0], o.hooks.PreToolUse[0]);
  assert.deepStrictEqual(s.hooks.Stop[0], o.hooks.Stop[0]);
  const cmd = `node "${scriptOf(home)}"`;
  assert.deepStrictEqual(s.hooks.PreToolUse[1], { matcher: 'AskUserQuestion|ExitPlanMode', hooks: [{ type: 'command', command: cmd, timeout: 5 }] });
  assert.deepStrictEqual(s.hooks.PostToolUse, [{ matcher: 'AskUserQuestion|ExitPlanMode', hooks: [{ type: 'command', command: cmd, timeout: 5 }] }]);
  assert.strictEqual(s.hooks.PostToolUseFailure[0].matcher, 'AskUserQuestion|ExitPlanMode');
  assert.deepStrictEqual(s.hooks.Stop[1], { hooks: [{ type: 'command', command: cmd, timeout: 5 }] });
  assert.deepStrictEqual(s.hooks.UserPromptSubmit, [{ hooks: [{ type: 'command', command: cmd, timeout: 5 }] }]);
  assert.strictEqual(ownCmds(s).length, 5);
  // the stable copy of the hook script exists and is the same file
  assert.strictEqual(fs.readFileSync(scriptOf(home), 'utf8'), fs.readFileSync(HOOK, 'utf8'));
  // a backup of the previous settings sits next to settings.json
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(settingsOf(home) + '.marsad-bak', 'utf8')), other());
});

test('install: creates settings.json when there is none, and is idempotent', () => {
  const home = mkHome();
  assert.strictEqual(hookInstall.install({ home }).changed, true);
  const first = fs.readFileSync(settingsOf(home), 'utf8');
  assert.ok(!fs.existsSync(settingsOf(home) + '.marsad-bak'), 'nothing to back up');
  assert.strictEqual(hookInstall.install({ home }).changed, false);
  assert.strictEqual(fs.readFileSync(settingsOf(home), 'utf8'), first);
  assert.strictEqual(ownCmds(readSettings(home)).length, 5);
});

test('install: refuses settings.json that is not valid JSON and leaves it untouched', () => {
  const home = mkHome();
  writeSettings(home, null, '{ "hooks": { oops }');
  assert.throws(() => hookInstall.install({ home }), /not valid JSON/);
  assert.strictEqual(fs.readFileSync(settingsOf(home), 'utf8'), '{ "hooks": { oops }');
  assert.ok(!fs.existsSync(scriptOf(home)));
  assert.throws(() => hookInstall.uninstall({ home }), /not valid JSON/);
  writeSettings(home, null, '{ "hooks": { "Stop": "nope" } }');
  assert.throws(() => hookInstall.install({ home }), /Stop/);
});

test('install: follows a symlinked settings.json instead of replacing the link', { skip: process.platform === 'win32' }, () => {
  const home = mkHome();
  const real = path.join(home, 'dotfiles-settings.json');
  fs.writeFileSync(real, JSON.stringify(other()));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.symlinkSync(real, settingsOf(home));
  hookInstall.install({ home });
  assert.ok(fs.lstatSync(settingsOf(home)).isSymbolicLink());
  assert.strictEqual(ownCmds(JSON.parse(fs.readFileSync(real, 'utf8'))).length, 5);
});

test('uninstall: removes only its own entries and the empty leftovers, never other tools', () => {
  const home = mkHome();
  writeSettings(home, other());
  hookInstall.install({ home });
  const r = hookInstall.uninstall({ home });
  assert.strictEqual(r.changed, true);
  assert.deepStrictEqual(readSettings(home), other());
  assert.ok(!fs.existsSync(scriptOf(home)));
  assert.strictEqual(hookInstall.uninstall({ home }).changed, false);
});

test('uninstall: drops hooks entirely when it was the only user, keeps a shared group\'s other hooks', () => {
  const home = mkHome();
  writeSettings(home, { theme: 'dark' });
  hookInstall.install({ home });
  hookInstall.uninstall({ home });
  assert.deepStrictEqual(readSettings(home), { theme: 'dark' });

  // another tool's entry living in the same group as ours stays
  const cmd = `node "${scriptOf(home)}"`;
  writeSettings(home, { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'keep-me' }, { type: 'command', command: cmd, timeout: 5 }] }], Notification: [] } });
  hookInstall.uninstall({ home });
  assert.deepStrictEqual(readSettings(home), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'keep-me' }] }], Notification: [] } });
});

test('status: reports not installed, installed and partly installed', () => {
  const home = mkHome();
  assert.strictEqual(hookInstall.status({ home }).state, 'not-installed');
  hookInstall.install({ home });
  const st = hookInstall.status({ home });
  assert.strictEqual(st.state, 'installed');
  assert.strictEqual(st.script, scriptOf(home));
  assert.strictEqual(st.settings, settingsOf(home));
  const s = readSettings(home);
  delete s.hooks.Stop;
  writeSettings(home, s);
  const part = hookInstall.status({ home });
  assert.strictEqual(part.state, 'partial');
  assert.deepStrictEqual(part.missing, ['Stop']);
});

// ---------- CLI ----------
test('cli: marsad hook install / status / uninstall against a temp HOME', () => {
  const home = mkHome();
  const run = (...a) => spawnSync(process.execPath, [BIN, 'hook', ...a], { env: envFor(home), encoding: 'utf8' });
  assert.match(run('status').stdout, /not installed/i);
  const i = run('install');
  assert.strictEqual(i.status, 0, i.stderr);
  assert.match(run('status').stdout, new RegExp('installed[\\s\\S]*' + scriptOf(home).replace(/[\\.]/g, '\\$&')));
  assert.strictEqual(run('uninstall').status, 0);
  assert.match(run('status').stdout, /not installed/i);
  const bad = run('frobnicate');
  assert.strictEqual(bad.status, 2);
  assert.match(bad.stderr, /install/);
  writeSettings(home, null, 'nope');
  const refused = run('install');
  assert.strictEqual(refused.status, 1);
  assert.match(refused.stderr, /not valid JSON/);
});

test('cli: -h documents the hook command', () => {
  const r = spawnSync(process.execPath, [BIN, '-h'], { encoding: 'utf8' });
  assert.match(r.stdout, /marsad hook install/);
});
