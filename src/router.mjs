// Token router: task text + project signals -> class, model, thinking, context budget, agents, gates.
// Heuristic. Thresholds are starting points to be tuned from `crazy bench` results.
import { buildContext, terms } from './ctx.mjs';
import { findFailures } from './memory.mjs';
import { currentTask } from './db.mjs';
import { ensureIndex } from './indexer.mjs';

const KW = {
  critical: /\b(security|secur|auth|oauth|jwt|password|payment|paiement|wallet|billing|refund|crypto|secret|token|injection|xss|csrf|permission|rce|migration en prod|production data|drop table)\b/i,
  large: /\b(refactor|migrate|migration|redesign|rewrite|architecture|schema|re-?architect|multi[- ]?tenant|new module|from scratch)\b/i,
  trivial: /\b(rename|typo|comment|format|lint|whitespace|bump|version|readme|docstring|log message|spelling)\b/i,
  small: /\b(fix|bug|error|crash|fails?|broken|wrong|adjust|tweak|small|simple)\b/i,
};
const TIERS = ['haiku', 'sonnet', 'opus'];
const THINK = [['off', 0], ['low', 2000], ['medium', 8000], ['high', 16000], ['max', 32000]];

export function route(ctx, desc, { profile, files } = {}) {
  const { db, root, cfg, dir } = ctx;
  ensureIndex(db, root);
  const prof = profile ?? cfg.profile;
  const bias = { economy: -0.15, balanced: 0, quality: 0.15, critical: 0.3 }[prof] ?? 0;
  const reasons = [];
  let cls = 'medium'; let d = 0.45;
  if (KW.critical.test(desc)) { cls = 'critical'; d = 0.9; reasons.push('sensitive domain keywords'); }
  else if (KW.large.test(desc)) { cls = 'large'; d = 0.7; reasons.push('structural change keywords'); }
  else if (KW.trivial.test(desc) && !KW.small.test(desc)) { cls = 'trivial'; d = 0.1; reasons.push('mechanical change keywords'); }
  else if (KW.small.test(desc)) { cls = 'small'; d = 0.3; reasons.push('localized bug keywords'); }
  else reasons.push('no strong keyword: medium by default');

  const c = buildContext(ctx, desc, { budget: 'medium', json: true });
  const nFiles = files ?? c.files.length;
  if (!c.files.length && cls !== 'trivial') { d += 0.15; reasons.push('no matching symbols in the index (uncertain)'); }
  if (nFiles >= 5) { d += 0.1; reasons.push(`${nFiles} relevant files`); }
  if (!c.known.length && cls !== 'trivial') { d += 0.05; reasons.push('no verified knowledge for this topic'); }
  const prior = findFailures(ctx, desc, 0.3).length;
  if (prior) { d += 0.1; reasons.push(`${prior} related past failure(s)`); }
  const task = currentTask(dir);
  const taskFails = task ? db.prepare("SELECT COUNT(*) c FROM failures WHERE task_id=? AND kind='failed'").get(task).c : 0;
  let escalate = 0;
  if (taskFails >= 1) { escalate = 1; reasons.push('previous attempt failed on this task: escalate one tier'); }
  d = Math.min(1, Math.max(0, d + bias));
  if (prof === 'critical') cls = 'critical';

  let tier = d < 0.25 ? 0 : d < 0.7 ? 1 : 2;
  tier = Math.min(2, tier + escalate);
  if (cls === 'critical' || cls === 'large') tier = Math.max(tier, cls === 'critical' ? 2 : 1); // never a weak model on complex work
  const thinkIdx = d < 0.2 ? 0 : d < 0.4 ? 1 : d < 0.65 ? 2 : d < 0.85 ? 3 : 4;
  const budget = { trivial: 'trivial', small: 'small', medium: 'medium', large: 'large', critical: 'critical' }[cls];
  const agents = [];
  if (cls === 'large' || (c.files.length === 0 && cls !== 'trivial')) agents.push('scout');
  if (cls !== 'trivial') agents.push('builder');
  if (cls === 'large' || cls === 'critical') agents.push('reviewer (fresh context)');
  if (cls === 'critical') agents.push('security-reviewer');
  const gates = { trivial: ['verify'], small: ['targeted tests', 'verify'], medium: ['targeted tests', 'review of diff', 'verify'],
    large: ['plan gate', 'tests', 'fresh review', 'verify'], critical: ['plan gate', 'tests', 'fresh review', 'security gate', 'verify', 'human approval'] }[cls];
  return { class: cls, profile: prof, difficulty: Number(d.toFixed(2)), model: TIERS[tier], thinking: { level: THINK[thinkIdx][0], tokens: THINK[thinkIdx][1] },
    contextBudget: budget, contextTokens: cfg.budgets[budget], agents, gates, reasons };
}

export function formatRoute(r) {
  return [`class=${r.class} profile=${r.profile} difficulty=${r.difficulty}`,
    `model=${r.model} thinking=${r.thinking.level}${r.thinking.tokens ? ` (~${r.thinking.tokens} tok; MAX_THINKING_TOKENS=${r.thinking.tokens})` : ''}`,
    `context=${r.contextBudget} (~${r.contextTokens} tok)`, `agents: ${r.agents.join(' -> ') || 'main session only'}`,
    `gates: ${r.gates.join(' -> ')}`, `why: ${r.reasons.join('; ')}`].join('\n');
}
