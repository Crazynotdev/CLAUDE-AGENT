# Architecture

## Constraint

A harness cannot edit Claude's context. It can change four things: what is loaded at start (rules, skill descriptions, SessionStart output), how large tool results are, what hooks allow or inject, and what is delegated to subagents. Every feature here acts on one of those.

## Data

One SQLite file per project, `.crazy/store.db`:

```
files, symbols, edges (imports), refs (symbol use)    the semantic map
facts + fact_sources(hash)                            verified knowledge; status is computed, never stored
failures                                              dead ends and resolved errors
tasks, checkpoints                                    state machine and compact state
events                                                reads, edits, commands, injections, loop steps
raw_outputs                                           index of kept raw tool output
dna                                                   observations behind confirmed preferences
runs                                                  benchmark results
```

Memory, cache and evidence share the `facts` tables: a cached understanding is a claim with sources and the hashes they had when it was checked. Freshness follows from file content, not elapsed time.

## Decisions against the original brief

- Memory, cache, evidence and state folders became one database. Fewer moving parts, one place to measure.
- `workflows/` was dropped: workflows are skills.
- A CLI called through Bash instead of an MCP server: MCP tool definitions cost context on every turn.
- Regex extraction instead of tree-sitter in 0.1: no native dependencies, small footprint. Revisit if benchmarks show retrieval errors.
- Benchmark comes before auto-tuning. Auto-tuning is not implemented: it needs benchmark data that does not exist yet. `bench report` provides the evidence a human uses to change profiles.
- Net savings are measured end to end. Hook injections and CLI output are part of the measured session, so baseline minus Crazy Dev is already net of overhead.

## Comparison with ECC

ECC (affaan-m/ECC) was studied through its README and Longform Guide only; its hook and script sources were not read.

| Area | ECC | Crazy Dev |
|---|---|---|
| Scale | Large catalogue of agents, skills, commands | 4 agents, 5 skills, 6 commands |
| Model choice | Static guidance table | Router with escalation after a failed attempt |
| Memory | Session summaries, instincts with confidence | Facts with source hashes; freshness derived from the code |
| Learning | Extracted at session end | Explicit dead-end records with retry conditions; preferences need 3+ observations |
| Compaction | Manual, well timed | Checkpoints plus automatic reconstruction |
| Verification | TDD and evals | Gates chosen by blast radius |
| Security | Agent configuration scanning | Scan of repo content, hooks, MCP and install scripts; repo text declared untrusted |

## Not implemented

Speculative prefetch beyond listing likely next files (`ctx` names them, loads nothing); strategy auto-tuning; learned router thresholds; cross-harness adapters (Codex, Cursor, OpenCode); parallel agent scheduling beyond the guidance in the agent and skill files.
