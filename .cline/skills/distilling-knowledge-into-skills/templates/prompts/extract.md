# extract (R0) — evidenced claims from one chunk

Role: extractor. Source access: **yes**, to this chunk only.

Produce claims. Not a summary: the schema requires `condition` and
`consequence`, and those are exactly what a summarising pass cannot populate
honestly. A summary describes what the text covers; a claim states what changes
under what circumstances.

## Every claim carries
- `statement` — decision-bearing, past the specificity floor
- `condition` — when it holds. Never "always" on a `rule`
- `consequence` — what changes
- `defines` / `mentions` — concept slugs, which is what makes gap detection a
  set operation rather than a judgement
- `evidence.locator` and a **real digest** over the exact span read
- `origin` — `source`, or `model` in its own capped tier

## What not to extract
Anything a competent reader already knows. A true, sourced, useless statement
passes every gate and changes no decision, and a store full of them looks
thorough while carrying nothing.

## When the chunk does not settle something
Record a gap. Never infer to fill a field: a missing value is visible and
cheap, a guessed one is invisible and propagates into work nobody re-checks.
