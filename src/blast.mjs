// Blast radius: reverse dependency walk over imports and symbol references.
import { execFileSync } from 'node:child_process';
import { ensureIndex, fileRisk, isTestPath } from './indexer.mjs';
import { currentTask, logEvent } from './db.mjs';

export function blast(ctx, targets, { depth = 3 } = {}) {
  const { db, root } = ctx; ensureIndex(db, root);
  const files = new Set();
  for (const t of targets) {
    if (db.prepare('SELECT 1 FROM files WHERE path=?').get(t)) files.add(t);
    else for (const s of db.prepare('SELECT DISTINCT file FROM symbols WHERE name=?').all(t)) files.add(s.file);
  }
  if (!files.size) return { targets, found: false };
  const affected = new Map(); let frontier = [...files];
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next = [];
    for (const f of frontier) {
      const users = new Set([
        ...db.prepare("SELECT src FROM edges WHERE dst=? AND kind='imports'").all(f).map((r) => r.src),
        ...db.prepare('SELECT DISTINCT r.src FROM refs r JOIN symbols s ON s.id=r.symbol_id WHERE s.file=?').all(f).map((r) => r.src)]);
      for (const u of users) if (!files.has(u) && !affected.has(u)) { affected.set(u, d); next.push(u); }
    }
    frontier = next;
  }
  const tests = [...affected.keys()].filter(isTestPath);
  const symbols = db.prepare(`SELECT COUNT(*) c FROM symbols WHERE file IN (${[...files].map(() => '?').join(',')})`).get(...files).c;
  const apis = db.prepare(`SELECT COUNT(*) c FROM symbols WHERE kind='route' AND file IN (${[...new Set([...files, ...affected.keys()])].map(() => '?').join(',')})`).get(...new Set([...files, ...affected.keys()])).c;
  const risks = [...files].map((f) => fileRisk(db, f));
  const top = risks.some((r) => r.level === 'HIGH') ? 'HIGH' : risks.some((r) => r.level === 'MEDIUM') ? 'MEDIUM' : 'LOW';
  const n = affected.size;
  const level = top === 'HIGH' || n >= 15 ? 'LARGE' : n >= 5 || top === 'MEDIUM' ? 'MEDIUM' : 'SMALL';
  const workflow = { SMALL: 'quick path: targeted test, short verify', MEDIUM: 'targeted tests of affected files + diff review',
    LARGE: 'reinforced: plan first, full affected tests, fresh-context review, human approval for irreversible parts' }[level];
  return { targets: [...files], found: true, affectedFiles: [...affected.keys()], depthMap: Object.fromEntries(affected), symbols, tests, apis, risk: top, level, workflow };
}

export function formatBlast(b) {
  if (!b.found) return `blast: no indexed file or symbol matches ${b.targets.join(', ')}`;
  const list = b.affectedFiles.slice(0, 15).map((f) => `${f} (d${b.depthMap[f]})`).join(', ');
  return [`blast ${b.level}: targets=${b.targets.join(', ')}`,
    `files affected=${b.affectedFiles.length} symbols in targets=${b.symbols} tests affected=${b.tests.length} api routes touched=${b.apis} risk=${b.risk}`,
    b.affectedFiles.length ? `affected: ${list}${b.affectedFiles.length > 15 ? ` +${b.affectedFiles.length - 15}` : ''}` : 'affected: none',
    b.tests.length ? `run: ${b.tests.slice(0, 8).join(', ')}` : 'no affected tests found',
    `workflow: ${b.workflow}`].join('\n');
}

export function predictBlast(ctx, targets) {
  const b = blast(ctx, targets);
  if (b.found) logEvent(ctx.db, { session: 'blast', task_id: currentTask(ctx.dir), kind: 'blast', payload: { targets: b.targets, predicted: [...b.targets, ...b.affectedFiles] } });
  return b;
}

export function compareBlast({ db, root }) {
  const row = db.prepare("SELECT payload FROM events WHERE kind='blast' ORDER BY id DESC LIMIT 1").get();
  if (!row) return 'no prediction recorded: run `crazy blast <files> --predict` before editing';
  const { predicted } = JSON.parse(row.payload); const P = new Set(predicted);
  let actual;
  try { actual = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean); }
  catch { return 'compare needs a git repository'; }
  const missed = actual.filter((f) => !P.has(f)); const hit = actual.filter((f) => P.has(f));
  const recall = actual.length ? hit.length / actual.length : 1;
  return `predicted ${predicted.length} files, actually changed ${actual.length}, covered ${hit.length} (recall ${(recall * 100).toFixed(0)}%)\n${missed.length ? 'not predicted: ' + missed.join(', ') : 'all changed files were inside the predicted radius'}`;
}
