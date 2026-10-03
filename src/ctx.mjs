// Context engine: query -> ranked symbol capsule under a token budget.
import { ensureIndex, fileRisk } from './indexer.mjs';
import { splitWords, tok } from './util.mjs';
import { factsFor } from './memory.mjs';

const STOP = new Set(['the', 'and', 'for', 'with', 'fix', 'bug', 'add', 'implement', 'make', 'how', 'does', 'work',
  'code', 'file', 'function', 'where', 'what', 'that', 'this', 'from', 'into', 'issue', 'error', 'update', 'change']);

export const terms = (q) => [...new Set(splitWords(q).filter((w) => w.length >= 3 && !STOP.has(w)))];

function scoreSymbol(s, ts) {
  const nameT = splitWords(s.name); const pathT = splitWords(s.file);
  let sc = 0;
  for (const t of ts) {
    if (nameT.includes(t)) sc += 3;
    else if (t.length >= 4 && nameT.some((n) => n.startsWith(t) || (n.length >= 4 && t.startsWith(n)))) sc += 1.5;
    if (pathT.includes(t)) sc += 1;
    else if (t.length >= 4 && pathT.some((p) => p.startsWith(t))) sc += 0.5;
  }
  return sc > 0 ? sc + (['class', 'function', 'method', 'route'].includes(s.kind) ? 0.3 : 0) : 0;
}

export function resolveBudget(b, cfg) {
  if (!b) return cfg.budgets.small;
  if (cfg.budgets[b]) return cfg.budgets[b];
  const n = Number(b); return Number.isFinite(n) && n > 0 ? n : cfg.budgets.small;
}

export function buildContext(ctx, query, { budget, json = false } = {}) {
  const { db, root, cfg } = ctx;
  ensureIndex(db, root);
  const B = resolveBudget(budget, cfg); const ts = terms(query);
  const all = db.prepare('SELECT s.*, f.mtime FROM symbols s JOIN files f ON f.path=s.file').all();
  const scored = new Map();
  let max = 0;
  for (const s of all) { const sc = scoreSymbol(s, ts); if (sc > 0) { scored.set(s.id, { s, rel: sc, prox: 1 }); max = Math.max(max, sc); } }
  const seeds = [...scored.values()].sort((a, b) => b.rel - a.rel).slice(0, 8);
  const seedFiles = new Set(seeds.map((x) => x.s.file));
  // 1-hop expansion: symbols referenced by seed files, in neighbor files
  const neighborFiles = new Map();
  for (const f of seedFiles) {
    for (const r of db.prepare("SELECT dst f FROM edges WHERE src=? AND kind='imports' UNION SELECT src f FROM edges WHERE dst=? AND kind='imports'").all(f, f)) {
      if (!seedFiles.has(r.f)) neighborFiles.set(r.f, (neighborFiles.get(r.f) ?? 0) + 1);
    }
    for (const r of db.prepare('SELECT s.* , fl.mtime FROM refs r JOIN symbols s ON s.id=r.symbol_id JOIN files fl ON fl.path=s.file WHERE r.src=?').all(f)) {
      if (!scored.has(r.id)) scored.set(r.id, { s: r, rel: max * 0.35, prox: 0.5 });
    }
  }
  const day = 86400000; const nowMs = Date.now();
  const riskCache = new Map();
  const risk = (f) => riskCache.get(f) ?? (riskCache.set(f, fileRisk(db, f)), riskCache.get(f));
  const cands = [...scored.values()].map((c) => {
    const age = (nowMs - c.s.mtime) / day; const fresh = age < 7 ? 1 : age < 30 ? 0.5 : 0;
    const r = risk(c.s.file).level; const rw = r === 'HIGH' ? 1 : r === 'MEDIUM' ? 0.5 : 0;
    const line = `  L${c.s.line_start}-${c.s.line_end} ${c.s.kind} ${c.s.parent ? c.s.parent + '.' : ''}${c.s.name}`;
    const cost = tok(line) + 1;
    const roi = (0.6 * (c.rel / (max || 1)) + 0.2 * c.prox + 0.1 * fresh + 0.1 * rw) / Math.sqrt(cost);
    return { ...c, line, cost, roi };
  }).sort((a, b) => b.roi - a.roi);

  let used = 40; const picked = [];
  for (const c of cands) { if (used + c.cost > B) continue; picked.push(c); used += c.cost; if (picked.length >= 60) break; }
  const byFile = new Map();
  for (const c of picked) { if (!byFile.has(c.s.file)) byFile.set(c.s.file, []); byFile.get(c.s.file).push(c); }
  const files = [...byFile.entries()].sort((a, b) => Math.max(...b[1].map((x) => x.roi)) - Math.max(...a[1].map((x) => x.roi)));

  const out = [];
  for (const [f, list] of files) {
    const r = risk(f);
    const tests = r.tests.slice(0, 2).join(', ');
    out.push(`${f} [${r.level}${r.why.length ? ': ' + r.why.join('; ') : ''}]${tests ? '  tests: ' + tests : ''}`);
    for (const c of list.sort((a, b) => a.s.line_start - b.s.line_start)) out.push(c.line);
  }
  const lines = [];
  const facts = factsFor(ctx, ts);
  const known = facts.filter((f) => f.status === 'verified' || f.status === 'likely-valid').slice(0, 4)
    .map((f) => `known [${f.status}] #${f.id}: ${f.claim}`);
  const stale = facts.filter((f) => f.status === 'stale' || f.status === 'invalidated').slice(0, 2)
    .map((f) => `recheck [${f.status}] #${f.id}: ${f.claim}`);
  const fails = db.prepare('SELECT * FROM failures ORDER BY id DESC LIMIT 200').all()
    .filter((f) => ts.some((t) => `${f.signature} ${f.tried} ${f.reason}`.toLowerCase().includes(t))).slice(0, 2)
    .map((f) => f.kind === 'resolved' ? `solved before #${f.id}: ${f.signature} -> ${f.solution}`
      : `do not repeat #${f.id}: ${f.tried} (${f.reason ?? f.result})${f.retry_if ? ' unless ' + f.retry_if : ''}`);
  const shown = new Set(files.map(([f]) => f));
  const likely = [...neighborFiles.entries()].filter(([f]) => !shown.has(f)).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([f]) => f);
  if (json) return { query, terms: ts, budget: B, files: files.map(([f, l]) => ({ file: f, symbols: l.map((c) => c.line.trim()) })), known, stale, fails, likely };
  lines.push(`ctx "${query}" budget=${B} ~${used}tok symbols=${picked.length} files=${files.length}`);
  if (!picked.length) lines.push('no matching symbols: the index may not cover this term; fall back to a targeted grep for the literal string.');
  lines.push(...out, ...known, ...stale, ...fails);
  if (likely.length) lines.push(`likely next (not loaded): ${likely.join(', ')}`);
  return lines.join('\n');
}
