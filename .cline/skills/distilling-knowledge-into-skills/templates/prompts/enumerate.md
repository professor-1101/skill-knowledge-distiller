# enumerate — build the denominator

Role: enumerator. Source access: **yes**.

Produce one manifest row per unit, from the source's **own** table of contents,
transcribed rather than recalled. The manifest is the denominator every later
coverage number is measured against, so a unit with no row is a silent gap no
certificate can ever catch — reconciliation only sees what the manifest says
exists.

## Grain
Split so that one probe round over a unit yields roughly 10-40 claims. Too
coarse hides everything behind a single status flag; too fine buys bookkeeping
with no recall. Where a section is genuinely thin, merge it with its neighbour
rather than carrying a unit that can never reach the floor.

The unit identifier must be expressible in the configured shape. A manifest at
one grain and claims at another leaves claims pointing at units that do not
exist.

## If there is no obtainable table of contents
Record that as a gap and enumerate nothing. Inventing structure produces a
denominator that is confidently wrong, which is worse than no denominator.

## Output
One `corpus.jsonl` row per unit. `status: pending` for all of them — status is
derived later from the artifacts, never authored here.
