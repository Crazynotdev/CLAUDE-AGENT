---
name: crazy-verify
description: Use when finishing a change, choosing how much verification a task needs, or recording a finding as verified knowledge.
---
# Verification scaled to risk

Get the level from `.crazy/crazy route "<task>"` or `.crazy/crazy blast <files>`.

- SMALL: run the targeted test, read the diff once.
- MEDIUM: targeted tests of affected files, then a review of the diff.
- LARGE or critical: plan first, full affected tests, fresh-context `reviewer` agent, `security-reviewer` for auth, money, secrets or migrations. Ask the user before irreversible steps.

Run commands with `.crazy/crazy run -- <cmd>`. Report what actually ran and its result, not what should pass.

When something is established by a test, compile, runtime check or reading source, store it so it is not re-derived:
`.crazy/crazy fact add "<claim>" --src path/a.js,path/b.js --kind test`
Facts go stale automatically when a source file changes. Re-check with `crazy fact verify <id>` after confirming.
