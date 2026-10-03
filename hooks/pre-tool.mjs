// Zero-waste guard: blocks only exact repeats of work whose inputs have not changed. Escape hatch: prefix a command with CRAZY_FORCE=1.
import { run, relPath } from './lib.mjs';
import { hashFile } from '../src/util.mjs';

const REPEATABLE = /\b(test|jest|pytest|vitest|mocha|lint|eslint|tsc|build|typecheck)\b/i;
const deny = (reason) => ({ text: reason, json: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } });

run(({ input, ctx, session }) => {
  const { db, root, cfg } = ctx;
  if (cfg.antiRepeat.mode !== 'block') return;
  const ti = input.tool_input ?? {};
  if (input.tool_name === 'Read') {
    if (ti.offset || ti.limit) return;
    const rel = relPath(root, ti.file_path); if (!rel) return;
    const reads = db.prepare("SELECT id,sig FROM events WHERE session=? AND kind='read' AND file=? ORDER BY id").all(session, rel);
    if (reads.length < cfg.antiRepeat.after) return;
    const lastEdit = db.prepare("SELECT MAX(id) m FROM events WHERE session=? AND kind='edit' AND file=?").get(session, rel).m ?? 0;
    const cur = hashFile(root, rel);
    if (reads[reads.length - 1].sig === cur && lastEdit < reads[reads.length - 1].id)
      return deny(`crazy: ${rel} was already read ${reads.length}x this session and is unchanged. Use \`.crazy/crazy ctx "<topic>"\` for symbol line ranges, then Read with offset/limit.`);
  } else if (input.tool_name === 'Bash') {
    const cmd = String(ti.command ?? '').replace(/\s+/g, ' ').trim();
    if (!REPEATABLE.test(cmd) || /CRAZY_FORCE=1|\.crazy\/crazy/.test(cmd)) return;
    const prev = db.prepare("SELECT id,ok FROM events WHERE session=? AND kind='bash' AND sig=? ORDER BY id DESC LIMIT 1").get(session, cmd.slice(0, 200));
    if (!prev) return;
    const edited = db.prepare("SELECT 1 FROM events WHERE session=? AND kind='edit' AND id>?").get(session, prev.id);
    if (!edited) return deny(`crazy: this exact command already ran (${prev.ok ? 'passed' : 'failed'}) and no file was edited since. Change something first, or prefix with CRAZY_FORCE=1 if the rerun is intentional.`);
  }
});
