#!/usr/bin/env node
'use strict';
// marsad: watch your Claude Code sessions live in the browser.
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { createServer } = require('../lib/server.js');
const pkg = require('../package.json');

const HELP = `marsad ${pkg.version}
Watch your Claude Code sessions live in the browser. Everything stays on this machine.

Usage: marsad [options]

  -p, --port <n>       port to listen on (default 4747; 0 picks a free one)
      --projects <dir> Claude Code projects folder (default ~/.claude/projects)
      --data <dir>     where Marsad keeps your notes pages (default ~/.marsad)
      --no-open        don't open the browser
  -v, --version        print the version
  -h, --help           show this help

Marsad only listens on 127.0.0.1.`;

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
  console.error(`marsad: ${msg}\n\n${HELP}`);
  process.exit(2);
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

const opts = parse(process.argv.slice(2));
// systemd socket activation (see docs/systemd) hands us the listening socket as fd 3
const activated = process.env.LISTEN_FDS === '1' && Number(process.env.LISTEN_PID) === process.pid;
const app = createServer({ projects: opts.projects, dataDir: opts.dataDir, version: pkg.version, activated });

app.server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') fail(`port ${opts.port} is busy. Is Marsad already running? Try --port 0`);
  console.error(e);
  process.exit(1);
});

app.listen(opts.port, (port) => {
  const url = `http://127.0.0.1:${port}/`;
  console.log(`Marsad ${pkg.version} → ${url}`);
  console.log(`Reading ${opts.projects || path.join(os.homedir(), '.claude', 'projects')}`);
  if (opts.open && !activated) openBrowser(url);
});
