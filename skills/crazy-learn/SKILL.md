---
name: crazy-learn
description: Use after resolving an error, abandoning an approach, or noticing a repeated preference, to record it so it is not paid for twice.
---
# Record what was learned

- Dead end: `.crazy/crazy fail add --tried "<approach>" --reason "<why it failed>" --retry-if "<what would change the answer>"`
- Resolved error: `.crazy/crazy err add --error "<message>" --cause "<root cause>" --fix "<what worked>" --failed "<a;b>" --files a.js --verified "<how>"`
- Before debugging an unfamiliar error: `.crazy/crazy fail find "<error text>"`.
- Style: `.crazy/crazy dna scan` derives preferences from the repo itself. Only patterns seen in at least 3 files with at least 70% share are confirmed; a single observation never becomes a rule. `crazy dna show` prints the confirmed ones.

Record facts, not narratives: one line each.
