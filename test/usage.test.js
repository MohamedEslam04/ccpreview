'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const usage = require('../lib/usage-install.js');

const TAP = path.join(__dirname, '..', 'lib', 'usage-tap.js');
const mkHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccpreview-usage-'));
// CLAUDE_CONFIG_DIR is cleared so a developer's own setting can never point a test at their real settings.json
delete process.env.CLAUDE_CONFIG_DIR;
const envFor = (home) => ({ ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: '' });
const usageFile = (home) => path.join(home, '.ccpreview', 'usage.json');
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const sample = { model: { id: 'x' }, rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1800000000 }, seven_day: { used_percentage: 41, resets_at: 1800500000 } } };

function runTap(home, input, args = []) {
  return spawnSync(process.execPath, [TAP, ...args], { input: typeof input === 'string' ? input : JSON.stringify(input), env: envFor(home), encoding: 'utf8' });
}

// ---------- the tap script ----------
test('tap: writes a private usage.json from the statusLine input and prints nothing without an original command', () => {
  const home = mkHome();
  const r = runTap(home, sample);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(r.stderr, '');
  const f = usageFile(home);
  const u = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepStrictEqual(u.five_hour, { pct: 23.5, resets_at: 1800000000 });
  assert.deepStrictEqual(u.seven_day, { pct: 41, resets_at: 1800500000 });
  assert.ok(Math.abs(u.ts - Date.now()) < 60e3);
  assert.deepStrictEqual(Object.keys(u).sort(), ['five_hour', 'seven_day', 'ts']);
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(path.dirname(f)).mode & 0o777, 0o700);
  }
  assert.ok(!fs.readdirSync(path.dirname(f)).some((n) => n.endsWith('.tmp')), 'no tmp file left behind');
  assert.ok(!fs.existsSync(path.join(home, '.claude')), 'nothing is written inside ~/.claude');
});

test('tap: a window that is absent is omitted (and overwrites an older value)', () => {
  const home = mkHome();
  runTap(home, sample);
  runTap(home, { rate_limits: { five_hour: { used_percentage: 5, resets_at: 1800000100 } } });
  const u = JSON.parse(fs.readFileSync(usageFile(home), 'utf8'));
  assert.strictEqual(u.five_hour.pct, 5);
  assert.ok(!('seven_day' in u));
});

test('tap: no rate_limits writes nothing', () => {
  const home = mkHome();
  for (const input of [{ model: { id: 'x' } }, { rate_limits: {} }, { rate_limits: { five_hour: { used_percentage: 'lots' } } }]) {
    const r = runTap(home, input);
    assert.strictEqual(r.status, 0);
    assert.ok(!fs.existsSync(usageFile(home)));
  }
});

test('tap: passes the original command through with the same stdin, stdout, stderr and exit code', () => {
  const home = mkHome();
  const raw = JSON.stringify(sample);
  const orig = `node -e "process.stdin.pipe(process.stdout); process.stderr.write('oops'); process.on('exit',()=>process.exitCode=3)"`;
  const r = runTap(home, raw, [b64(orig)]);
  assert.strictEqual(r.stdout, raw, 'original received the same raw stdin');
  assert.strictEqual(r.stderr, 'oops');
  assert.strictEqual(r.status, 3);
  assert.ok(fs.existsSync(usageFile(home)), 'usage still recorded');
  const e = runTap(home, sample, [b64('echo hello')]);
  assert.strictEqual(e.stdout.trim(), 'hello');
  assert.strictEqual(e.status, 0);
});

test('tap: still runs the original command when the input is not JSON', () => {
  const home = mkHome();
  const r = runTap(home, 'not json {', [b64('echo still-here')]);
  assert.strictEqual(r.stdout.trim(), 'still-here');
  assert.ok(!fs.existsSync(usageFile(home)));
});

test('tap: never fails on garbage input, empty input or a garbage argument', () => {
  const home = mkHome();
  for (const input of ['', ' ', 'not json', '[1,2', 'null', '42', '"str"', '[]', '{"rate_limits":null}', '\u0000\u0001�']) {
    const r = runTap(home, input);
    assert.strictEqual(r.status, 0, JSON.stringify(input));
    assert.strictEqual(r.stdout, '');
    assert.strictEqual(r.stderr, '');
  }
  // a garbage argument decodes to a junk command: the shell's own error comes through, ours never throws
  const r = runTap(home, sample, ['!!!not base64!!!']);
  assert.ok(fs.existsSync(usageFile(home)));
  assert.doesNotMatch(r.stderr, /node:internal|at .*usage-tap/);
});

test('tap: does not hang on a slow original command', { timeout: 15000 }, () => {
  const home = mkHome();
  const t = Date.now();
  const r = runTap(home, sample, [b64(`node -e "setTimeout(()=>{}, 30000)"`)]);
  assert.strictEqual(r.status, 0);
  assert.ok(Date.now() - t < 12000);
});

// ---------- the installer ----------
const settingsOf = (home) => path.join(home, '.claude', 'settings.json');
const writeSettings = (home, obj) => {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(settingsOf(home), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) + '\n');
};
const readSettings = (home) => JSON.parse(fs.readFileSync(settingsOf(home), 'utf8'));
const scriptOf = (home) => path.join(home, '.ccpreview', 'hooks', 'usage-tap.js');

test('install: wraps the existing statusLine command and keeps its other keys and every other setting', () => {
  const home = mkHome();
  const orig = 'bash ~/.claude/statusline.sh --flag "a b"';
  writeSettings(home, { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] }, statusLine: { type: 'command', command: orig, padding: 2 } });
  const before = fs.readFileSync(settingsOf(home), 'utf8');
  const r = usage.install({ home });
  assert.strictEqual(r.changed, true);
  const s = readSettings(home);
  assert.deepStrictEqual(s.statusLine, { type: 'command', command: `node "${scriptOf(home)}" ${b64(orig)}`, padding: 2 });
  assert.strictEqual(s.model, 'opus');
  assert.deepStrictEqual(s.hooks, { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] });
  assert.strictEqual(fs.readFileSync(settingsOf(home) + '.ccpreview-bak', 'utf8'), before);
  assert.ok(fs.existsSync(scriptOf(home)));
  assert.strictEqual(usage.status({ home }).state, 'installed');
});

test('install: the installed command really works end to end (original output is unchanged)', () => {
  const home = mkHome();
  writeSettings(home, { statusLine: { type: 'command', command: 'echo my-statusline' } });
  usage.install({ home });
  const cmd = readSettings(home).statusLine.command;
  const r = spawnSync(cmd, { shell: true, input: JSON.stringify(sample), env: envFor(home), encoding: 'utf8' });
  assert.strictEqual(r.stdout.trim(), 'my-statusline');
  assert.ok(fs.existsSync(usageFile(home)));
});

test('install: is idempotent', () => {
  const home = mkHome();
  writeSettings(home, { statusLine: { type: 'command', command: 'echo hi' } });
  assert.strictEqual(usage.install({ home }).changed, true);
  const once = fs.readFileSync(settingsOf(home), 'utf8');
  assert.strictEqual(usage.install({ home }).changed, false);
  assert.strictEqual(fs.readFileSync(settingsOf(home), 'utf8'), once);
});

test('uninstall: restores the exact original command and removes the script', () => {
  const home = mkHome();
  const orig = `echo "it's $HOME" | cat -n   `;
  writeSettings(home, { statusLine: { type: 'command', command: orig, padding: 1 }, theme: 'dark' });
  usage.install({ home });
  const r = usage.uninstall({ home });
  assert.strictEqual(r.changed, true);
  assert.deepStrictEqual(readSettings(home), { statusLine: { type: 'command', command: orig, padding: 1 }, theme: 'dark' });
  assert.ok(!fs.existsSync(scriptOf(home)));
  assert.strictEqual(usage.status({ home }).state, 'not-installed');
  assert.strictEqual(usage.uninstall({ home }).changed, false);
});

test('install with no statusLine, then uninstall, removes the key again', () => {
  const home = mkHome();
  writeSettings(home, { theme: 'dark' });
  usage.install({ home });
  assert.deepStrictEqual(readSettings(home).statusLine, { type: 'command', command: `node "${scriptOf(home)}"` });
  usage.uninstall({ home });
  assert.deepStrictEqual(readSettings(home), { theme: 'dark' });
});

test('install: creates settings.json when there is none; uninstall without one changes nothing', () => {
  const home = mkHome();
  assert.strictEqual(usage.uninstall({ home }).changed, false);
  assert.ok(!fs.existsSync(settingsOf(home)));
  usage.install({ home });
  assert.strictEqual(usage.status({ home }).state, 'installed');
});

test('install: refuses settings.json that is not valid JSON and leaves it untouched', () => {
  const home = mkHome();
  writeSettings(home, '{ "statusLine": ');
  assert.throws(() => usage.install({ home }), /not valid JSON/);
  assert.throws(() => usage.uninstall({ home }), /not valid JSON/);
  assert.strictEqual(fs.readFileSync(settingsOf(home), 'utf8'), '{ "statusLine": ');
  assert.ok(!fs.existsSync(scriptOf(home)), 'no script copied when refusing');
});

test('install: refuses a statusLine that is not a command and leaves it untouched', () => {
  for (const sl of [{ type: 'static', text: 'hi' }, 'echo hi', { type: 'command', command: 5 }]) {
    const home = mkHome();
    writeSettings(home, { statusLine: sl });
    const before = fs.readFileSync(settingsOf(home), 'utf8');
    assert.throws(() => usage.install({ home }), /statusLine/);
    assert.strictEqual(fs.readFileSync(settingsOf(home), 'utf8'), before);
    assert.ok(!fs.existsSync(scriptOf(home)));
  }
});

test('install: only the statusLine key changes', () => {
  const home = mkHome();
  const base = { a: 1, env: { X: '1' }, permissions: { allow: ['Bash(ls)'] }, statusLine: { type: 'command', command: 'echo hi' } };
  writeSettings(home, base);
  usage.install({ home });
  const { statusLine, ...rest } = readSettings(home);
  const { statusLine: _s, ...baseRest } = base;
  assert.deepStrictEqual(rest, baseRest);
});

test('install: follows CLAUDE_CONFIG_DIR', () => {
  const home = mkHome();
  const dir = path.join(home, 'cfg');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'settings.json'), '{}\n');
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try { usage.install({ home }); } finally { if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev; }
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).statusLine);
  assert.ok(!fs.existsSync(settingsOf(home)));
});

test('status: reports usage.json existence and age', () => {
  const home = mkHome();
  let s = usage.status({ home });
  assert.strictEqual(s.state, 'not-installed');
  assert.strictEqual(s.data, null);
  runTap(home, sample);
  s = usage.status({ home });
  assert.ok(s.data && s.data.ageSec >= 0 && s.data.ageSec < 60);
});

// ---------- the CLI ----------
test('cli: ccpreview usage install / status / uninstall', () => {
  const home = mkHome();
  writeSettings(home, { statusLine: { type: 'command', command: 'echo hi' } });
  const bin = path.join(__dirname, '..', 'bin', 'ccpreview.js');
  const run = (...a) => spawnSync(process.execPath, [bin, 'usage', ...a], { env: envFor(home), encoding: 'utf8' });
  const i = run('install');
  assert.strictEqual(i.status, 0, i.stderr);
  assert.match(i.stdout, /unchanged/);
  assert.match(run('status').stdout, /installed/);
  assert.strictEqual(run('uninstall').status, 0);
  assert.strictEqual(readSettings(home).statusLine.command, 'echo hi');
  assert.notStrictEqual(run('bogus').status, 0);
});
