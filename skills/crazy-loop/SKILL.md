---
name: crazy-loop
description: Use for an autonomous multi-step run (fix until tests pass, iterate on a goal) that must stop on its own when it stalls, repeats errors or gets risky.
---
# Autonomous loop with stop conditions

```
.crazy/crazy task start "<goal>"
.crazy/crazy loop start --max 8
repeat:
  inspect (ctx) -> plan -> act -> verify (run) 
  .crazy/crazy loop step --progress <1 if tests/state improved, 0 if not, -1 if worse> --note "<what changed>" --risk LOW|MEDIUM|HIGH
  .crazy/crazy loop check        # CONTINUE or STOP: <reason>
```

On STOP: do not try again. Summarize state for the user: what was tried, what failed and why (`crazy fail add` each dead end), what you recommend next. On goal reached: `crazy loop done`, `crazy task done`.

Stop rules enforced by `loop check`: iteration cap, three iterations without progress, repeated identical failing command or error, a file edited four times, failing tests not decreasing, risk reaching HIGH. Never use the loop for production changes, migrations or security-critical code without the user's approval at each risky step.
