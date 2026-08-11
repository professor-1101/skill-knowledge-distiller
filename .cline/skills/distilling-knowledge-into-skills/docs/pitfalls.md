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

## Ten more, found by reviewing this implementation against its own Skill

The first eight above came from the previous project. These came from auditing
*this* one, and four of them share a shape worth naming: **the Skill stated a
rule and no code implemented it.** Nothing could have caught that, because
nothing checked that a rule had an enforcer. `tests/rgate.test.mjs` now does.

10. **The denominator had no producer.** Seven scripts read `corpus.jsonl` and
    none wrote it, so R5's "transcribed rather than recalled" was satisfied by
    somebody typing. Fixed by `enumerate.mjs`, which for EPUB is genuine
    transcription from the book's nav.

11. **The certificate measured a hand-written field.** `certify.mjs` counted
    `status === "saturated"` and nothing derived status — pitfall #1 recurring
    inside the implementation built to prevent it. Fixed by `sync-corpus.mjs`.

12. **The saturation rule had no data.** `probes.jsonl` was read by the
    certificate and written by nothing. Fixed by `probe.mjs`, which also
    refuses the same probe type twice in a row.

13. **The confidence rubric was documented and absent.** R23 said compute it;
    nothing did. Fixed by `confidence.mjs`, and the validator now rejects a
    score that disagrees with the rubric.

14. **Chunks were never linked to units.** `chunk.mjs` wrote `unit: null`
    unconditionally, so the chain document → unit → claim had a hole exactly
    where extraction happens.

15. **Chunk ids were positional.** Inserting anything upstream renumbered every
    later chunk and silently orphaned the claims referencing them — which
    defeats resumability outright. Ids are now structural.

16. **Digests were recorded and never re-verified.** Edit a segment file and
    every chunk offset and evidence chain stops matching, with every gate still
    green. `check-store.mjs --verify` recomputes all four levels.

17. **A corrupt JSONL line was warned about and skipped**, so a damaged store
    *under-reported* and still looked healthy. Parse failures are now errors
    across every artifact.

18. **Derived artifacts embedded wall-clock time**, so "rebuild and diff" was
    never clean and determinism could not be tested at all. The clock is now an
    input.

19. **`claim.unit` was never checked against its chunk's unit.** Two places to
    write one fact is one place for them to disagree.

## What is not measured

Stated rather than left silent, because the certificate discipline applies to
our own work too.

**Trigger and behaviour evals have never been run.** `cline` is not on PATH in
the environment this was built in, and per `cline-skill-creator` trigger
measurement is the highest-value check available. The eval set ships unrun:

```bash
node <creator>/scripts/trigger-eval.mjs --skill . --set evals/trigger-set.json
node <creator>/scripts/doctor.mjs --deep
```

**The Cline hook tier is checked statically, not by running Cline.** There is
no live Cline here, so `hooks-lint.mjs` checks the generated files against the
documented contract — location, naming, executability, that each parses, that
it reads stdin and emits `cancel`, and that exit 2 appears only for
`PreToolUse`. The handlers are additionally driven with the JSON Cline
documents itself as sending. What remains unproven is that a running Cline
discovers and invokes them; the git and CI tiers are what the guarantee rests
on.

That check exists because the first attempt at the tier was wrong four ways at
once, and every one was statically visible: SDK plugin *stage* names
(`tool_call_before`) used as file names, the wrong hooks directory, no stdin
handling, and no JSON response. A fifth appeared while fixing it — a `#`
comment marker, correct in shell and a syntax error in JavaScript, which
produced hooks that were installed, executable and could not run. The lint now
catches that too.

**The directory turned out to be a documentation conflict, not a mistake with
one right answer.** `customization/hooks` documents `.clinerules/hooks/`; the
CLI reference's configuration tree lists `.cline/hooks/` under "Lifecycle
hooks" and gives `~/.cline/hooks` as the `--hooks-dir` default. Both are
official. The first fix followed one source and made the lint *error* on the
other existing — replacing a guess with a confident guess. Where references
disagree and the artifact is cheap, write every candidate and let the lint
insist on it: the installer now populates both, and covering only one is a
warning. The general lesson is the one this file keeps repeating — a rule
asserted more firmly than the evidence supports is worse than an
acknowledged ambiguity, because nothing downstream can tell the difference.

## What is verified about the checks themselves

`node tests/run-tests.mjs` — 140 tests in eleven categories: unit, negative,
edge, integrity, determinism, derivation, regression, end-to-end, resume,
R-gate coverage, and the two contract lints — hooks and the skill package
itself. Most are negative, and each is either a defect above or a constraint
the design exists to enforce.

**A stated check with no implementation is the same defect as a stated rule
with no enforcer.** `docs/validation-table.md` named a `validate-skill.mjs`
for the compile stage that existed only in `cline-skill-creator`, one
directory away from the R-gate test written to catch exactly this. The gate
scanned `SKILL.md` and never the docs. `skill-lint.mjs` is the missing
implementation; it ships here, so the check works with nothing else installed.

Writing it immediately found an installer defect nothing else could see:
`install.mjs --path` honoured whatever directory it was given, and Cline
requires `name` to match the directory exactly, so any target not named after
the skill installed something that would never load. `--path` is now read as
the skills directory.

Cases that must **pass** matter as much: an honest declared gap, an enumerating
sentence a naive word-list check would wrongly reject, and a 90-character
segment beside a 5,000-character one, since size alone is never a defect.

The regression group keeps measuring the refinement half against the original
Python pipeline's output on a real 184-claim store — 153 concepts, 175 gaps,
179 merge candidates, and the 45 truncated rule names the strict profile
exists to surface.

The git gate is verified end to end in a throwaway repository: a claim carrying
a placeholder hash refuses the commit, the same claim with a real digest is
accepted, a pre-existing `pre-commit` hook is chained rather than replaced, and
`--uninstall --apply` restores it.
