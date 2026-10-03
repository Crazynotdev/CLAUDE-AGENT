---
name: crazy-checkpoint
description: Use at natural pauses in long tasks, before /compact or /clear, and when resuming work, to save or rebuild the compact task state.
---
# Checkpoints instead of long transcripts

Save (compact, one line per field):
`.crazy/crazy cp save --goal "..." --state IMPLEMENTING --files a.js,b.js --decisions "..." --changes "..." --tests "..." --open "..." --next "..."`

States: DISCOVERING, UNDERSTANDING, PLANNING, IMPLEMENTING, TESTING, REVIEWING, VERIFYING, DONE, BLOCKED. Set with `crazy task state <STATE>`.

Resume after /compact, /clear or a new session: the SessionStart hook already injects `crazy resume`. Run `.crazy/crazy resume` yourself if you need it again. It lists the task, last checkpoint, relevant facts with their freshness, and approaches not to repeat.

Compact manually at logical boundaries (after a plan is agreed, after a feature passes tests), not when the window is full.
