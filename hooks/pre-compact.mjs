// Saves mechanical state before compaction so SessionStart(compact) can rebuild it, and resets the read log.
import { run } from './lib.mjs';
import { saveCheckpoint } from '../src/state.mjs';

run(({ ctx, session, task }) => {
  const { db } = ctx;
  if (task) {
    const files = db.prepare("SELECT DISTINCT file FROM events WHERE session=? AND kind='edit' AND file IS NOT NULL").all(session).map((r) => r.file);
    const t = db.prepare("SELECT sig,ok,n FROM events WHERE session=? AND kind='bash' AND sig GLOB '*test*' ORDER BY id DESC LIMIT 1").get(session);
    const prev = db.prepare('SELECT body FROM checkpoints WHERE task_id=? ORDER BY id DESC LIMIT 1').get(task);
    const base = prev ? JSON.parse(prev.body) : {};
    saveCheckpoint(ctx, { ...base, files: [...new Set([...(base.files ? String(base.files).split(',') : []), ...files])].join(','),
      tests: t ? `${t.sig.slice(0, 60)} -> ${t.ok ? 'passed' : 'failed'}${t.n ? ` (${t.n} failing)` : ''}` : base.tests, state: undefined });
  }
  db.prepare("DELETE FROM events WHERE session=? AND kind='read'").run(session);
});
