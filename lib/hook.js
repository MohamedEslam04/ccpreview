#!/usr/bin/env node
'use strict';
// Optional Claude Code hook: remember a question (AskUserQuestion) or plan (ExitPlanMode) that is
// waiting for the user, so ccpreview can show it. Claude Code only writes the tool call to the transcript
// after it is answered. PreToolUse writes ~/.ccpreview/pending/<session>.json; any later event clears it.
// Installed by `ccpreview hook install`, which copies this file to ~/.ccpreview/hooks/pending-ask.js.
// It has no dependencies, prints nothing and always exits 0: it must never block or change what
// Claude Code does.
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(os.homedir(), '.ccpreview', 'pending'); // outside ~/.claude: nothing of Claude Code's is touched
let raw = '';
process.stdin.on('data', (c) => {
  raw += c;
  if (raw.length > 4e6) process.exit(0);
});
process.stdin.on('end', () => {
  try {
    const h = JSON.parse(raw);
    const id = String(h.session_id || '');
    if (!/^[\w-]+$/.test(id)) return;
    const file = path.join(DIR, id + '.json');
    if (h.hook_event_name === 'PreToolUse' && /^(AskUserQuestion|ExitPlanMode)$/.test(h.tool_name || '')) {
      fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ session: id, transcript: h.transcript_path || '', tool: h.tool_name, id: h.tool_use_id || '', input: h.tool_input || {}, at: Date.now() }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } else {
      fs.rmSync(file, { force: true });
    }
  } catch (e) { /* never get in Claude Code's way */ }
});
process.stdin.on('error', () => {});
