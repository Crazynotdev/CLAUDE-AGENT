// Shared hook plumbing. A hook must never break the session: any failure exits 0 silently (logged to .crazy/hook-errors.log).
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { open, currentTask, logEvent } from '../src/db.mjs';

export async function readInput() {
  let s = '';
  for await (const c of process.stdin) s += c;
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}
export const emit = (o) => process.stdout.write(JSON.stringify(o));
export function context(event, text) { return { hookEventName: event, additionalContext: text }; }
export function relPath(root, p) {
  if (!p) return null;
  return p.startsWith(root + '/') ? p.slice(root.length + 1) : p.startsWith('/') ? null : p;
}
export async function run(fn) {
  const input = await readInput();
  let ctx;
  try {
    ctx = open(input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
    const session = input.session_id ?? 'unknown';
    const out = await fn({ input, ctx, session, task: currentTask(ctx.dir) });
    if (out?.text) logEvent(ctx.db, { session, task_id: currentTask(ctx.dir), kind: 'inject', n: out.text.length, sig: input.hook_event_name });
    if (out?.json) emit(out.json);
  } catch (e) {
    try { appendFileSync(join(ctx?.dir ?? process.cwd(), 'hook-errors.log'), `${new Date().toISOString()} ${e.stack ?? e}\n`); } catch { /* nothing else to do */ }
  }
  process.exit(0);
}
