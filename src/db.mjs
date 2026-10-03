import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { findRoot } from './util.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, hash TEXT, lang TEXT, size INT, mtime INT, indexed_at INT, is_test INT DEFAULT 0);
CREATE TABLE IF NOT EXISTS symbols(id INTEGER PRIMARY KEY, file TEXT, name TEXT, kind TEXT, parent TEXT, line_start INT, line_end INT, sig TEXT, exported INT DEFAULT 0);
CREATE INDEX IF NOT EXISTS sym_file ON symbols(file);
CREATE INDEX IF NOT EXISTS sym_name ON symbols(name);
CREATE TABLE IF NOT EXISTS edges(src TEXT, dst TEXT, kind TEXT, PRIMARY KEY(src,dst,kind));
CREATE TABLE IF NOT EXISTS refs(src TEXT, symbol_id INT, PRIMARY KEY(src,symbol_id));
CREATE TABLE IF NOT EXISTS facts(id INTEGER PRIMARY KEY, claim TEXT, scope TEXT DEFAULT 'project', kind TEXT, confidence REAL, created_at INT, last_verified INT);
CREATE TABLE IF NOT EXISTS fact_sources(fact_id INT, file TEXT, hash TEXT);
CREATE TABLE IF NOT EXISTS failures(id INTEGER PRIMARY KEY, kind TEXT, signature TEXT, tried TEXT, result TEXT, reason TEXT, retry_if TEXT, solution TEXT, files TEXT, task_id INT, created_at INT);
CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY, goal TEXT, state TEXT, risk TEXT, profile TEXT, started_at INT, ended_at INT);
CREATE TABLE IF NOT EXISTS checkpoints(id INTEGER PRIMARY KEY, task_id INT, ts INT, body TEXT);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, ts INT, session TEXT, task_id INT, kind TEXT, sig TEXT, file TEXT, ok INT, n INT, payload TEXT);
CREATE INDEX IF NOT EXISTS ev_sess ON events(session, id);
CREATE TABLE IF NOT EXISTS raw_outputs(id INTEGER PRIMARY KEY, cmd TEXT, bytes INT, exit INT, path TEXT, created_at INT);
CREATE TABLE IF NOT EXISTS dna(key TEXT, value TEXT, src TEXT, ts INT, PRIMARY KEY(key,value,src));
CREATE TABLE IF NOT EXISTS runs(id INTEGER PRIMARY KEY, task TEXT, category TEXT, config TEXT, rep INT, usage TEXT, cost REAL, duration_ms INT, turns INT, tool_calls INT, files_read INT, files_changed INT, passed INT, ts INT);
`;

export const DEFAULT_CONFIG = {
  profile: 'balanced',
  antiRepeat: { mode: 'block', after: 2 },
  sessionStartMaxChars: 2400,
  budgets: { trivial: 300, small: 800, medium: 1800, large: 4000, critical: 8000 },
  loopMaxIterations: 8,
  claudeArgs: ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Bash Edit Write Read Grep Glob'],
};

export function loadConfig(dir) {
  const p = join(dir, 'config.json');
  let user = {};
  if (existsSync(p)) { try { user = JSON.parse(readFileSync(p, 'utf8')); } catch { /* doctor reports it */ } }
  return { ...DEFAULT_CONFIG, ...user, antiRepeat: { ...DEFAULT_CONFIG.antiRepeat, ...user.antiRepeat },
    budgets: { ...DEFAULT_CONFIG.budgets, ...user.budgets } };
}

export function saveConfig(dir, cfg) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
}

export function open(cwd = process.cwd()) {
  const root = findRoot(cwd);
  const dir = join(root, '.crazy');
  mkdirSync(join(dir, 'raw'), { recursive: true });
  const db = new DatabaseSync(join(dir, 'store.db'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;');
  db.exec(SCHEMA);
  return { db, dir, root, cfg: loadConfig(dir) };
}

export function currentTask(dir) {
  try { return JSON.parse(readFileSync(join(dir, 'current.json'), 'utf8')).id ?? null; } catch { return null; }
}
export function setCurrentTask(dir, id) {
  writeFileSync(join(dir, 'current.json'), JSON.stringify({ id }));
}
export function logEvent(db, e) {
  db.prepare('INSERT INTO events(ts,session,task_id,kind,sig,file,ok,n,payload) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(Date.now(), e.session ?? 'cli', e.task_id ?? null, e.kind, e.sig ?? null, e.file ?? null,
      e.ok === undefined ? null : (e.ok ? 1 : 0), e.n ?? null, e.payload ? JSON.stringify(e.payload) : null);
}
