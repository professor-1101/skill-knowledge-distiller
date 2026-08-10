# Pitfalls, with the evidence

Every entry below happened. They come from one real extraction run over one
book — nine commits, a claim store that was built, discarded, and rebuilt, and
a certificate that reports its own shortfalls in capitals. The domain of that
book is irrelevant here and deliberately not discussed; what transfers is the
shape of each failure and the check that now catches it.

The reason to write these down rather than state the rules abstractly: every
one of them **looked fine at the time**. That is the property they share, and
it is why they need mechanical checks rather than better intentions.

---

## 1. Status outran the artifacts

Two units were marked `saturated` while holding **zero claims**. Status had
been authored by judgement and never reconciled against what the store actually
contained.

*Now caught by:* `index.mjs` flags any unit whose status is not pending while
its claim count is zero. Status is derived from the claims and the probe log,
never hand-written.

## 2. Placeholder evidence

Every claim in the first store carried `excerpt_hash: "md-derived-01"` instead
of a digest. The field was populated, the validator of the day accepted it, and
the entire evidence chain proved nothing.

The store was **discarded and rebuilt from zero** rather than repaired, because
a chain you cannot verify is indistinguishable from a fabricated one.

*Now caught by:* `evidence.mjs` rejects anything that is not 64 hex characters,
and names known placeholder shapes specifically — a generic "invalid hash"
sends people hunting for a typo when the real problem is that nothing was read.

## 3. Unit grain the schema could not express

The corpus held chapter-grain rows while claim identifiers were
`source/chNN/sNN/cNN`. Claims pointed at units that did not exist. Separately,
one chapter produced 110 claims in a single unit, hiding everything behind one
status flag.

*Now caught by:* `check-store.mjs` reconciles every claim's unit against the
manifest. Grain guidance is one probe round yielding 10-40 claims.

## 4. Mechanically filled fields that looked filled — three times

This is the single most instructive failure in the project, because it recurred
after being fixed once.

**R5, first attempt.** Cost was filled from the rule's own claim. It duplicated
`because` every time — inevitably, because that is where `because` came from.
The claim schema has no cost field to draw a separate answer from.

**R5, second attempt.** Widened to any sibling claim with cost-sounding
vocabulary. It returned *benefits* phrased as comparisons: "at linear rather
than combinatorial cost", "they remain usable across changes". Those fill the
field and rank nothing, which is the exact failure the stage exists to prevent.
A loose keyword list matching "scale" inside "unit scale" is how the first two
got through unnoticed.

**R7.** The discriminator between two competing rules was computed by
set-differencing their `when` clauses. It produced *"initially, lengths, side,
specification versus classes, defined, invalid"* — a word list that reads like
an answer and settles nothing.

The response, in the project's own words: a mechanically generated field that
looks filled is more dangerous than an empty one, because nothing downstream
will question it. The field was renamed `discriminator_candidate` and the real
value left null. **147 rule-field combinations were left as gap records rather
than plausible fills.**

*Now caught by:* `prose.mjs` — self-reference between paired fields, word-list
shape, and hedge markers. And the declared-unknown union, so an honest gap has
somewhere to go.

## 5. The gap engine paid for itself immediately

Not a failure — the counter-example that justifies the cheapest check in the
pipeline. After the first chapter, `defines` minus `mentions` flagged three
concepts as referenced but never defined. They were genuine extraction misses,
not forward references. The fix went back to R0 and added the missing claims.

*Kept as:* `index.mjs`. One set operation, run after every extraction batch.

## 6. Merging on wording instead of condition

R1 proposed 266 merge candidates. R2 merged exactly **two**. Everything else
that looked like a duplicate had a different applicability condition, and
merging on surface similarity would have destroyed precisely the distinction
that made the claims worth keeping.

*Now encoded as:* the R2 prompt states the condition as the discriminator, and
the dedupe stage is explicit that it nominates and never merges.

## 7. A cluster with no anti-pattern was an extraction gap

One rule cluster came out of R6 with no anti-pattern at all. The targeted probe
back at the originating units found the source **did** state three of them.
Extraction had captured the positive rule and missed the failure it guards
against.

The recovered material re-entered through R0 as claims — not written straight
into a skill — and a gap record notes that the probe ran.

*Kept as:* R6's narrow exception to the no-source-access rule, scoped to the
originating units and emitting a gap record either way.

## 8. Refinement is where quality is lost, not extraction

R0's claims are clean. R3's rules are visibly degraded: `name` truncated at
exactly 110 characters and often mid-word, `then` restating `name`, `because`
holding an action rather than a mechanism, `confidence` left at 0.0.

**45 of 99 rules carry a truncated name.** The certificate never reported it,
because nothing was looking.

*Now caught by:* `validate-rule` under the strict profile, which is how the
number above was measured in the first place.

## 9. Specifying a stage is not executing it

R8 has a complete prompt, a canonical body template, a nine-step procedure and
a definition of done. It never ran. The certificate reads `skills 0`.

*The lesson for this skill:* the compile stage is the one most likely to be
deferred indefinitely, because everything before it feels like progress. Run it
on one cluster early. A finished skill that helps nobody is discoverable in an
afternoon; discovering it after six more books is a month.

---

## What is verified about the checks themselves

`node scripts/selftest.mjs` — 25 cases, most of them negative, each one either
a defect above or a constraint the design exists to enforce. It includes the
cases that must **pass**: an honest declared gap, and an enumerating sentence
that a naive word-list check would wrongly reject.

The git gate is verified end to end in a throwaway repository: a claim carrying
a placeholder hash refuses the commit, the same claim with a real digest is
accepted, a pre-existing `pre-commit` hook is chained rather than replaced, and
`--uninstall --apply` restores it.
