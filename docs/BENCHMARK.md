# Benchmark method

Goal: find out whether Crazy Dev reduces cost without reducing quality, on your repositories. Target, not guarantee.

## Tasks

`.crazy/bench/tasks.json`:

```json
{ "tasks": [ { "id": "auth-bug", "category": "bugfix", "repo": ".", "commit": "<sha>",
  "prompt": "...", "oracle": "npm test --silent", "timeoutSec": 900 } ] }
```

- Pin `commit`. Each run uses a fresh `git worktree` of that commit.
- The `oracle` is a command whose exit code decides quality (hidden or existing tests). A task without an oracle can never be `ACCEPTED`.
- Use 20 to 30 tasks across bugfix, small feature, refactor and codebase questions. Include at least one repository that is not yours to avoid tuning to your own habits. Repositories under a few hundred files will show little effect.

## Running

`crazy bench run --task <id> --config baseline|economy|balanced|quality|all --n 3`

`baseline` is a clean worktree with nothing installed. Other configs install Crazy Dev with that profile into the worktree. Claude runs headless via `claude -p ... --output-format json` with the arguments in `config.json` (`claudeArgs`; default allows Bash, Edit, Write, Read, Grep, Glob and accepts edits inside the temporary worktree: review that before running on code you do not trust). Set `CRAZY_CLAUDE_BIN` to use another binary or a stub.

## Metrics

Recorded per run: provider-reported input, output, cache write, cache read tokens; cost; duration; turns; tool calls and files read (from the transcript); files changed; oracle result.

Weighted tokens = input + 5 x output + 1.25 x cache write + 0.1 x cache read. These ratios are an assumption about relative pricing; adjust `weighted` in `src/cost.mjs` if yours differ.

## Verdict (per task and config)

- `INCONCLUSIVE`: fewer than 3 runs of baseline or config, no baseline, or no oracle.
- `REJECTED (quality dropped)`: oracle pass rate below baseline.
- `NO GAIN`: median weighted tokens not lower.
- `ACCEPTED`: pass rate at least baseline, at least 3 runs each, median weighted tokens lower.

Report: reduction percentage per comparison and the median over accepted ones. LLM runs vary; read the spread, not one number.

## What this does not measure

Code quality beyond the oracle, maintainability, and long multi-day sessions. Review diffs by hand on a sample.
