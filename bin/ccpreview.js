#!/usr/bin/env node
'use strict';
// ccpreview: watch your Claude Code sessions live in the browser.
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { claudeDir } = require('../lib/paths');
const pkg = require('../package.json');

const HELP = `ccpreview ${pkg.version}
Watch your Claude Code sessions live in the browser. Everything stays on this machine.

Usage: ccpreview [options]
       ccpreview hook <install|uninstall|status>

  -p, --port <n>       port to listen on (default 4747; 0 picks a free one)
      --projects <dir> Claude Code projects folder (default ~/.claude/projects, or $CLAUDE_CONFIG_DIR/projects)
      --data <dir>     where ccpreview keeps your notes pages (default ~/.ccpreview)
      --no-open        don't open the browser
  -v, --version        print the version
  -h, --help           show this help

Optional: see a question while it waits (Claude Code only writes it to the transcript after you answer):

  ccpreview hook install    add ccpreview's own entries to ~/.claude/settings.json (backup kept next to it)
  ccpreview hook uninstall  remove only those entries
  ccpreview hook status     show whether the hook is installed and where

ccpreview only listens on 127.0.0.1.`;

function parse(argv) {
  const o = { port: 4747, open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${a} needs a value`);
      return v;
    };
    if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
    else if (a === '-v' || a === '--version') { console.log(pkg.version); process.exit(0); }
    else if (a === '-p' || a === '--port') o.port = Number(val());
    else if (a.startsWith('--port=')) o.port = Number(a.slice(7));
    else if (a === '--projects') o.projects = path.resolve(val());
    else if (a === '--data') o.dataDir = path.resolve(val());
    else if (a === '--no-open') o.open = false;
    else fail(`unknown option: ${a}`);
  }
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) fail('--port must be 0-65535');
  return o;
}

function fail(msg) {
  console.error(`ccpreview: ${msg}\n\n${HELP}`);
  process.exit(2);
}

function hookCommand(args) {
  const hook = require('../lib/hook-install.js');
  const sub = args[0];
  if (!['install', 'uninstall', 'status'].includes(sub) || args.length > 1) fail('usage: ccpreview hook <install|uninstall|status>');
  try {
    if (sub === 'install') {
      const r = hook.install();
      console.log(r.changed ? `Installed. Added ${r.added.join(', ')} to ${r.settings}` : `Already installed in ${r.settings}`);
      if (r.backup) console.log(`Backup of your settings: ${r.backup}`);
      console.log(`Hook script: ${r.script}`);
      console.log('Restart Claude Code sessions (or open /hooks once) so they pick it up.');
    } else if (sub === 'uninstall') {
      const r = hook.uninstall();
      console.log(r.changed ? `Removed ccpreview's entries (${r.removed.join(', ') || 'none in settings'}) and the hook script.` : 'Nothing to remove: the hook is not installed.');
    } else {
      const r = hook.status();
      if (r.state === 'not-installed') console.log('Pending-question hook: not installed (run: ccpreview hook install)');
      else console.log(`Pending-question hook: ${r.state === 'installed' ? 'installed' : `partly installed, missing ${r.missing.join(', ')} (run: ccpreview hook install)`}\nSettings: ${r.settings}\nScript:   ${r.script}${r.scriptExists ? '' : ' (missing, run: ccpreview hook install)'}`);
    }
  } catch (e) {
    if (!(e instanceof hook.HookError)) throw e;
    console.error(`ccpreview: ${e.message}`);
    process.exit(1);
  }
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const p = spawn(cmd, args, { stdio: 'ignore', detached: true });
    p.on('error', () => {});
    p.unref();
  } catch (e) { /* no browser launcher: the URL is printed anyway */ }
}

if (process.argv[2] === 'hook') { hookCommand(process.argv.slice(3)); process.exit(0); }
const { createServer } = require('../lib/server.js');
const opts = parse(process.argv.slice(2));
// systemd socket activation (see docs/systemd) hands us the listening socket as fd 3
const activated = process.env.LISTEN_FDS === '1' && Number(process.env.LISTEN_PID) === process.pid;
const app = createServer({ projects: opts.projects, dataDir: opts.dataDir, version: pkg.version, activated });

app.server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') fail(`port ${opts.port} is busy. Is ccpreview already running? Try --port 0`);
  console.error(e);
  process.exit(1);
});

app.listen(opts.port, (port) => {
  const url = `http://127.0.0.1:${port}/`;
  console.log(`ccpreview ${pkg.version} → ${url}`);
  console.log(`Reading ${opts.projects || path.join(claudeDir(), 'projects')}`);
  if (opts.open && !activated) openBrowser(url);
});
