import { run, context, relPath } from './lib.mjs';
import { hashFile } from '../src/util.mjs';
import { logEvent } from '../src/db.mjs';
import { errorSignature, findFailures, formatFailure } from '../src/memory.mjs';
import { checkStagnation } from '../src/state.mjs';

const textOf = (r) => typeof r === 'string' ? r : [r?.stdout, r?.stderr, r?.output].filter(Boolean).join('\n');
function bashOk(r) {
  if (r && typeof r === 'object') {
    for (const k of ['exitCode', 'exit_code', 'returncode', 'code']) if (typeof r[k] === 'number') return r[k] === 0;
    if (r.is_error === true || r.interrupted === true) return false;
  }
  return !/(^|\n)(npm ERR!|Traceback \(most recent call last\)|.*: command not found|\d+ (failed|failing))/.test(textOf(r));
}

run(({ input, ctx, session, task }) => {
  const { db, root } = ctx; const ti = input.tool_input ?? {}; const name = input.tool_name;
  const notes = [];
  if (name === 'Read') {
    const rel = relPath(root, ti.file_path);
    if (rel && !ti.offset && !ti.limit) logEvent(db, { session, task_id: task, kind: 'read', file: rel, sig: hashFile(root, rel) });
    return;
  }
  if (['Edit', 'Write', 'MultiEdit'].includes(name)) logEvent(db, { session, task_id: task, kind: 'edit', file: relPath(root, ti.file_path) });
  if (name === 'Bash') {
    const text = textOf(input.tool_response); const cmd = String(ti.command ?? '').replace(/\s+/g, ' ').trim();
    if (/\.crazy\/crazy/.test(cmd)) return; // crazy run already logged itself
    const ok = bashOk(input.tool_response); const tf = text.match(/(\d+)\s+(?:failed|failing)/i);
    logEvent(db, { session, task_id: task, kind: 'bash', sig: cmd.slice(0, 200), ok, n: tf ? Number(tf[1]) : (ok ? 0 : null), payload: ok ? null : { err: errorSignature(text) } });
    if (!ok) {
      const sig = errorSignature(text); const hit = findFailures(ctx, sig, 0.5)[0];
      if (hit && !db.prepare("SELECT 1 FROM events WHERE session=? AND kind='hint' AND sig=?").get(session, `err:${hit.f.id}`)) {
        logEvent(db, { session, kind: 'hint', sig: `err:${hit.f.id}` });
        notes.push(`crazy: similar error on record.\n${formatFailure(hit.f).slice(0, 500)}`);
      }
    }
    if (text.length > 12000 && !db.prepare("SELECT 1 FROM events WHERE session=? AND kind='hint' AND sig='big-output'").get(session)) {
      logEvent(db, { session, kind: 'hint', sig: 'big-output' });
      notes.push(`crazy: that output was ${text.length} chars. For noisy commands use \`.crazy/crazy run -- <cmd>\` (compressed, raw kept).`);
    }
  }
  const st = checkStagnation(ctx, session);
  if (st.stagnant) {
    const lastWarn = db.prepare("SELECT id FROM events WHERE session=? AND kind='warn' ORDER BY id DESC LIMIT 1").get(session)?.id ?? 0;
    const now = db.prepare('SELECT MAX(id) m FROM events WHERE session=?').get(session).m ?? 0;
    if (now - lastWarn > 5) { logEvent(db, { session, kind: 'warn' }); notes.push(`crazy: STAGNATION (${st.reasons[0]}). ${st.advice}`); }
  }
  if (!notes.length) return;
  const text = notes.join('\n');
  return { text, json: { hookSpecificOutput: context('PostToolUse', text) } };
});
