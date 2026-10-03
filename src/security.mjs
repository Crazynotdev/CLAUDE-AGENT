// Repo-as-hostile-input scanner. Heuristic and pattern-based: it reports suspicious content, it does not prove safety.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { listFiles, TEXT_EXT } from './util.mjs';

const RULES = [
  { id: 'injection-ignore', sev: 'high', re: /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|all|any|earlier|system)\b[^.\n]{0,30}\b(instructions?|rules?|prompts?)\b/i, msg: 'instruction-override phrase' },
  { id: 'injection-role', sev: 'medium', re: /\b(you are now|new instructions?:|system prompt|developer mode|act as (root|admin))\b/i, msg: 'role or system-prompt manipulation phrase' },
  { id: 'injection-secrecy', sev: 'high', re: /\b(do not|don't|never)\b[^.\n]{0,25}\b(tell|inform|mention|show)\b[^.\n]{0,20}\b(the )?user\b/i, msg: 'asks the agent to hide actions from the user' },
  { id: 'exfil', sev: 'high', re: /\b(send|post|upload|exfiltrate|curl|wget)\b[^\n]{0,60}(\.env|id_rsa|credentials|api[_-]?key|secret|token|ssh)/i, msg: 'possible secret exfiltration instruction' },
  { id: 'pipe-shell', sev: 'high', re: /(curl|wget)[^\n|]{0,120}\|\s*(sudo\s+)?(ba|z)?sh\b/i, msg: 'remote script piped into a shell' },
  { id: 'hidden-unicode', sev: 'medium', re: /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/, msg: 'zero-width or bidi control character' },
  { id: 'html-comment-instr', sev: 'medium', re: /<!--[^>]{0,200}\b(assistant|claude|ai agent|llm|ignore|execute|run)\b[^>]{0,200}-->/i, msg: 'instruction-like HTML comment' },
  { id: 'eval-b64', sev: 'medium', re: /(eval|exec)\s*\(\s*(atob|Buffer\.from|base64\.b64decode)/i, msg: 'eval of decoded payload' },
];
const POPULAR = ['express', 'react', 'lodash', 'axios', 'moment', 'webpack', 'typescript', 'request', 'chalk', 'commander', 'dotenv', 'jsonwebtoken', 'bcrypt', 'mongoose', 'cors', 'next'];
const lev = (a, b) => { const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) m[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return m[a.length][b.length]; };

export function scanText(file, text) {
  const out = [];
  text.split('\n').forEach((ln, i) => { for (const r of RULES) if (r.re.test(ln)) out.push({ file, line: i + 1, sev: r.sev, rule: r.id, msg: r.msg }); });
  return out;
}

function scanConfig(root) {
  const out = [];
  const pj = join(root, 'package.json');
  if (existsSync(pj)) {
    try {
      const p = JSON.parse(readFileSync(pj, 'utf8'));
      for (const k of ['preinstall', 'install', 'postinstall', 'prepare']) {
        const s = p.scripts?.[k];
        if (s && /(curl|wget|node\s+-e|eval|base64|powershell|\bnc\b)/i.test(s)) out.push({ file: 'package.json', line: 0, sev: 'high', rule: 'lifecycle-script', msg: `${k} script runs network or eval-like command: ${s.slice(0, 80)}` });
      }
      for (const dep of Object.keys({ ...p.dependencies, ...p.devDependencies })) {
        const near = POPULAR.find((x) => x !== dep && lev(x, dep) === 1 && dep.length > 3);
        if (near) out.push({ file: 'package.json', line: 0, sev: 'medium', rule: 'typosquat', msg: `dependency "${dep}" is one edit away from "${near}" (heuristic)` });
      }
    } catch { /* invalid json is not our concern here */ }
  }
  const settings = join(root, '.claude', 'settings.json');
  if (existsSync(settings)) {
    try {
      const s = JSON.parse(readFileSync(settings, 'utf8'));
      for (const groups of Object.values(s.hooks ?? {})) for (const g of groups) for (const h of g.hooks ?? []) {
        if (/(curl|wget|nc\s|\/dev\/tcp|base64|eval)/i.test(h.command ?? '') ) out.push({ file: '.claude/settings.json', line: 0, sev: 'high', rule: 'hook-network', msg: `hook runs network or eval-like command: ${String(h.command).slice(0, 80)}` });
      }
    } catch { /* ignore */ }
  }
  const mcp = join(root, '.mcp.json');
  if (existsSync(mcp)) {
    try {
      const m = JSON.parse(readFileSync(mcp, 'utf8'));
      for (const [name, srv] of Object.entries(m.mcpServers ?? {})) {
        const cmd = `${srv.command ?? ''} ${(srv.args ?? []).join(' ')}`;
        if (srv.url) out.push({ file: '.mcp.json', line: 0, sev: 'medium', rule: 'mcp-remote', msg: `MCP server "${name}" is remote: ${srv.url}` });
        if (/npx\s+(-y|--yes)/.test(cmd)) out.push({ file: '.mcp.json', line: 0, sev: 'medium', rule: 'mcp-npx-y', msg: `MCP server "${name}" auto-installs a package with npx -y` });
      }
    } catch { /* ignore */ }
  }
  return out;
}

export function scan(root, { quick = false } = {}) {
  const findings = scanConfig(root);
  const files = quick
    ? ['README.md', 'CLAUDE.md', 'AGENTS.md', 'readme.md'].filter((f) => existsSync(join(root, f)))
    : listFiles(root, new Set([...TEXT_EXT]));
  for (const f of files.slice(0, 3000)) {
    let t; try { t = readFileSync(join(root, f), 'utf8'); } catch { continue; }
    if (t.length > 1_000_000) continue;
    findings.push(...scanText(f, t));
  }
  return findings;
}

export function formatScan(findings) {
  if (!findings.length) return 'scan: no findings (pattern-based; this is not a guarantee of safety)';
  const order = { high: 0, medium: 1 };
  return findings.sort((a, b) => order[a.sev] - order[b.sev]).slice(0, 40)
    .map((f) => `[${f.sev}] ${f.file}${f.line ? ':' + f.line : ''} ${f.rule}: ${f.msg}`).join('\n')
    + (findings.length > 40 ? `\n… ${findings.length - 40} more` : '');
}
