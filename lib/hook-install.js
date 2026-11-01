'use strict';
// `ccpreview hook install | uninstall | status`: register the optional pending-question hook
// (lib/hook.js) in the user's ~/.claude/settings.json.
// Rules: only ever ADD entries that are ours (identified by the hook script's path), never touch any
// other key or hook, refuse a settings.json we cannot parse, and keep a backup before every write.
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOOLS = 'AskUserQuestion|ExitPlanMode';
const EVENTS = [['PreToolUse', TOOLS], ['PostToolUse', TOOLS], ['PostToolUseFailure', TOOLS], ['Stop'], ['UserPromptSubmit']];

class HookError extends Error {}

function paths(home = os.homedir()) {
  return {
    settings: path.join(home, '.claude', 'settings.json'),
    // a stable path: npx runs from a cache that changes, so the hook script is copied here
    script: path.join(home, '.ccpreview', 'hooks', 'pending-ask.js'),
  };
}

const isOwn = (h, script) => !!h && typeof h.command === 'string' && h.command.includes(script);
const groupsOf = (hooks, ev, file) => {
  if (hooks[ev] === undefined) return [];
  if (!Array.isArray(hooks[ev])) throw new HookError(`${file}: "hooks.${ev}" is not a list, so ccpreview leaves it alone. Fix it or remove it, then try again.`);
  return hooks[ev];
};

// Parse settings.json, or return an empty object when there is none yet.
function load(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { obj: {}, text: null, indent: 2 };
    throw new HookError(`cannot read ${file}: ${e.message}`);
  }
  let obj;
  try { obj = JSON.parse(text); } catch (e) {
    throw new HookError(`${file} is not valid JSON (${e.message}), so ccpreview will not touch it. Fix it and run the command again.`);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new HookError(`${file} is not a JSON object, so ccpreview will not touch it.`);
  if (obj.hooks !== undefined && (!obj.hooks || typeof obj.hooks !== 'object' || Array.isArray(obj.hooks))) throw new HookError(`${file}: "hooks" is not an object, so ccpreview leaves it alone.`);
  const m = text.match(/^[ \t]+(?=")/m);
  return { obj, text, indent: m ? m[0] : 2 };
}

// Write through a symlink (dotfile managers) and keep the file's mode; back up what was there first.
function save(file, { obj, text, indent }) {
  let target = file;
  try { target = fs.realpathSync(file); } catch (e) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
  let mode = 0o600;
  if (text !== null) {
    fs.copyFileSync(target, file + '.ccpreview-bak');
    mode = fs.statSync(target).mode & 0o777;
  }
  const tmp = target + '.ccpreview-tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, indent) + (text === null || text.endsWith('\n') ? '\n' : ''), { mode });
  fs.renameSync(tmp, target);
}

function writeScript(script) {
  fs.mkdirSync(path.dirname(script), { recursive: true, mode: 0o700 });
  const tmp = script + '.tmp';
  fs.copyFileSync(path.join(__dirname, 'hook.js'), tmp);
  fs.renameSync(tmp, script);
}

function install({ home } = {}) {
  const p = paths(home);
  const cfg = load(p.settings);
  const command = `node "${p.script}"`;
  cfg.obj.hooks = cfg.obj.hooks || {};
  const added = [];
  for (const [ev, matcher] of EVENTS) {
    const groups = groupsOf(cfg.obj.hooks, ev, p.settings);
    if (groups.some((g) => g && Array.isArray(g.hooks) && g.hooks.some((h) => isOwn(h, p.script)))) continue;
    // our own group, so another tool's group is never edited
    const group = { hooks: [{ type: 'command', command, timeout: 5 }] };
    if (matcher) group.matcher = matcher;
    cfg.obj.hooks[ev] = [...groups, group];
    added.push(ev);
  }
  writeScript(p.script); // before settings.json points at it
  if (added.length) save(p.settings, cfg);
  return { changed: added.length > 0, added, settings: p.settings, script: p.script, backup: cfg.text !== null && added.length ? p.settings + '.ccpreview-bak' : null };
}

function uninstall({ home } = {}) {
  const p = paths(home);
  const cfg = load(p.settings);
  const removed = [];
  const hooks = cfg.obj.hooks || {};
  for (const ev of Object.keys(hooks)) {
    const groups = groupsOf(hooks, ev, p.settings);
    let hit = false;
    const kept = [];
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks) || !g.hooks.some((h) => isOwn(h, p.script))) { kept.push(g); continue; }
      hit = true;
      const rest = g.hooks.filter((h) => !isOwn(h, p.script));
      if (rest.length) kept.push({ ...g, hooks: rest }); // a group shared with another tool keeps its other hooks
    }
    if (!hit) continue;
    removed.push(ev);
    if (kept.length) hooks[ev] = kept; else delete hooks[ev];
  }
  if (removed.length) {
    if (!Object.keys(hooks).length) delete cfg.obj.hooks;
    save(p.settings, cfg);
  }
  let scriptRemoved = false;
  try { fs.rmSync(p.script); scriptRemoved = true; } catch (e) { /* already gone */ }
  try { fs.rmdirSync(path.dirname(p.script)); } catch (e) { /* not empty or gone */ }
  return { changed: removed.length > 0 || scriptRemoved, removed, settings: p.settings, script: p.script };
}

function status({ home } = {}) {
  const p = paths(home);
  const cfg = load(p.settings);
  const hooks = cfg.obj.hooks || {};
  const have = EVENTS.map(([ev]) => ev).filter((ev) => Array.isArray(hooks[ev]) && hooks[ev].some((g) => g && Array.isArray(g.hooks) && g.hooks.some((h) => isOwn(h, p.script))));
  const missing = EVENTS.map(([ev]) => ev).filter((ev) => !have.includes(ev));
  const state = !have.length ? 'not-installed' : missing.length ? 'partial' : 'installed';
  return { state, missing: state === 'partial' ? missing : [], settings: p.settings, script: p.script, scriptExists: fs.existsSync(p.script) };
}

module.exports = { install, uninstall, status, paths, HookError, EVENTS };
