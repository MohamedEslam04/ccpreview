'use strict';
// Git status of a session's working folder, for the info panel.
// The folder comes from the transcript itself (never from the request), so the page can only ask about
// folders Claude actually worked in. fsmonitor is off and optional locks are skipped: read-only, no hooks.
const fs = require('fs');
const { execFile } = require('child_process');

// the last "cwd" in the tail of the transcript
function lastCwd(file) {
  return new Promise((resolve) => {
    fs.open(file, 'r', (err, fd) => {
      if (err) return resolve('');
      fs.fstat(fd, (e2, stat) => {
        if (e2) { fs.close(fd, () => {}); return resolve(''); }
        const len = Math.min(stat.size, 512 * 1024);
        const buf = Buffer.alloc(len);
        fs.read(fd, buf, 0, len, stat.size - len, () => {
          fs.close(fd, () => {});
          const all = [...buf.toString('utf8').matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)];
          try { resolve(all.length ? JSON.parse(`"${all[all.length - 1][1]}"`) : ''); } catch (e) { resolve(''); }
        });
      });
    });
  });
}

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', ...args], {
      cwd, timeout: 4000, maxBuffer: 2e6, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    }, (err, out) => resolve(err ? null : out));
  });
}

async function gitInfo(file) {
  const cwd = await lastCwd(file);
  if (!cwd || !fs.existsSync(cwd)) return { cwd, repo: false, gone: !!cwd };
  const st = await git(cwd, ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=normal']);
  if (st == null) return { cwd, repo: false };
  const parts = st.split('\0').filter(Boolean);
  const head = parts.shift() || '';
  // "## main...origin/main [ahead 1, behind 2]" or "## No commits yet on main" or "## HEAD (no branch)"
  const m = head.match(/^## (?:No commits yet on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/) || [];
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const x = parts[i][0], y = parts[i][1], f = parts[i].slice(3);
    if (x === 'R' || x === 'C') i++; // the old name follows a rename
    files.push({ x, y, f });
  }
  const log = await git(cwd, ['log', '-1', '--format=%h%x00%s%x00%ct']);
  const [sha, subject, ct] = (log || '').trim().split('\0');
  const top = await git(cwd, ['rev-parse', '--show-toplevel']);
  const stash = await git(cwd, ['stash', 'list']);
  return {
    cwd, repo: true, root: (top || '').trim(), branch: m[1] || '', upstream: m[2] || '',
    ahead: +((m[3] || '').match(/ahead (\d+)/) || [])[1] || 0, behind: +((m[3] || '').match(/behind (\d+)/) || [])[1] || 0,
    files: files.slice(0, 200), total: files.length, stash: stash ? stash.split('\n').filter(Boolean).length : 0,
    last: sha ? { sha, subject, at: +ct * 1000 } : null,
  };
}

module.exports = { gitInfo, lastCwd };
