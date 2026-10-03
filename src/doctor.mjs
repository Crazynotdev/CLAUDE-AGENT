import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stats, ensureIndex } from './indexer.mjs';
import { scan } from './security.mjs';
import { latestTranscript, analyzeTranscript } from './cost.mjs';
import { tok } from './util.mjs';

const MARK = '.crazy/runtime/hooks/';
const SAMPLE = { SessionStart: { hook_event_name: 'SessionStart', session_id: 'doctor', source: 'startup' },
  PreToolUse: { hook_event_name: 'PreToolUse', session_id: 'doctor', tool_name: 'Bash', tool_input: { command: 'echo doctor' } },
  PostToolUse: { hook_event_name: 'PostToolUse', session_id: 'doctor', tool_name: 'Bash', tool_input: { command: 'echo doctor' }, tool_response: { stdout: 'doctor', stderr: '' } },
  PreCompact: { hook_event_name: 'PreCompact', session_id: 'doctor' } };
const FILES = { SessionStart: 'session-start.mjs', PreToolUse: 'pre-tool.mjs', PostToolUse: 'post-tool.mjs', PreCompact: 'pre-compact.mjs' };

export function doctor(ctx) {
  const { db, dir, root } = ctx; const rows = []; let bad = 0;
  const ok = (m) => rows.push(`ok   ${m}`); const warn = (m) => rows.push(`warn ${m}`); const fail = (m) => { bad++; rows.push(`FAIL ${m}`); };
  const [maj, min] = process.versions.node.split('.').map(Number);
  (maj > 22 || (maj === 22 && min >= 5)) ? ok(`node ${process.versions.node} (node:sqlite available)`) : fail(`node ${process.versions.node}: need >= 22.5 for node:sqlite`);
  const g = spawnSync('git', ['--version'], { encoding: 'utf8' }); g.status === 0 ? ok(g.stdout.trim()) : warn('git not found: blast compare, bench and DNA commit analysis need it');
  const c = spawnSync(process.env.CRAZY_CLAUDE_BIN ?? 'claude', ['--version'], { encoding: 'utf8' }); c.status === 0 ? ok(`claude ${c.stdout.trim()}`) : warn('claude binary not found on PATH (needed for bench only)');
  try { JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')); ok('config.json valid'); } catch { existsSync(join(dir, 'config.json')) ? fail('config.json is not valid JSON') : warn('no config.json (defaults in use; run `crazy install`)'); }
  const ic = db.prepare('PRAGMA integrity_check').get(); Object.values(ic)[0] === 'ok' ? ok('store.db integrity ok') : fail('store.db integrity check failed');
  const st = ensureIndex(db, root); const s = stats(db); ok(`index: ${s.files} files, ${s.symbols} symbols, ${s.edges} import edges, ${s.refs} refs (${st.changed} re-indexed now)`);
  const sp = join(root, '.claude', 'settings.json'); let settings = {};
  try { settings = JSON.parse(readFileSync(sp, 'utf8')); } catch { /* handled below */ }
  for (const ev of Object.keys(FILES)) {
    const reg = (settings.hooks?.[ev] ?? []).some((gr) => gr.hooks?.some((h) => h.command?.includes(MARK + FILES[ev])));
    const file = join(dir, 'runtime', 'hooks', FILES[ev]);
    if (!reg) { warn(`hook ${ev} not registered in .claude/settings.json (run \`crazy install\`)`); continue; }
    if (!existsSync(file)) { fail(`hook ${ev}: ${FILES[ev]} missing`); continue; }
    const r = spawnSync('node', ['--disable-warning=ExperimentalWarning', file], { input: JSON.stringify({ ...SAMPLE[ev], cwd: root }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
    let valid = true; if (r.stdout.trim()) { try { JSON.parse(r.stdout); } catch { valid = false; } }
    r.status === 0 && valid ? ok(`hook ${ev} runs, exit 0, valid output`) : fail(`hook ${ev} failed (exit ${r.status}, valid json ${valid}): ${(r.stderr || '').slice(0, 120)}`);
  }
  db.prepare("DELETE FROM events WHERE session='doctor'").run();
  const t = latestTranscript(root);
  if (!t) warn('no Claude Code transcripts found for this project yet: `crazy cost` has nothing to read');
  else { const a = analyzeTranscript(t); a.fieldsSeen.usage && a.fieldsSeen.toolUse ? ok(`transcript format recognised (${a.turns} turns, ${a.toolCallTotal} tool calls)`) : warn('transcript found but usage or tool_use fields not recognised: cost numbers will be incomplete'); }
  const inj = db.prepare("SELECT session, SUM(n) n FROM events WHERE kind='inject' AND session!='doctor' GROUP BY session ORDER BY MAX(id) DESC LIMIT 10").all();
  if (inj.length) { const avg = inj.reduce((a, r) => a + r.n, 0) / inj.length / 4; ok(`self-cost: hooks injected ~${Math.round(avg)} tokens per session (last ${inj.length} sessions)`); } else ok('self-cost: no injections recorded yet');
  const hi = scan(root, { quick: true }).filter((f) => f.sev === 'high');
  hi.length ? warn(`${hi.length} high-severity finding(s) in README/CLAUDE.md/config: run \`crazy scan\``) : ok('quick security scan: nothing high-severity');
  return { text: rows.join('\n') + `\n${bad ? bad + ' problem(s)' : 'no blocking problems'}`, bad };
}
