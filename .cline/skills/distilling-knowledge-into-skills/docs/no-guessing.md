# The no-guessing policy, and how it is enforced

The default on uncertainty is a declared gap, never an inference:

```
cannot prove  →  mark as gap
cannot prove  →  infer            ← prohibited
```

## Why this is the highest-priority rule

The asymmetry is not close. A missing value is visible, cheap, and shows up in
the certificate as a number somebody can act on. A guessed value is invisible,
reads convincingly, and propagates into downstream work where nobody re-checks
it — because it already looks answered.

The previous run proved this at scale. **147 rule-field combinations were left
as gap records rather than filled with something plausible**, deliberately, and
that judgement is the reason its rules can be trusted at all. But it held
because a person was watching. This is what makes it hold when nobody is.

## The declared unknown

Every field that may legitimately be unknown accepts a union: the value, or

```json
{ "status": "unknown", "gap": "the source states no price for this rule" }
```

`gap` is required and must name what would settle it. An unknown with an empty
gap is indistinguishable from an unfilled field, and the whole point of the
union is that those two are different things.

Good and bad, side by side:

```json
{ "cost": { "status": "unknown", "gap": "source evidence required" } }
{ "cost": "probably some additional maintenance overhead" }
```

The second passes a naive completeness count. That is the problem.

## The three validators

Enforced by `scripts/lib/prose.mjs`, not requested in a prompt.

**1. Hedge rejection.** Normative fields carrying *probably, presumably,
appears to, seems to, may indicate, suggests that, one could argue* are
rejected. A model that cannot commit must declare the gap instead. The marker
list is deliberately not exhaustive — a blocklist cannot catch every hedge, and
pretending otherwise would be its own false confidence. It catches the register
reliably enough to make hedging inconvenient, which is the point.

**2. Self-reference rejection.** A `cost` that restates its own `because`; an
`unless` that restates its own `when`. This is the real R5 failure: cost was
derived from the same claim `because` came from, so it could only ever restate
the mechanism. It filled the field, ranked nothing, and passed every gate that
existed.

**3. Word-list rejection.** R7's computed discriminator produced *"initially,
lengths, side, specification versus classes, defined, invalid"* — which reads
like an answer and settles nothing. A field that is mostly short comma-separated
fragments with no predicate is that failure recurring.

The third has a deliberate escape: a sentence that happens to enumerate is not a
word list. "The standard categories are input/output, logic, computation, and
data." passes, because a false positive here rejects good material, and that is
worse than letting one word list through to human review.

## The structural corollary

A graph edge exists because a script derived it from a field that already
exists. **No stage may assert a relationship.** Invented relationships are not
forbidden; they are impossible.
