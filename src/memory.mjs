// Verified-knowledge cache, failure memory and developer DNA. All in the project SQLite store.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashFile, splitWords, csv, ago, listFiles, SRC_EXT } from './util.mjs';
import { ensureIndex } from './indexer.mjs';
import { currentTask } from './db.mjs';

const VERIFIABLE = new Set(['test', 'compile', 'runtime', 'source', 'doc']);

export function factStatus(root, f, sources, nowMs = Date.now()) {
  if (!sources.length) return 'unknown';
  let changed = false; let missing = false;
  for (const s of sources) {
    const h = hashFile(root, s.file);
    if (h === null) missing = true; else if (h !== s.hash) changed = true;
  }
  if (missing) return 'invalidated';
  if (changed) return 'stale';
  const age = (nowMs - f.last_verified) / 86400000;
  return VERIFIABLE.has(f.kind) && f.confidence >= 0.8 && age <= 90 ? 'verified' : 'likely-valid';
}

export function addFact({ db, root }, claim, { src = [], kind = 'source', conf = 1, scope = 'project' } = {}) {
  const now = Date.now();
  const { lastInsertRowid: id } = db.prepare('INSERT INTO facts(claim,scope,kind,confidence,created_at,last_verified) VALUES(?,?,?,?,?,?)')
    .run(claim, scope, kind, conf, now, now);
  for (const f of src) {
    const h = hashFile(root, f);
    if (h === null) throw new Error(`source not found: ${f}`);
    db.prepare('INSERT INTO fact_sources(fact_id,file,hash) VALUES(?,?,?)').run(id, f, h);
  }
  return Number(id);
}

export function listFacts({ db, root }) {
  return db.prepare('SELECT * FROM facts ORDER BY id DESC').all().map((f) => {
    const sources = db.prepare('SELECT file,hash FROM fact_sources WHERE fact_id=?').all(f.id);
    return { ...f, sources, status: factStatus(root, f, sources) };
  });
}

export function verifyFact({ db, root }, id) {
  const f = db.prepare('SELECT * FROM facts WHERE id=?').get(id);
  if (!f) throw new Error(`no fact #${id}`);
  for (const s of db.prepare('SELECT file FROM fact_sources WHERE fact_id=?').all(id)) {
    const h = hashFile(root, s.file);
    if (h === null) throw new Error(`source missing: ${s.file}`);
    db.prepare('UPDATE fact_sources SET hash=? WHERE fact_id=? AND file=?').run(h, id, s.file);
  }
  db.prepare('UPDATE facts SET last_verified=? WHERE id=?').run(Date.now(), id);
}

export function factsFor(ctx, ts) {
  if (!ts.length) return [];
  return listFacts(ctx).filter((f) => {
    const hay = splitWords(`${f.claim} ${f.sources.map((s) => s.file).join(' ')}`);
    return ts.some((t) => hay.includes(t) || (t.length >= 4 && hay.some((h) => h.startsWith(t))));
  });
}

export function formatFacts(facts) {
  if (!facts.length) return 'no facts';
  return facts.map((f) => `#${f.id} [${f.status}] ${f.claim}  (src: ${f.sources.map((s) => s.file).join(', ') || 'none'}; ${f.kind}, conf ${f.confidence}, ${ago(f.last_verified)})`).join('\n');
}

// ---- failure and error memory
const norm = (s) => String(s ?? '').toLowerCase().replace(/0x[0-9a-f]+/g, 'H').replace(/\d+/g, 'N').replace(/(\/[\w.-]+)+/g, 'P');
export const errorSignature = (text) => {
  const line = String(text).split('\n').find((l) => /error|exception|failed|traceback|cannot|not found|denied|undefined/i.test(l)) ?? String(text).split('\n')[0] ?? '';
  return norm(line).replace(/\s+/g, ' ').trim().slice(0, 160);
};
const toks = (s) => new Set(splitWords(norm(s)).filter((w) => w.length > 2));
const jaccard = (a, b) => { if (!a.size || !b.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); };

export function addFailure({ db, dir }, o) {
  const { lastInsertRowid: id } = db.prepare('INSERT INTO failures(kind,signature,tried,result,reason,retry_if,solution,files,task_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(o.kind ?? 'failed', o.signature ?? errorSignature(o.error ?? o.tried ?? ''), o.tried ?? null, o.result ?? null, o.reason ?? null,
      o.retry_if ?? null, o.solution ?? null, (o.files ?? []).join(','), currentTask(dir), Date.now());
  return Number(id);
}

export function findFailures({ db }, text, min = 0.35) {
  const q = toks(text);
  return db.prepare('SELECT * FROM failures').all()
    .map((f) => ({ f, score: jaccard(q, toks(`${f.signature} ${f.tried ?? ''} ${f.reason ?? ''} ${f.solution ?? ''}`)) }))
    .filter((x) => x.score >= min).sort((a, b) => b.score - a.score).slice(0, 3);
}

export function formatFailure(f) {
  return f.kind === 'resolved'
    ? `#${f.id} RESOLVED ${f.signature}\n  cause: ${f.reason ?? '?'}\n  fix: ${f.solution}\n  files: ${f.files || '-'}${f.tried ? '\n  failed approaches: ' + f.tried : ''}${f.result ? '\n  verified: ' + f.result : ''}`
    : `#${f.id} FAILED tried: ${f.tried}\n  result: ${f.result ?? '-'}\n  because: ${f.reason ?? '-'}\n  do not repeat unless: ${f.retry_if ?? '-'}`;
}

// ---- developer DNA: only patterns observed in >=3 files with >=70% share, or manually confirmed with >=3 sources
const MIN_EVIDENCE = 3;
export function observeDna({ db }, key, value, src) {
  db.prepare('INSERT OR IGNORE INTO dna(key,value,src,ts) VALUES(?,?,?,?)').run(key, value, src, Date.now());
}

export function scanDna(ctx) {
  const { db, root } = ctx; ensureIndex(db, root);
  const files = listFiles(root, SRC_EXT).filter((f) => !/\.(min)\./.test(f)).slice(0, 400);
  const tally = (key, pick) => {
    const c = {}; let n = 0;
    for (const f of files) {
      let t; try { t = readFileSync(join(root, f), 'utf8'); } catch { continue; }
      const v = pick(t, f); if (!v) continue; c[v] = (c[v] ?? 0) + 1; n++; observeDna(ctx, key, v, f);
    }
    return { c, n };
  };
  tally('indent', (t) => { const m = t.match(/^( +|\t)\S/m); return m ? (m[1] === '\t' ? 'tabs' : `${m[1].length}-spaces`) : null; });
  tally('quotes', (t, f) => { if (!/\.(m?js|ts|tsx|jsx|cjs)$/.test(f)) return null; const s = (t.match(/'/g) ?? []).length; const d = (t.match(/"/g) ?? []).length; return s + d < 6 ? null : s >= d ? 'single' : 'double'; });
  tally('semicolons', (t, f) => { if (!/\.(m?js|ts|tsx|jsx|cjs)$/.test(f)) return null; const l = t.split('\n').filter((x) => /\S/.test(x)); if (l.length < 10) return null; return l.filter((x) => /;\s*$/.test(x)).length / l.length > 0.3 ? 'yes' : 'no'; });
  tally('modules', (t, f) => { if (!/\.(m?js|ts|tsx|jsx|cjs)$/.test(f)) return null; return /^\s*(import|export)\s/m.test(t) ? 'esm' : /require\(|module\.exports/.test(t) ? 'cjs' : null; });
  const fns = db.prepare("SELECT line_end-line_start+1 len FROM symbols WHERE kind IN ('function','method')").all().map((r) => r.len).sort((a, b) => a - b);
  if (fns.length >= 10) { const med = fns[Math.floor(fns.length / 2)]; observeDna(ctx, 'function-length', med <= 25 ? 'short(median<=25 lines)' : 'long(median>25 lines)', 'index:' + fns.length); }
  try {
    const subjects = execFileSync('git', ['log', '-n', '100', '--pretty=%s'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean);
    subjects.forEach((s, i) => observeDna(ctx, 'commit-style', /^(feat|fix|chore|docs|refactor|test|perf|build|ci|style)(\(.+\))?!?:/.test(s) ? 'conventional' : 'free-form', `commit:${i}`));
  } catch { /* not a git repo */ }
  return showDna(ctx);
}

export function showDna({ db }, { pending = false } = {}) {
  const rows = db.prepare('SELECT key,value,COUNT(*) n FROM dna GROUP BY key,value').all();
  const byKey = {};
  for (const r of rows) (byKey[r.key] ??= []).push(r);
  const out = [];
  for (const [k, list] of Object.entries(byKey)) {
    const total = list.reduce((a, r) => a + r.n, 0); list.sort((a, b) => b.n - a.n);
    const top = list[0]; const share = top.n / total;
    const confirmed = top.n >= MIN_EVIDENCE && share >= 0.7;
    if (confirmed && !pending) out.push(`${k}: ${top.value}  (${top.n}/${total})`);
    if (!confirmed && pending) out.push(`pending ${k}: ${list.map((r) => `${r.value} x${r.n}`).join(', ')}`);
  }
  return out.length ? out.join('\n') : (pending ? 'nothing pending' : 'no confirmed preferences yet (need >=3 observations and >=70% share)');
}
