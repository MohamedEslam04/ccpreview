'use strict';
// Where Claude Code keeps its files: ~/.claude, or $CLAUDE_CONFIG_DIR when the user moved it.
const os = require('os');
const path = require('path');

function claudeDir(env = process.env, home = os.homedir()) {
  const custom = (env.CLAUDE_CONFIG_DIR || '').trim();
  if (!custom) return path.join(home, '.claude');
  // "~/x" is common in shell profiles; Node does not expand it
  return path.resolve(custom === '~' ? home : custom.replace(/^~(?=[\\/])/, home));
}

module.exports = { claudeDir };
