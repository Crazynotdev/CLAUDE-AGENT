// Task state machine, compact checkpoints, session reconstruction, loop control and stagnation detection.
import { ensureIndex, stats } from './indexer.mjs';
import { currentTask, setCurrentTask } from './db.mjs';
import { listFacts } from './memory.mjs';

export const STATES = ['DISCOVERING', 'UNDERSTANDING', 'PLANNING', 'IMPLEMENTING', 'TESTING', 'REVIEWING', 'VERIFYING', 'DONE', 'BLOCKED'];

export function startTask({ db, dir, cfg }, goal, { risk = null, profile = null } = {}) {
  const { lastInsertRowid: id } = db.prepare('INSERT INTO tasks(goal,state,risk,profile,started_at) VALUES(?,?,?,?,?)')
    .run(goal, 'DISCOVERING', risk, profile ?? cfg.profile, Date.now());
  setCurrentTask(dir, Number(id));
  return Number(id);
}

export function setState({ db, dir }, state) {
  state = state.toUpperCase();
  if (!STATES.includes(state)) throw new Error(`state must be one of ${STATES.join(', ')}`);
  const id = currentTask(dir); if (!id) throw new Error('no current task: run `crazy task start "<goal>"`');
  db.prepare('UPDATE tasks SET state=?, ended_at=? WHERE id=?').run(state, state === 'DONE' ? Date.now() : null, id);
  return id;
}

const CP_FIELDS = ['goal', 'state', 'files', 'decisions', 'changes', 'tests', 'open', 'next'];
export function saveCheckpoint({ db, dir }, f) {
  const id = currentTask(dir); if (!id) throw new Error('no current task');
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  const body = { goal: f.goal ?? t.goal, state: f.state ?? t.state };
  for (const k of CP_FIELDS.slice(2)) if (f[k]) body[k] = String(f[k]);
  if (f.state) setState({ db, dir }, f.state);
  db.prepare('INSERT INTO checkpoints(task_id,ts,body) VALUES(?,?,?)').run(id, Date.now(), JSON.stringify(body));
  return id;
}

export function formatCheckpoint(body) {
  const L = { goal: 'GOAL', state: 'STATE', files: 'FILES', decisions: 'DECISIONS', changes: 'CHANGES', tests: 'TESTS', open: 'OPEN', next: 'NEXT' };
  return Object.entries(L).filter(([k]) => body[k]).map(([k, v]) => `${v}: ${body[k]}`).join('\n');
}

export function lastCheckpoint({ db, dir }) {
  const id = currentTask(dir); if (!id) return null;
  const r = db.prepare('SELECT body FROM checkpoints WHERE task_id=? ORDER BY id DESC LIMIT 1').get(id);
  return r ? JSON.parse(r.body) : null;
}

export function resume(ctx, { brief = false } = {}) {
  const { db, dir, root } = ctx;
  ensureIndex(db, root);
  const s = stats(db);
  const langs = db.prepare('SELECT lang, COUNT(*) c FROM files GROUP BY lang ORDER BY c DESC LIMIT 3').all().map((r) => `${r.lang}:${r.c}`).join(' ');
  const out = [`crazy: ${s.files} files, ${s.symbols} symbols indexed (${langs}). Use \`.crazy/crazy ctx "<topic>"\` before reading files.`];
  const id = currentTask(dir);
  if (id) {
    const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (t && t.state !== 'DONE') {
      out.push(`task #${id} [${t.state}]: ${t.goal}`);
      const cp = lastCheckpoint(ctx);
      if (cp) {
        out.push(formatCheckpoint(cp));
        const files = String(cp.files ?? '').split(/[,;\s]+/).filter(Boolean);
        const facts = listFacts(ctx).filter((f) => f.sources.some((x) => files.includes(x.file))).slice(0, brief ? 3 : 6);
        for (const f of facts) out.push(`fact #${f.id} [${f.status}]: ${f.claim}`);
      }
      const fails = db.prepare('SELECT * FROM failures WHERE task_id=? AND kind=? ORDER BY id DESC LIMIT 3').all(id, 'failed');
      for (const f of fails) out.push(`do not repeat: ${f.tried} (${f.reason ?? f.result ?? 'failed'})`);
    }
  }
  return out.join('\n');
}

// ---- stagnation
function recent(db, session, n = 14) {
  return db.prepare('SELECT * FROM events WHERE session=? ORDER BY id DESC LIMIT ?').all(session, n).reverse();
}

export function checkStagnation({ db }, session = 'cli') {
  const ev = recent(db, session);
  const reasons = [];
  const bash = ev.filter((e) => e.kind === 'bash');
  const count = (arr, f) => arr.reduce((m, e) => { const k = f(e); if (k) m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const fails = bash.filter((e) => e.ok === 0);
  for (const [k, v] of Object.entries(count(fails, (e) => e.sig))) if (v >= 3) reasons.push(`same failing command x${v}: ${k.slice(0, 60)}`);
  const errs = count(fails, (e) => { try { return JSON.parse(e.payload ?? '{}').err; } catch { return null; } });
  for (const [k, v] of Object.entries(errs)) if (v >= 3) reasons.push(`same error x${v}: ${k.slice(0, 60)}`);
  for (const [k, v] of Object.entries(count(ev.filter((e) => e.kind === 'edit'), (e) => e.file))) if (v >= 4) reasons.push(`file edited ${v}x in the last ${ev.length} events: ${k}`);
  const tests = bash.filter((e) => e.n !== null && e.n !== undefined && /test|jest|pytest|vitest|mocha/i.test(e.sig ?? '')).slice(-3);
  if (tests.length === 3 && tests[2].n >= tests[0].n && tests[2].n > 0) reasons.push(`failing tests not decreasing (${tests.map((t) => t.n).join(' -> ')})`);
  return { stagnant: reasons.length > 0, reasons,
    advice: reasons.length ? 'STOP. Analyze why the last attempts did not move the state. Record it with `crazy fail add`, then change strategy (different hypothesis, smaller repro, or ask the user).' : '' };
}

// ---- loop control
export function loopStart({ db, dir, cfg }, max) {
  const id = currentTask(dir);
  db.prepare("DELETE FROM events WHERE kind='loop' AND session='loop'").run();
  db.prepare("INSERT INTO events(ts,session,task_id,kind,n,payload) VALUES(?,?,?,?,?,?)").run(Date.now(), 'loop', id, 'loop', 0, JSON.stringify({ max: Number(max) || cfg.loopMaxIterations, start: true }));
}
export function loopStep({ db, dir }, { progress = 0, note = '', risk = 'LOW' } = {}) {
  const i = db.prepare("SELECT COUNT(*) c FROM events WHERE kind='loop' AND session='loop' AND payload NOT LIKE '%\"start\"%'").get().c + 1;
  db.prepare("INSERT INTO events(ts,session,task_id,kind,n,payload) VALUES(?,?,?,?,?,?)").run(Date.now(), 'loop', currentTask(dir), 'loop', i, JSON.stringify({ progress: Number(progress), note, risk }));
  return i;
}
export function loopCheck(ctx, session = 'cli') {
  const { db } = ctx;
  const start = db.prepare("SELECT payload FROM events WHERE kind='loop' AND session='loop' AND payload LIKE '%\"start\"%' ORDER BY id DESC LIMIT 1").get();
  const max = start ? JSON.parse(start.payload).max : ctx.cfg.loopMaxIterations;
  const steps = db.prepare("SELECT payload FROM events WHERE kind='loop' AND session='loop' AND payload NOT LIKE '%\"start\"%' ORDER BY id").all().map((r) => JSON.parse(r.payload));
  if (steps.some((s) => s.done)) return { verdict: 'STOP', reason: 'goal reached' };
  if (steps.length >= max) return { verdict: 'STOP', reason: `max iterations (${max}) reached; report status to the user` };
  const last3 = steps.slice(-3);
  if (last3.length === 3 && last3.every((s) => s.progress <= 0)) return { verdict: 'STOP', reason: 'no progress in the last 3 iterations; change strategy or ask the user' };
  const rank = { LOW: 0, MEDIUM: 1, HIGH: 2 };
  const l2 = steps.slice(-2);
  if (l2.length === 2 && rank[l2[1].risk] > rank[l2[0].risk] && l2[1].risk === 'HIGH') return { verdict: 'STOP', reason: 'risk rose to HIGH; human decision required' };
  const st = checkStagnation(ctx, session);
  if (st.stagnant) return { verdict: 'STOP', reason: `stagnation: ${st.reasons[0]}` };
  return { verdict: 'CONTINUE', reason: `iteration ${steps.length}/${max}` };
}
export function loopDone({ db, dir }) {
  db.prepare("INSERT INTO events(ts,session,task_id,kind,n,payload) VALUES(?,?,?,?,?,?)").run(Date.now(), 'loop', currentTask(dir), 'loop', 999, JSON.stringify({ done: true, progress: 1 }));
}
