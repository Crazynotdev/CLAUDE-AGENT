import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.mjs';
import { install, uninstall } from '../src/install.mjs';
import { doctor } from '../src/doctor.mjs';
import { analyzeTranscript, formatCost } from '../src/cost.mjs';
import { report, benchInit, loadTasks } from '../src/bench.mjs';
import { open } from '../src/db.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'crazy.mjs');
const hook = (root, name, payload) => spawnSync('node', ['--disable-warning=ExperimentalWarning', join(root, '.crazy/runtime/hooks', name)],
  { input: JSON.stringify({ cwd: root, session_id: 's1', ...payload }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });

test('install is idempotent, preserves user hooks and files, uninstall cleans up', () => {
  const { root } = fixture();
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude/settings.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] }, permissions: { allow: ['Bash(ls)'] } }));
  install(root); install(root);
  const s = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8'));
  assert.equal(s.hooks.PostToolUse.length, 2);
  assert.ok(s.hooks.PostToolUse.some((g) => g.hooks[0].command === 'echo mine'));
  assert.deepEqual(s.permissions.allow, ['Bash(ls)']);
  assert.ok(existsSync(join(root, '.claude/agents/scout.md')) && existsSync(join(root, '.claude/skills/crazy-ctx/SKILL.md')) && existsSync(join(root, '.crazy/crazy')));
  writeFileSync(join(root, '.claude/agents/scout.md'), 'my own scout');
  const log = install(root);
  assert.ok(log.some((l) => l.includes('kept (modified by you)')));
  assert.equal(readFileSync(join(root, '.claude/agents/scout.md'), 'utf8'), 'my own scout');
  uninstall(root);
  const after = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8'));
  assert.equal(after.hooks.PostToolUse.length, 1);
  assert.ok(!existsSync(join(root, '.claude/agents/builder.md')) && existsSync(join(root, '.claude/agents/scout.md')));
});

test('installed runtime works standalone and doctor passes', () => {
  const { root } = fixture(); install(root);
  const r = spawnSync(join(root, '.crazy/crazy'), ['ctx', 'login'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0); assert.match(r.stdout, /AuthService/);
  const d = doctor(open(root)); assert.equal(d.bad, 0, d.text);
});

test('hooks: session start injects, anti-repeat blocks only unchanged repeats, failures never crash', () => {
  const { root } = fixture(); install(root);
  const ss = JSON.parse(hook(root, 'session-start.mjs', { hook_event_name: 'SessionStart' }).stdout);
  assert.match(ss.hookSpecificOutput.additionalContext, /symbols indexed/);
  const abs = join(root, 'src/util.py');
  for (let i = 0; i < 2; i++) hook(root, 'post-tool.mjs', { tool_name: 'Read', tool_input: { file_path: abs }, tool_response: {} });
  const blocked = JSON.parse(hook(root, 'pre-tool.mjs', { tool_name: 'Read', tool_input: { file_path: abs } }).stdout);
  assert.equal(blocked.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(hook(root, 'pre-tool.mjs', { tool_name: 'Read', tool_input: { file_path: abs, limit: 5 } }).stdout, '');
  writeFileSync(abs, '# changed\n');
  assert.equal(hook(root, 'pre-tool.mjs', { tool_name: 'Read', tool_input: { file_path: abs } }).stdout, '');
  const bad = spawnSync('node', ['--disable-warning=ExperimentalWarning', join(root, '.crazy/runtime/hooks/post-tool.mjs')], { input: 'not json', encoding: 'utf8' });
  assert.equal(bad.status, 0);
});

test('cost parses a Claude Code style transcript', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crazy-tr-')); const p = join(dir, 's.jsonl');
  const A = (id, content, usage) => JSON.stringify({ type: 'assistant', message: { id, model: 'claude-sonnet-x', content, usage } });
  const U = (content) => JSON.stringify({ type: 'user', message: { content } });
  const big = 'x'.repeat(8000);
  writeFileSync(p, [
    A('m1', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.js' } }], { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 500, cache_read_input_tokens: 0 }),
    U([{ type: 'tool_result', tool_use_id: 't1', content: big }]),
    A('m2', [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/a.js' } }], { input_tokens: 10, output_tokens: 15, cache_creation_input_tokens: 0, cache_read_input_tokens: 2600 }),
    U([{ type: 'tool_result', tool_use_id: 't2', content: big }]),
    A('m2', [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/a.js' } }], { input_tokens: 10, output_tokens: 15, cache_creation_input_tokens: 0, cache_read_input_tokens: 2600 }),
    A('m3', [{ type: 'text', text: 'done' }], { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 2700 }),
  ].join('\n'));
  const a = analyzeTranscript(p);
  assert.equal(a.turns, 3); assert.equal(a.usage.output, 38); assert.equal(a.waste.repeatedReading, 2000);
  assert.match(formatCost(a), /WHY TOKENS WERE SPENT/);
});

test('bench: end-to-end with a stub claude, verdict logic needs n and quality', () => {
  const { root, ctx } = fixture({ 'package.json': '{"scripts":{"test":"true"}}' });
  const stub = join(root, 'fake-claude.sh');
  writeFileSync(stub, '#!/bin/sh\necho \'{"is_error":false,"session_id":"zz","usage":{"input_tokens":100,"output_tokens":50},"total_cost_usd":0.01,"duration_ms":10,"num_turns":2}\'\n'); chmodSync(stub, 0o755);
  process.env.CRAZY_CLAUDE_BIN = stub;
  benchInit(ctx.dir);
  writeFileSync(join(ctx.dir, 'bench/tasks.json'), JSON.stringify({ tasks: [{ id: 't1', category: 'bugfix', repo: '.', commit: 'HEAD', prompt: 'p', oracle: 'true' }] }));
  const r = spawnSync('node', ['--disable-warning=ExperimentalWarning', BIN, 'bench', 'run', '--task', 't1', '--config', 'all', '--n', '1'], { cwd: root, encoding: 'utf8', env: process.env });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const rows = open(root).db.prepare('SELECT config,passed FROM runs ORDER BY id').all();
  assert.deepEqual(rows.map((x) => x.config), ['baseline', 'economy', 'balanced', 'quality']);
  assert.match(report(open(root)), /INCONCLUSIVE \(n<3\)/);
  const db = open(root).db;
  for (let i = 0; i < 3; i++) { db.prepare("INSERT INTO runs(task,category,config,rep,usage,passed) VALUES('t2','x','baseline',?,?,1)").run(i, '{"input":1000,"output":100,"cacheWrite":0,"cacheRead":0}'); db.prepare("INSERT INTO runs(task,category,config,rep,usage,passed) VALUES('t2','x','economy',?,?,1)").run(i, '{"input":300,"output":100,"cacheWrite":0,"cacheRead":0}'); db.prepare("INSERT INTO runs(task,category,config,rep,usage,passed) VALUES('t2','x','quality',?,?,0)").run(i, '{"input":100,"output":10,"cacheWrite":0,"cacheRead":0}'); }
  const rep = report(open(root));
  assert.match(rep, /t2 \| economy .*\| ACCEPTED/); assert.match(rep, /t2 \| quality .*REJECTED \(quality dropped\)/);
  delete process.env.CRAZY_CLAUDE_BIN;
});
