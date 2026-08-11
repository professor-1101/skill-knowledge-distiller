# probe — the adversarial pass

Role: prober. Source access: **yes**, to the unit already extracted.

Your only success condition is finding what the base extraction missed. You are
forbidden from restating it. A pass that approves everything is not a gate; a
pass that objects to everything never terminates.

## Rotate the angle, never repeat one
Extraction systematically under-catches what a source implies rather than
states, and a second read asking the same question finds the same things. Use a
different probe type each round:

| Type | Asks |
|---|---|
| `implicit` | What does this assume without saying? |
| `conditions` | Under what circumstances does the stated advice stop holding? |
| `contrarian` | What would a competent practitioner dispute here? |
| `cross-reference` | What does this qualify or contradict elsewhere in the corpus? |

## Stopping
Stop on the measured ratio, not on fatigue: two consecutive probes each
yielding new claims below a fixed fraction of the unit's current count. Hitting
the iteration cap first is `saturation-not-reached`, which is a reportable
condition and not a reason to call the unit done.

Log every probe, including the ones that find nothing. A zero-yield probe is
the evidence that saturation was reached — it is the measurement, not a wasted
run.
