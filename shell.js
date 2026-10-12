// Which shell each tab runs, and how to start Claude Code in it.
const fs = require('fs'), path = require('path');

const GIT_BASH = 'C:/Program Files/Git/bin/bash.exe';
const POSIX_ARGS = ['-l', '-i'], PS_ARGS = ['-NoLogo'];

function onPathDefault(name) {
  return (process.env.PATH || '').split(path.delimiter).some(d => d && fs.existsSync(path.join(d, name)));
}

// Windows: Git Bash, else PowerShell 7, else Windows PowerShell. macOS/Linux: the login shell.
// CLAUDE_TERMINALS_BASH overrides either; a pwsh/powershell override is started as PowerShell.
function pickShell({ platform = process.platform, env = process.env, exists = fs.existsSync, onPath = onPathDefault } = {}) {
  const ps = file => ({ file, args: PS_ARGS, flavour: 'powershell', label: 'PowerShell' });
  const posix = (file, label) => ({ file, args: POSIX_ARGS, flavour: 'posix', label });
  const override = env.CLAUDE_TERMINALS_BASH;
  if (override) return /(^|[\\/])(pwsh|powershell)(\.exe)?$/i.test(override) ? ps(override) : posix(override, 'shell');
  if (platform !== 'win32') return posix(env.SHELL || '/bin/zsh', 'shell');
  if (exists(GIT_BASH)) return posix(GIT_BASH, 'Git Bash');
  return ps(onPath('pwsh.exe') ? 'pwsh.exe' : 'powershell.exe');
}

function claudeCmd(m, resume, flavour = 'posix') {
  const extra = m.args ? ' ' + m.args : '';
  const isPs = flavour === 'powershell';
  if (resume) {
    const a = `claude --resume ${m.claudeSessionId}${extra}`, b = `claude --session-id ${m.claudeSessionId}${extra}`;
    return isPs ? `${a}; if (-not $?) { ${b} }` : `${a} || ${b}`;
  }
  // PowerShell closes a single-quoted string at ' and at the typographic quotes U+2018-U+201B; doubling escapes each.
  const quote = s => "'" + (isPs ? String(s).replace(/['\u2018-\u201b]/g, q => q + q) : String(s).replace(/'/g, "'\\''")) + "'";
  const prompt = m.prompt ? ' ' + quote(m.prompt) : '';
  return `claude --session-id ${m.claudeSessionId}${extra}${prompt}`;
}

module.exports = { pickShell, claudeCmd };
