#!/usr/bin/env node
'use strict';
// Optional Claude Code statusLine wrapper: remember the plan usage limits (5-hour and weekly) that Claude Code
// passes to its statusLine command as `rate_limits`, so ccpreview can show them. Writes ~/.ccpreview/usage.json.
// Usage: node usage-tap.js [<base64url of the user's original statusLine command>]
// The original command (if any) is run with the same stdin and its output and exit code are passed through,
// so the statusline looks exactly as before. Installed by `ccpreview usage install`, which copies this file to
// ~/.ccpreview/hooks/usage-tap.js. It has no dependencies, never logs the input and never throws or hangs:
// if our own part fails, it is skipped.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const DIR = path.join(os.homedir(), '.ccpreview'); // outside ~/.claude: nothing of Claude Code's is touched
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// { pct, resets_at } for one window, or null when it is absent or unusable
function windowOf(w) {
  const pct = w && num(w.used_percentage);
  return pct === null || pct === undefined ? null : { pct, resets_at: num(w.resets_at) };
}

function record(raw) {
  const rl = JSON.parse(raw).rate_limits;
  if (!rl || typeof rl !== 'object') return;
  const out = {};
  const five = windowOf(rl.five_hour);
  const seven = windowOf(rl.seven_day);
  // a window that is absent is left out (the file is overwritten, not merged), so it never shows an old value
  if (five) out.five_hour = five;
  if (seven) out.seven_day = seven;
  if (!five && !seven) return;
  out.ts = Date.now();
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const file = path.join(DIR, 'usage.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Async, not spawnSync: on Windows a timeout only kills cmd.exe, and spawnSync then waits for the pipes of the
// process it started, so a stuck statusline command would hang the tap too. Here the timer ends the whole tree.
function passThrough(input) {
  const orig = Buffer.from(process.argv[2] || '', 'base64url').toString('utf8');
  if (!orig.trim()) return;
  const child = spawn(orig, { shell: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const timer = setTimeout(() => {
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill('SIGKILL');
    } catch (e) { /* ignore */ }
    process.exit(0);
  }, 5000);
  child.stdout.on('data', (c) => process.stdout.write(c));
  child.stderr.on('data', (c) => process.stderr.write(c));
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  child.on('error', () => clearTimeout(timer));
  child.on('close', (code) => {
    clearTimeout(timer);
    if (typeof code === 'number') process.exitCode = code;
  });
}

const chunks = [];
let size = 0;
process.stdin.on('data', (c) => {
  chunks.push(c);
  size += c.length;
  if (size > 4e6) process.exit(0);
});
process.stdin.on('end', () => {
  const input = Buffer.concat(chunks);
  try { record(input.toString('utf8')); } catch (e) { /* never get in Claude Code's way */ }
  try { passThrough(input); } catch (e) { /* ditto */ }
});
process.stdin.on('error', () => {});
