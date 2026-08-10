# Rule boundaries and costs

The `Unless` and `Cost` of every rule in `SKILL.md`, kept here so the body stays
inside its token budget while the boundaries stay available.

Read this when applying a rule near its edge, or when ranking two rules that
both apply. A rule without its boundary is a trap, and a rule without its cost
cannot be ranked against another — those two facts are why these fields exist
at all, and why they are one link away rather than cut.

Several entries read *(no exception)*. That is a deliberate value, not an
unfilled field: it marks a rule whose boundary was sought and found not to
exist, which is different from one whose boundary was never looked for.

### R1 — Freeze the claim schema before extracting anything
**Unless** a pilot shows the schema cannot express something the corpus contains — change it then, before volume accumulates
**Cost** a day before the first real claim

### R2 — Give control flow to a script, never to the model
**Unless** the step needs a judgement, in which case it is a stage
**Cost** a script to maintain

### R3 — Gate the conversion, do not trust it
**Unless** the source is already text, in which case the gates find nothing and cost nothing
**Cost** an external tool that must be present, and pages a human has to adjudicate

### R4 — Make chunks tile the source exactly once
**Unless** *(no exception — an untiled source has no usable denominator)*
**Cost** a boundary pass and a check per document

### R5 — Enumerate the whole corpus before extracting from any of it
**Unless** no contents listing is obtainable — record that as a gap and enumerate nothing, rather than inventing structure
**Cost** one source round-trip before extraction starts

### R6 — Size a unit so one probe round yields ten to forty claims
**Unless** a section is genuinely thin — merge it with its neighbour
**Cost** more manifest rows to reconcile

### R7 — Require a condition and a consequence on every claim
**Unless** the claim is a definition, where the condition may be minimal but must still be stated
**Cost** rejects material that reads well and decides nothing

### R8 — Hash the exact span read, and store the hash rather than the text
**Unless** *(no exception — a locator without a verifiable hash is an unverifiable chain, and those are discarded rather than kept)*
**Cost** every read goes through one adapter so digests are reproducible

### R9 — Rotate probe types and never run the same one twice in a row
**Unless** the registry is exhausted before saturation, which is itself reportable
**Cost** several passes per unit

### R10 — Stop on the saturation ratio, not on fatigue
**Unless** an iteration cap is hit first — mark saturation-not-reached and carry it into the certificate
**Cost** some units get probed past much return

### R11 — Log every probe, including the ones that find nothing
**Unless** *(no exception — an unlogged probe cannot support the stopping claim that depends on it)*
**Cost** none

### R12 — Deny source access to every refinement stage
**Unless** a rule cluster has no anti-pattern (R19), the one exception, which emits a gap record either way
**Cost** some skills cannot be finished until extraction improves — the intended signal, not an obstacle

### R13 — Derive gaps from the defines-minus-mentions set difference
**Unless** the concept belongs to a unit still pending — a forward reference, and the distinction is worth recording
**Cost** forward references need triage each run

### R14 — Merge on the condition, never on the wording
**Unless** condition and consequence both agree — merge, and let the survivor inherit all the evidence, which is where corroboration comes from
**Cost** a larger rule set than aggressive merging

### R15 — Give every claim an explicit recorded fate
**Unless** *(no exception — claims minus dispositions is empty before anything is certified)*
**Cost** bookkeeping proportional to claim count

### R16 — Elevate to the most general statement that still names a condition
**Unless** it cannot be stated this way — disposition it with a reason rather than forcing it
**Cost** a judgement per rule, with failure modes on both sides

### R17 — Give exceptions their own pass, over cross-unit input
**Unless** the search genuinely returns nothing — record a gap and flag the rule, since a rule claimed to hold universally is usually one whose boundary was not found
**Cost** an extra pass with the widest input set of any stage

### R18 — Give cost its own pass, and never derive it from the rule's own claim
**Unless** a rule is genuinely free — say so and say why, so a real zero is distinguishable from an unfilled field
**Cost** an extra pass; deriving it from the rule's own claim only ever restates the mechanism

### R19 — Read a cluster with no anti-pattern as an extraction gap
**Unless** the probe confirms the source is silent — the gap record stands as the finding
**Cost** the single exception to no-source-access, so it needs the record to stay honest

### R20 — Preserve a contested question instead of resolving it
**Unless** it is one source contradicting itself — label that an internal inconsistency and say what would settle it
**Cost** the skill answers some questions with "the field has not settled this"

### R21 — Record an unknown, never a plausible value
**Unless** *(no exception — this is enforced by the validator, not requested by the prompt)*
**Cost** the artifacts show their incompleteness plainly, which is the purpose

### R22 — Reject a rule whose evidence chain does not resolve
**Unless** *(no exception — repaired at its origin or dropped, never patched at the skill)*
**Cost** occasionally loses a rule that reads well

### R23 — Compute confidence, never judge it
**Unless** the rubric's inputs are suspect — a store uniformly tagged `direct` needs a spot audit of the tags, not a different rubric
**Cost** the rubric must exist before volume accumulates

### R24 — Quarantine model-origin material in a separate tier
**Unless** the project forbids model-origin content entirely
**Cost** a parallel tier, and skills built on it carry a caveat

### R25 — Mark an empty source response failed, never done
**Unless** *(no exception)*
**Cost** none

### R26 — Return work to pending when the prompt that produced it changes
**Unless** the edit is provably cosmetic — but the hash cannot tell, so the default is to re-run
**Cost** model tokens; the response cache keeps source reads at zero

### R27 — Never let a different model invalidate existing work
**Unless** an audit finds quality varying by model — then segment by the recorded field rather than discarding
**Cost** one more field per checkpoint

### R28 — Keep the graph derived, never authoritative
**Unless** *(no exception — deleting the graph must lose nothing)*
**Cost** a rebuild per query session

### R29 — Consolidate corpus-wide, never per-increment
**Unless** *(no exception)*
**Cost** refinement re-runs; source reads stay cached at zero

### R30 — Withhold the certificate when the denominators do not reconcile
**Unless** *(no exception — a withheld certificate is a result, not an error)*
**Cost** the report is often unflattering, which is its purpose

### R31 — Send a defect back to the stage that caused it
**Unless** the defect is purely presentational and touches no claim
**Cost** rework propagates forward

### R32 — Cluster by decision, never by document
**Unless** the source's structure genuinely coincides with a task boundary
**Cost** evidence mapping must be maintained rather than inferred from structure
