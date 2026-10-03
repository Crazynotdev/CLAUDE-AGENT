// Benchmark harness: baseline vs configurations on identical commits, quality gated by an oracle command.
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzeTranscript, transcriptDir, weighted } from './cost.mjs';
import { install } from './install.mjs';
import { open } from './db.mjs';
import { ensureIndex } from './indexer.mjs';

export const CONFIGS = ['baseline', 'economy', 'balanced', 'quality'];
const EXAMPLE = { tasks: [{ id: 'example-bug', category: 'bugfix', repo: '.', commit: 'HEAD',
  prompt: 'Fix the failing test in test/example.test.js without changing the test.', oracle: 'npm test --silent', timeoutSec: 900 }] };

export function benchInit(dir) {
  const p = join(dir, 'bench'); mkdirSync(p, { recursive: true });
  const f = join(p, 'tasks.json');
  if (!existsSync(f)) writeFileSync(f, JSON.stringify(EXAMPLE, null, 2) + '\n');
  return f;
}
export const loadTasks = (dir) => JSON.parse(readFileSync(join(dir, 'bench', 'tasks.json'), 'utf8')).tasks;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export function runOnce(ctx, task, config, rep) {
  const repo = resolve(ctx.root, task.repo ?? '.');
  const wt = mkdtempSync(join(tmpdir(), 'crazy-bench-'));
  git(repo, 'worktree', 'add', '--detach', wt, task.commit ?? 'HEAD');
  try {
    if (config !== 'baseline') {
      install(wt, { profile: config });
      const c = open(wt); ensureIndex(c.db, c.root); c.db.close();
    }
    const bin = process.env.CRAZY_CLAUDE_BIN ?? 'claude';
    const rest = ctx.cfg.claudeArgs.filter((a) => a !== '-p');
    const t0 = Date.now();
    const r = spawnSync(bin, ['-p', task.prompt, ...rest], { cwd: wt, encoding: 'utf8', timeout: (task.timeoutSec ?? 900) * 1000, maxBuffer: 1 << 28 });
    let res; try { res = JSON.parse(r.stdout); } catch { throw new Error(`claude did not return JSON (exit ${r.status}): ${(r.stdout || r.stderr || '').slice(0, 200)}`); }
    if (res.is_error) throw new Error(`claude reported an error: ${String(res.result).slice(0, 200)}`);
    const u = res.usage ?? {};
    const usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0 };
    let calls = 0; let read = 0;
    const tp = join(transcriptDir(wt), `${res.session_id}.jsonl`);
    if (existsSync(tp)) { const a = analyzeTranscript(tp); calls = a.toolCallTotal; read = a.filesRead; }
    const changed = git(wt, 'status', '--porcelain').split('\n').filter((l) => l && !/\s\.(crazy|claude)\b/.test(l)).length;
    let passed = null;
    if (task.oracle) passed = spawnSync(task.oracle, { shell: true, cwd: wt, timeout: 600000 }).status === 0 ? 1 : 0;
    ctx.db.prepare('INSERT INTO runs(task,category,config,rep,usage,cost,duration_ms,turns,tool_calls,files_read,files_changed,passed,ts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(task.id, task.category ?? 'misc', config, rep, JSON.stringify(usage), res.total_cost_usd ?? null, res.duration_ms ?? Date.now() - t0, res.num_turns ?? null, calls, read, changed, passed, Date.now());
    return { task: task.id, config, rep, tokens: Math.round(weighted(usage)), passed };
  } finally {
    try { git(repo, 'worktree', 'remove', '--force', wt); } catch { /* leave for manual cleanup */ }
  }
}

const med = (a) => { const s = a.filter((x) => x !== null && x !== undefined).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

export function report(ctx, { minRuns = 3 } = {}) {
  const rows = ctx.db.prepare('SELECT * FROM runs').all().map((r) => ({ ...r, w: weighted(JSON.parse(r.usage)) }));
  if (!rows.length) return 'no benchmark runs recorded: `crazy bench run --task <id> --config all`';
  const by = {};
  for (const r of rows) ((by[r.task] ??= { category: r.category, cfg: {} }).cfg[r.config] ??= []).push(r);
  const out = ['task | config | n | pass | median tokens (weighted) | tool calls | files read | vs baseline | verdict'];
  const gains = []; let accepted = 0; let judged = 0;
  for (const [task, { cfg }] of Object.entries(by)) {
    const base = cfg.baseline ?? [];
    const bTok = med(base.map((r) => r.w)); const bPass = base.length && base.every((r) => r.passed !== null) ? base.filter((r) => r.passed).length / base.length : null;
    for (const [c, list] of Object.entries(cfg)) {
      const tokens = med(list.map((r) => r.w)); const pass = list.every((r) => r.passed !== null) ? list.filter((r) => r.passed).length / list.length : null;
      let delta = '-'; let verdict = '-';
      if (c !== 'baseline') {
        judged++;
        if (!bTok) verdict = 'INCONCLUSIVE (no baseline)';
        else {
          const red = 1 - tokens / bTok; delta = `${(red * 100).toFixed(0)}%`;
          if (base.length < minRuns || list.length < minRuns) verdict = `INCONCLUSIVE (n<${minRuns})`;
          else if (pass === null || bPass === null) verdict = 'INCONCLUSIVE (no oracle)';
          else if (pass < bPass) verdict = 'REJECTED (quality dropped)';
          else if (red <= 0) verdict = 'NO GAIN';
          else { verdict = 'ACCEPTED'; accepted++; gains.push(red); }
        }
      }
      out.push(`${task} | ${c} | ${list.length} | ${pass === null ? '?' : (pass * 100).toFixed(0) + '%'} | ${Math.round(tokens)} | ${med(list.map((r) => r.tool_calls))} | ${med(list.map((r) => r.files_read))} | ${delta} | ${verdict}`);
    }
  }
  out.push('', `accepted ${accepted}/${judged} comparisons; median token reduction over accepted: ${gains.length ? (med(gains) * 100).toFixed(0) + '%' : 'n/a'}`,
    'Reduction is end-to-end (hook injections and crazy CLI output are inside the measured session), so it is already net of Crazy Dev overhead.',
    'Target, not guarantee.');
  return out.join('\n');
}
