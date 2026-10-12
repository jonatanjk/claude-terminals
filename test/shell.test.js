// Unit tests for shell selection and Claude start-up commands. Run with `npm test`.
const assert = require('assert');
const { pickShell, claudeCmd } = require('../shell');

const none = () => false;
const only = (...paths) => p => paths.includes(p);
const GIT_BASH = 'C:/Program Files/Git/bin/bash.exe';

// Windows with Git for Windows: Git Bash, as before.
assert.deepStrictEqual(pickShell({ platform: 'win32', env: {}, exists: only(GIT_BASH) }),
  { file: GIT_BASH, args: ['-l', '-i'], flavour: 'posix', label: 'Git Bash' });

// Windows without Git for Windows: PowerShell 7 if present, else Windows PowerShell.
assert.deepStrictEqual(pickShell({ platform: 'win32', env: {}, exists: none, onPath: n => n === 'pwsh.exe' }),
  { file: 'pwsh.exe', args: ['-NoLogo'], flavour: 'powershell', label: 'PowerShell' });
assert.deepStrictEqual(pickShell({ platform: 'win32', env: {}, exists: none, onPath: () => false }),
  { file: 'powershell.exe', args: ['-NoLogo'], flavour: 'powershell', label: 'PowerShell' });

// macOS/Linux: the login shell.
assert.deepStrictEqual(pickShell({ platform: 'darwin', env: { SHELL: '/bin/zsh' }, exists: none }),
  { file: '/bin/zsh', args: ['-l', '-i'], flavour: 'posix', label: 'shell' });

// Override: a PowerShell override gets PowerShell arguments, anything else POSIX ones.
assert.strictEqual(pickShell({ platform: 'win32', env: { CLAUDE_TERMINALS_BASH: 'C:/x/pwsh.exe' }, exists: none }).flavour, 'powershell');
assert.deepStrictEqual(pickShell({ platform: 'win32', env: { CLAUDE_TERMINALS_BASH: 'D:/git/bin/bash.exe' }, exists: none }).args, ['-l', '-i']);

// POSIX commands are unchanged.
const m = { claudeSessionId: 'abc', prompt: "it's" };
assert.strictEqual(claudeCmd(m, false, 'posix'), "claude --session-id abc 'it'\\''s'");
assert.strictEqual(claudeCmd(m, true, 'posix'), 'claude --resume abc || claude --session-id abc');

// PowerShell: '' escaping, and no `||` (Windows PowerShell 5.1 has no pipeline chain operators).
assert.strictEqual(claudeCmd(m, false, 'powershell'), "claude --session-id abc 'it''s'");
assert.strictEqual(claudeCmd(m, true, 'powershell'), 'claude --resume abc; if (-not $?) { claude --session-id abc }');

// PowerShell also ends single-quoted strings at typographic quotes (U+2018-U+201B), so those are doubled too.
assert.strictEqual(claudeCmd({ claudeSessionId: 'abc', prompt: 'what\u2019s \u2018new\u2019' }, false, 'powershell'),
  "claude --session-id abc 'what\u2019\u2019s \u2018\u2018new\u2019\u2019'");

console.log('PASS: shell selection and Claude commands');
