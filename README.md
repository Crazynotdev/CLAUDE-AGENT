# Crazy Dev

A harness for Claude Code that reduces wasted context: reading files twice, re-deriving what is already known, dumping long tool output into the conversation, retrying approaches that already failed. Written in Node.js, no runtime dependencies.

Status: **experimental (0.1.0)**. The token reduction is a **target, not a guarantee**. Nothing here has been benchmarked against real Claude Code sessions yet; `crazy bench` exists so you can measure it on your own repositories.

## Requirements

- Node.js 22.5 or later (uses the built-in `node:sqlite`, which prints an experimental warning that the provided entry points silence)
- git (recommended: used for file listing, blast comparison, benchmarks)
- Claude Code (hooks, agents, skills, commands)

## Install

From a clone or the unpacked archive:

```sh
node bin/crazy.mjs install --target /path/to/your/project
cd /path/to/your/project
.crazy/crazy doctor
```

This copies a small runtime to `.crazy/runtime/`, writes `.crazy/crazy` (a wrapper) and `.crazy/config.json`, and adds to `.claude/`: 4 agents, 5 skills, 6 commands, one short rule, and 4 hooks merged into `.claude/settings.json` without touching your own entries. Files you have edited are never overwritten (use `--force`). `crazy uninstall` removes only unmodified managed files; `--purge` also deletes `.crazy/`.

Optional global command: `npm link` in this directory gives you `crazy`.

## What it does

| Command | Purpose |
|---|---|
| `ctx "<topic>"` | Ranked symbols and line ranges for a topic, with risk, tests, known facts and past failures, within a budget (`trivial` 300, `small` 800, `medium` 1800, `large` 4000, `critical` 8000 tokens by default) |
| `run -- <cmd>` | Run a command; show errors, summary lines and head/tail; keep the raw output (`raw <id>`) |
| `fact add/list/verify` | Store findings with their source files. Status is derived: `verified`, `likely-valid`, `stale` (a source changed), `invalidated` (a source was deleted), `unknown` |
| `fail add/find`, `err add` | Record dead ends (with the condition under which to retry) and resolved errors |
| `task`, `cp`, `resume` | Task state machine, compact checkpoints, state reconstruction after `/compact` or a new session |
| `route "<task>"` | Suggest model, thinking budget, context budget, agents and gates from task text and project signals |
| `blast <file or symbol>` | Files, tests and routes that depend on it; `--predict` then `blast compare` checks the prediction against `git diff` |
| `loop`, `stagnation` | Stop conditions for autonomous work |
| `scan` | Pattern scan of the repo for prompt injection, hostile hooks, MCP and install scripts |
| `dna scan/show` | Preferences derived from the repository, confirmed only at 3+ files and 70%+ share |
| `cost` | Token dashboard for the latest session |
| `bench` | Baseline versus configurations on pinned commits, gated by an oracle command |
| `doctor` | Checks the install, runs every hook with a sample payload, reports self-cost |

Hooks (all fail silent, exit 0, and log to `.crazy/hook-errors.log`):

- `SessionStart`: injects a short resume (index size, current task, last checkpoint, fact freshness; capped at `sessionStartMaxChars`).
- `PreToolUse` (Read, Bash): denies only an unchanged full-file re-read after 2 reads, and an identical test/lint/build command when no file was edited in between. Ranged reads are never blocked. Set `antiRepeat.mode` to `off` in `.crazy/config.json` to disable. `CRAZY_FORCE=1` prefix bypasses the Bash check.
- `PostToolUse`: records reads, edits and command outcomes; adds a note only for a known error or for stagnation.
- `PreCompact`: saves a mechanical checkpoint and resets the read log.

Slash commands: `/crazy-cost`, `/crazy-doctor`, `/crazy-resume`, `/crazy-checkpoint`, `/crazy-optimize <task>`, `/crazy-loop <goal>`. Known limitation: names are flat (`/crazy-loop`, not `/crazy:loop`) until it is packaged as a plugin.

## Measuring

```sh
.crazy/crazy bench init            # edit .crazy/bench/tasks.json
.crazy/crazy bench run --config all --n 3
.crazy/crazy bench report
```

See [docs/BENCHMARK.md](docs/BENCHMARK.md). A configuration is only reported `ACCEPTED` when the oracle pass rate is not lower than baseline, there are at least 3 runs of each, and the median weighted token cost is lower.

## Known limitations

- Symbol extraction is regex-based: approximate line ranges, no resolution of dynamic imports, re-exports or metaprogramming. Cross-file references are by identifier name, so common names are skipped.
- The index is rebuilt for references whenever any file changes; on very large repositories (tens of thousands of files) this is slow.
- Hook payload fields and the transcript layout follow Claude Code's documented formats as understood at writing time and were tested here only against synthetic payloads. `crazy doctor` checks that hooks run and that transcripts are recognised; if Claude Code changes, expect to adjust `hooks/` and `src/cost.mjs`.
- The thinking budget from `route` is advice (an environment variable or keyword to apply); Claude Code does not let a hook set it per task.
- `cost` category shares and waste figures are estimates (characters / 4). Provider-reported usage totals are exact.
- Languages other than JS/TS, Python and GDScript are not indexed.
- No benchmark results are included.

## Layout

```
bin/ src/ hooks/        runtime (copied into .crazy/runtime/ on install)
agents/ skills/ commands/ rules/ profiles/   Claude Code assets
bench/                  example task file
tests/                  node --test
docs/                   architecture and benchmark method
```

Run the tests with `npm test`.

## License

MIT. Crazy Dev by Crazynotdev.
