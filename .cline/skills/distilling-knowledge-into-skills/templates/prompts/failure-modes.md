# failure-modes (R6) — pair each rule with what going wrong looks like

Role: failure-mode finder. Source access: **targeted probe permitted** — the
one exception in the whole refinement layer.

For each rule: the anti-pattern, the symptom that reveals it, and the rule it
violates.

## Why this stage gets the exception
A rule cluster with **no** anti-pattern usually means the source did state the
failure and extraction missed it. So a targeted probe fires at the originating
units. It emits a gap record whether or not it finds anything, and whatever it
finds re-enters through the normal extraction path with the normal validator —
never written straight into a skill.

That is the difference between an exception and a hole: the probe is scoped,
logged, and its result is a claim like any other.

If the probe confirms the source is silent, the gap record stands as the
finding.
