import { writeFileSync } from 'node:fs';
import { open, currentTask } from './db.mjs';
import { parseFlags, csv, tok } from './util.mjs';
import { ensureIndex, stats } from './indexer.mjs';
import { buildContext } from './ctx.mjs';
import * as mem from './memory.mjs';
import { runCommand, readRaw } from './exec.mjs';
import * as st from './state.mjs';
import { route, formatRoute } from './router.mjs';
import { blast, formatBlast, predictBlast, compareBlast } from './blast.mjs';
import { scan, formatScan } from './security.mjs';
import { analyzeTranscript, latestTranscript, formatCost } from './cost.mjs';
import * as bench from './bench.mjs';
import { install, uninstall, VERSION } from './install.mjs';
import { doctor } from './doctor.mjs';

const HELP = `crazy ${VERSION}: context and token efficiency harness for Claude Code
  index [--force]                     update the symbol/dependency index
  ctx <topic> [--budget small|N] [--json]   ranked symbol capsule for a topic
  fact add "<claim>" --src a.js,b.js [--kind test|compile|runtime|source|doc|inferred] [--conf 0.9]
  fact list | fact verify <id>        verified knowledge (status derived from file hashes)
  fail add --tried ".." --reason ".." [--retry-if ".."] | fail find "<text>"
  err add --error ".." --cause ".." --fix ".." [--failed "a;b"] [--files a,b] [--verified ".."]
  run -- <command>                    run with compressed output (raw kept: crazy raw <id>)
  raw <id> [--grep re] [--lines a-b]
  task start "<goal>" | task state <STATE> | task done
  cp save --goal .. --files .. --decisions .. --changes .. --tests .. --open .. --next .. | cp show
  resume [--brief]                    rebuild working state after /compact or a new session
  route "<task>" [--profile economy|balanced|quality|critical] [--json]
  blast <file|symbol>... [--predict] | blast compare
  stagnation | loop start [--max N] | loop step --progress N --note ".." [--risk LOW|MEDIUM|HIGH] | loop check | loop done
  scan [--quick]                      scan the repo for prompt injection and hostile config
  dna scan | dna show | dna pending   confirmed developer preferences
  cost [--file path] [--json]         token spend dashboard for the latest session
  bench init | bench run --task id --config baseline|economy|balanced|quality|all [--n 3] | bench report
  install [--target dir] [--profile p] [--force] | uninstall [--target dir] [--purge]
  doctor`;

export async function main(argv) {
  const [cmd, sub, ...rest] = argv;
  const out = (s) => process.stdout.write(s + '\n');
  if (!cmd || cmd === 'help' || cmd === '--help') return out(HELP);
  if (cmd === 'version' || cmd === '--version') return out(VERSION);
  if (cmd === 'install' || cmd === 'uninstall') {
    const { flags } = parseFlags([sub, ...rest].filter(Boolean), { force: 'boolean', purge: 'boolean' });
    const target = flags.target ?? process.cwd();
    const log = cmd === 'install' ? install(target, { profile: flags.profile, force: !!flags.force }) : uninstall(target, { purge: !!flags.purge });
    out(`${cmd}ed in ${target}`); log.forEach((l) => out('  ' + l));
    if (cmd === 'install') out('next: .crazy/crazy doctor');
    return;
  }
  const ctx = open();
  const a = [sub, ...rest].filter((x) => x !== undefined);
  const session = process.env.CRAZY_SESSION ?? 'cli';
  switch (cmd) {
    case 'index': { const r = ensureIndex(ctx.db, ctx.root, { force: parseFlags(a, { force: 'boolean' }).flags.force }); out(`indexed: ${r.files} files, ${r.changed} updated, ${r.removed} removed; ${JSON.stringify(stats(ctx.db))}`); break; }
    case 'ctx': { const { flags, pos } = parseFlags(a, { json: 'boolean' }); const r = buildContext(ctx, pos.join(' '), { budget: flags.budget, json: !!flags.json }); out(flags.json ? JSON.stringify(r, null, 1) : r); break; }
    case 'fact': {
      const { flags, pos } = parseFlags(rest, {});
      if (sub === 'add') { const id = mem.addFact(ctx, pos.join(' '), { src: csv(flags.src), kind: flags.kind ?? 'source', conf: Number(flags.conf ?? 1) }); out(`fact #${id} stored`); }
      else if (sub === 'verify') { mem.verifyFact(ctx, Number(pos[0])); out(`fact #${pos[0]} re-verified against current files`); }
      else out(mem.formatFacts(mem.listFacts(ctx)));
      break;
    }
    case 'fail': {
      const { flags, pos } = parseFlags(rest, {});
      if (sub === 'add') { const id = mem.addFailure(ctx, { kind: 'failed', tried: flags.tried, result: flags.result, reason: flags.reason, retry_if: flags['retry-if'], files: csv(flags.files), error: flags.error }); out(`failure #${id} stored`); }
      else { const r = mem.findFailures(ctx, pos.join(' '), 0.2); out(r.length ? r.map((x) => mem.formatFailure(x.f)).join('\n') : 'no similar failure on record'); }
      break;
    }
    case 'err': {
      const { flags } = parseFlags(rest, {});
      const id = mem.addFailure(ctx, { kind: 'resolved', error: flags.error, signature: mem.errorSignature(flags.error ?? ''), reason: flags.cause, solution: flags.fix, tried: flags.failed, files: csv(flags.files), result: flags.verified });
      out(`error #${id} stored`); break;
    }
    case 'run': { const args = [sub, ...rest].filter(Boolean); if (args[0] === '--') args.shift(); const r = runCommand(ctx, args); out(r.text); process.exitCode = r.exit; break; }
    case 'raw': { const { flags } = parseFlags(rest, {}); out(readRaw(ctx, Number(sub), { grep: flags.grep, lines: flags.lines })); break; }
    case 'task': {
      const { flags, pos } = parseFlags(rest, {});
      if (sub === 'start') out(`task #${st.startTask(ctx, pos.join(' '), { risk: flags.risk, profile: flags.profile })} DISCOVERING`);
      else if (sub === 'state') out(`task #${st.setState(ctx, pos[0])} -> ${pos[0].toUpperCase()}`);
      else if (sub === 'done') out(`task #${st.setState(ctx, 'DONE')} DONE`);
      else { const id = currentTask(ctx.dir); out(id ? JSON.stringify(ctx.db.prepare('SELECT * FROM tasks WHERE id=?').get(id)) : 'no current task'); }
      break;
    }
    case 'cp': {
      const { flags } = parseFlags(rest, {});
      if (sub === 'save') { st.saveCheckpoint(ctx, flags); out('checkpoint saved'); }
      else { const cp = st.lastCheckpoint(ctx); out(cp ? st.formatCheckpoint(cp) : 'no checkpoint'); }
      break;
    }
    case 'resume': out(st.resume(ctx, { brief: parseFlags(a, { brief: 'boolean' }).flags.brief })); break;
    case 'route': { const { flags, pos } = parseFlags(a, { json: 'boolean' }); const r = route(ctx, pos.join(' '), { profile: flags.profile }); out(flags.json ? JSON.stringify(r, null, 1) : formatRoute(r)); break; }
    case 'blast': {
      if (sub === 'compare') { out(compareBlast(ctx)); break; }
      const { flags, pos } = parseFlags(a, { predict: 'boolean' });
      out(formatBlast(flags.predict ? predictBlast(ctx, pos) : blast(ctx, pos))); break;
    }
    case 'stagnation': { const r = st.checkStagnation(ctx, flagsSession(a, session)); out(r.stagnant ? `STAGNANT: ${r.reasons.join('; ')}\n${r.advice}` : 'no stagnation signals'); break; }
    case 'loop': {
      const { flags } = parseFlags(rest, {});
      if (sub === 'start') { st.loopStart(ctx, flags.max); out(`loop started (max ${flags.max ?? ctx.cfg.loopMaxIterations})`); }
      else if (sub === 'step') out(`step ${st.loopStep(ctx, { progress: flags.progress, note: flags.note, risk: (flags.risk ?? 'LOW').toUpperCase() })} recorded`);
      else if (sub === 'done') { st.loopDone(ctx); out('loop done'); }
      else { const r = st.loopCheck(ctx, session); out(`${r.verdict}: ${r.reason}`); }
      break;
    }
    case 'scan': { const f = scan(ctx.root, { quick: parseFlags(a, { quick: 'boolean' }).flags.quick }); out(formatScan(f)); if (f.some((x) => x.sev === 'high')) process.exitCode = 1; break; }
    case 'dna': out(sub === 'scan' ? mem.scanDna(ctx) : mem.showDna(ctx, { pending: sub === 'pending' })); break;
    case 'cost': {
      const { flags } = parseFlags(a, { json: 'boolean' });
      const f = flags.file ?? latestTranscript(ctx.root);
      if (!f) { out('no transcript found for this project (looked in ~/.claude/projects). Pass --file <path.jsonl>.'); process.exitCode = 1; break; }
      const an = analyzeTranscript(f);
      const inj = ctx.db.prepare("SELECT COALESCE(SUM(n),0) n FROM events WHERE kind='inject'").get().n;
      out(flags.json ? JSON.stringify(an, null, 1) : formatCost(an, Math.round(inj / 4))); break;
    }
    case 'bench': {
      if (sub === 'init') { out(`tasks file: ${bench.benchInit(ctx.dir)}`); break; }
      if (sub === 'report') { out(bench.report(ctx)); break; }
      if (sub === 'run') {
        const { flags } = parseFlags(rest, {});
        const tasks = bench.loadTasks(ctx.dir).filter((t) => !flags.task || t.id === flags.task);
        const configs = !flags.config || flags.config === 'all' ? bench.CONFIGS : [flags.config];
        const n = Number(flags.n ?? 3);
        for (const t of tasks) for (const c of configs) for (let i = 1; i <= n; i++) { const r = bench.runOnce(ctx, t, c, i); out(`${r.task} ${r.config} #${i}: ${r.tokens} weighted tokens, oracle ${r.passed === null ? '?' : r.passed ? 'pass' : 'fail'}`); }
        break;
      }
      out('bench init | bench run | bench report'); break;
    }
    case 'doctor': { const r = doctor(ctx); out(r.text); process.exitCode = r.bad ? 1 : 0; break; }
    default: out(`unknown command: ${cmd}\n\n${HELP}`); process.exitCode = 2;
  }
}
const flagsSession = (a, d) => parseFlags(a, {}).flags.session ?? d;
