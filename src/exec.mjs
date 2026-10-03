// Tool-result compression. The raw output is always kept and retrievable with `crazy raw <id>`.
import { spawnSync, execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { currentTask, logEvent } from './db.mjs';
import { errorSignature } from './memory.mjs';

const ERR = /\b(error|errors|fail|failed|failing|fatal|exception|traceback|panic|denied|cannot|can't|not found|enoent|eacce|undefined|✗|✖|FAIL)\b/i;
const SUMMARY = /(\d+\s+(passed|failed|passing|failing|skipped|tests?)\b|tests?:|test suites?:|ran \d+ tests?|^ok\b|^not ok\b|# (pass|fail)\b|error[s]? generated|build (succeeded|failed))/i;

export function compress(text, { maxLines = 40 } = {}) {
  const lines = text.replace(/\n+$/, '').split('\n');
  if (lines.length <= maxLines) return { out: lines.join('\n'), compressed: false, lines: lines.length };
  const keep = new Set();
  const mark = (i) => { if (i >= 0 && i < lines.length) keep.add(i); };
  for (let i = 0; i < Math.min(4, lines.length); i++) mark(i);
  for (let i = Math.max(0, lines.length - 15); i < lines.length; i++) mark(i);
  let errCount = 0;
  lines.forEach((l, i) => {
    if (ERR.test(l)) { errCount++; if (errCount <= 25) { mark(i - 1); mark(i); mark(i + 1); } }
    else if (SUMMARY.test(l)) mark(i);
    else if (/^\s+at\s+\S+.*\(.*:\d+:\d+\)/.test(l) && errCount && errCount <= 25 && keep.has(i - 1)) mark(i);
  });
  const sorted = [...keep].sort((a, b) => a - b);
  const out = []; let prev = -1; let last = null; let rep = 0;
  const flush = () => { if (rep > 0) out.push(`  (previous line repeated x${rep})`); rep = 0; };
  for (const i of sorted) {
    if (prev >= 0 && i > prev + 1) { flush(); out.push(`  … ${i - prev - 1} lines omitted …`); last = null; }
    const l = lines[i];
    if (l === last) { rep++; } else { flush(); out.push(l); last = l; }
    prev = i;
  }
  flush();
  return { out: out.join('\n'), compressed: true, lines: lines.length, errCount };
}

function gitChanged(root) {
  try {
    return new Set(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter(Boolean).map((l) => l.slice(3)));
  } catch { return null; }
}

export function runCommand(ctx, argv) {
  const { db, dir, root } = ctx;
  const shq = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
  const cmd = argv.length === 1 ? argv[0] : argv.map(shq).join(' ');
  const before = gitChanged(root);
  const r = spawnSync(cmd, { shell: true, cwd: process.cwd(), encoding: 'utf8', maxBuffer: 1 << 28 });
  const text = `${r.stdout ?? ''}${r.stderr ? (r.stdout ? '\n' : '') + r.stderr : ''}`;
  const exit = r.status ?? 1;
  const { lastInsertRowid: id } = db.prepare('INSERT INTO raw_outputs(cmd,bytes,exit,path,created_at) VALUES(?,?,?,?,?)').run(cmd, text.length, exit, '', Date.now());
  const path = join(dir, 'raw', `${id}.txt`);
  writeFileSync(path, text);
  db.prepare('UPDATE raw_outputs SET path=? WHERE id=?').run(path, id);
  const c = compress(text);
  const after = gitChanged(root);
  const changed = before && after ? [...after].filter((f) => !before.has(f)) : [];
  const ok = exit === 0;
  const sig = errorSignature(text);
  const tf = text.match(/(\d+)\s+(?:failed|failing)/i);
  logEvent(db, { session: process.env.CRAZY_SESSION ?? 'cli', task_id: currentTask(dir), kind: 'bash', sig: cmd.replace(/\s+/g, ' ').slice(0, 200), ok, n: tf ? Number(tf[1]) : (ok ? 0 : null), payload: ok ? null : { err: sig } });
  const head = `[crazy run exit=${exit} lines=${c.lines}${c.compressed ? ` shown=${c.out.split('\n').length} raw=#${id} (crazy raw ${id})` : ''}]`;
  const tail = changed.length ? `\nchanged: ${changed.slice(0, 12).join(', ')}${changed.length > 12 ? ` +${changed.length - 12}` : ''}` : '';
  return { text: `${head}\n${c.out}${tail}`, exit };
}

export function readRaw({ db }, id, { grep, lines } = {}) {
  const row = db.prepare('SELECT * FROM raw_outputs WHERE id=?').get(id);
  if (!row || !existsSync(row.path)) throw new Error(`no raw output #${id}`);
  let arr = readFileSync(row.path, 'utf8').split('\n');
  if (grep) { const re = new RegExp(grep, 'i'); arr = arr.filter((l) => re.test(l)); }
  if (lines) { const [a, b] = String(lines).split('-').map(Number); arr = arr.slice(a - 1, b ?? a); }
  return arr.join('\n');
}
