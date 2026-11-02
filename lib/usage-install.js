'use strict';
// `ccpreview usage install | uninstall | status`: record the plan usage limits Claude Code hands to its statusLine
// command (lib/usage-tap.js) by wrapping the user's statusLine in settings.json.
// Rules: only the `statusLine` key is ever changed (its other keys, e.g. padding, are kept), the original command is
// kept inside ours so uninstall restores it exactly, a settings.json we cannot parse is refused, and a backup is
// kept before every write. The load/save safety is shared with hook-install.js.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { claudeDir } = require('./paths');
const { load, save, HookError } = require('./hook-install');

function paths(home = os.homedir(), env = process.env) {
  return {
    settings: path.join(claudeDir(env, home), 'settings.json'),
    // a stable path: npx runs from a cache that changes, so the script is copied here
    script: path.join(home, '.ccpreview', 'hooks', 'usage-tap.js'),
    data: path.join(home, '.ccpreview', 'usage.json'),
  };
}

const isOwn = (sl, script) => !!sl && typeof sl.command === 'string' && sl.command.includes(script);

// The statusLine object if it is one we can wrap (or undefined when there is none).
function checkStatusLine(sl, file) {
  if (sl === undefined) return undefined;
  if (!sl || typeof sl !== 'object' || Array.isArray(sl) || sl.type !== 'command' || (sl.command !== undefined && typeof sl.command !== 'string')) {
    throw new HookError(`${file}: "statusLine" is not a command, so ccpreview leaves it alone. Usage limits need a statusLine of type "command".`);
  }
  return sl;
}

function writeScript(script) {
  fs.mkdirSync(path.dirname(script), { recursive: true, mode: 0o700 });
  const tmp = script + '.tmp';
  fs.copyFileSync(path.join(__dirname, 'usage-tap.js'), tmp);
  fs.renameSync(tmp, script);
}

function install({ home } = {}) {
  const p = paths(home);
  const cfg = load(p.settings);
  const sl = checkStatusLine(cfg.obj.statusLine, p.settings);
  if (isOwn(sl, p.script)) { writeScript(p.script); return { changed: false, settings: p.settings, script: p.script, backup: null }; }
  const orig = sl && sl.command && sl.command.trim() ? sl.command : '';
  const command = `node "${p.script}"` + (orig ? ' ' + Buffer.from(orig, 'utf8').toString('base64url') : '');
  writeScript(p.script); // before settings.json points at it
  cfg.obj.statusLine = { ...(sl || {}), type: 'command', command };
  save(p.settings, cfg);
  return { changed: true, wrapped: !!orig, settings: p.settings, script: p.script, backup: cfg.text !== null ? p.settings + '.ccpreview-bak' : null };
}

function uninstall({ home } = {}) {
  const p = paths(home);
  const cfg = load(p.settings);
  const sl = checkStatusLine(cfg.obj.statusLine, p.settings);
  let restored = false;
  if (isOwn(sl, p.script)) {
    const m = sl.command.match(/^node "([^"]*)"(?: ([A-Za-z0-9_-]+))?\s*$/);
    if (!m || m[1] !== p.script) throw new HookError(`${p.settings}: the statusLine command was edited by hand, so ccpreview cannot restore the original. Edit it yourself, then run the command again.`);
    if (m[2]) cfg.obj.statusLine = { ...sl, command: Buffer.from(m[2], 'base64url').toString('utf8') };
    else delete cfg.obj.statusLine;
    save(p.settings, cfg);
    restored = true;
  }
  let scriptRemoved = false;
  try { fs.rmSync(p.script); scriptRemoved = true; } catch (e) { /* already gone */ }
  try { fs.rmdirSync(path.dirname(p.script)); } catch (e) { /* not empty or gone */ }
  return { changed: restored || scriptRemoved, restored, settings: p.settings, script: p.script };
}

function status({ home } = {}) {
  const p = paths(home);
  const cfg = load(p.settings);
  const sl = cfg.obj.statusLine;
  const installed = isOwn(sl && typeof sl === 'object' ? sl : null, p.script);
  let data = null;
  try {
    const st = fs.statSync(p.data);
    let ts = st.mtimeMs;
    try { const j = JSON.parse(fs.readFileSync(p.data, 'utf8')); if (Number.isFinite(j.ts)) ts = j.ts; } catch (e) { /* use the file time */ }
    data = { file: p.data, ageSec: Math.max(0, Math.round((Date.now() - ts) / 1000)) };
  } catch (e) { /* no data yet */ }
  return { state: installed ? 'installed' : 'not-installed', settings: p.settings, script: p.script, scriptExists: fs.existsSync(p.script), data };
}

module.exports = { install, uninstall, status, paths };
