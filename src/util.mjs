import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { execFileSync } from 'node:child_process';

export const tok = (s) => Math.ceil((s?.length ?? 0) / 4);
export const sha = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 16);

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.crazy', '.next', '__pycache__',
  '.venv', 'venv', 'coverage', '.godot', '.import', 'vendor', 'target', '.claude']);
export const SRC_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.gd']);
export const TEXT_EXT = new Set([...SRC_EXT, '.md', '.json', '.yml', '.yaml', '.toml', '.sh',
  '.html', '.css', '.txt', '.go', '.rs', '.java', '.php', '.rb']);

export function findRoot(cwd = process.cwd()) {
  let d = cwd;
  for (;;) {
    if (existsSync(join(d, '.crazy')) || existsSync(join(d, '.git'))) return d;
    const up = join(d, '..');
    if (up === d) return cwd;
    d = up;
  }
}

function walk(dir, root, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, root, out);
    else out.push(p.slice(root.length + 1));
  }
  return out;
}

export function listFiles(root, exts = TEXT_EXT) {
  let files;
  try {
    files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'],
      { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter(Boolean);
  } catch { files = walk(root, root, []); }
  return files.filter((f) => exts.has(extname(f).toLowerCase())
    && !f.split('/').some((p) => SKIP.has(p)) && existsSync(join(root, f)));
}

export function hashFile(root, rel) {
  try { return sha(readFileSync(join(root, rel))); } catch { return null; }
}

export function statFile(root, rel) {
  try { const s = statSync(join(root, rel)); return { size: s.size, mtime: Math.floor(s.mtimeMs) }; }
  catch { return null; }
}

export function splitWords(s) {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[^A-Za-z0-9]+/g, ' ')
    .toLowerCase().split(' ').filter(Boolean);
}

export function parseFlags(argv, spec = {}) {
  const flags = {}; const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (v !== undefined) flags[k] = v;
      else if (spec[k] === 'boolean') flags[k] = true;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { flags, pos };
}

export const csv = (s) => (s ? String(s).split(',').map((x) => x.trim()).filter(Boolean) : []);
export const ago = (ms) => {
  const d = (Date.now() - ms) / 86400000;
  return d < 1 ? 'today' : `${Math.floor(d)}d ago`;
};
