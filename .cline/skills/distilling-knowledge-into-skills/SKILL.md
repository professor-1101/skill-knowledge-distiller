---
name: distilling-knowledge-into-skills
description: Extract expert knowledge from an EPUB into a validated, evidence-backed skill: ingesting and chunking the book, enumerating units from its own table of contents, extracting claims that carry their conditions, probing to saturation, formalizing rules with their exceptions and costs, then compiling a skill package. Use when work involves a claim store, a corpus or coverage ledger, extraction or probe prompts, a disposition ledger, provenance or excerpt hashes, or a completeness certificate. Use equally when someone describes the symptoms without the vocabulary: "we read the whole book and only got a summary out of it", "how do we know we didn't miss half of it", "nothing in these notes changes a decision", "this rule has no source", "can we resume this next month". EPUB is the only supported input. Load it before any extraction step, not after. Not for authoring an ordinary skill from a conversation, which is cline-skill-creator.
---

# Distilling knowledge into skills

Turn prose expertise into something an agent can act on, while keeping every
normative statement traceable to a source location and keeping the
incompleteness measured rather than hidden.

The decision this helps you make, over and over, is the same one: does this
piece of work belong to a script, to a judgement, or to a gap record.

## When this applies

- A book is about to become claims, rules or a skill, and the pipeline shape is
  not settled.
- A claim store exists and nobody can say how complete it is.
- A refinement stage is running and the question is what it may consult.
- Extraction "finished" and produced something fluent that nobody can measure.
- Work stopped days ago and has to resume without corrupting what exists.

## The pipeline

```
ingest → chunk → enumerate → R0 extract → probe×n → index
       → R1 dedupe → R2 consolidate
       → R3 formalize → R4 unless → R5 cost → R6 failure-modes
       → R7 framework → R8 compile → audit → certify
```

Contracts, performers and source-access rules per stage:
[docs/pipeline-stages.md](docs/pipeline-stages.md).

## Principles

- **Evidence or omission.** Nothing enters the store unsourced. Fabrication is
  the one failure with no acceptable rate, because a skill propagates silently
  into downstream work where nobody re-checks it.
- **Cannot prove, so record a gap — never infer.** A missing value is visible
  and cheap. A guessed value is invisible, reads convincingly, and is never
  questioned again. This outranks completeness.
- **Every producer has an adversary.** A model reviewing its own output in its
  own context confirms itself.
- **Artifacts are the memory, not the conversation.** Any stage resumes from
  its inputs alone, in a fresh session. If losing a process loses information,
  the design has a defect.
- **A rule a script can check is never left to a prompt.** Prompts request;
  gates guarantee.
- **Fail loud.** Gaps, low confidence and source conflicts appear in the output
  as labelled artifacts. A failure is never resolved by quietly downgrading the
  requirement that caught it.

## Rules

Each rule's exceptions and price are in
[docs/rule-boundaries.md](docs/rule-boundaries.md). Read it before applying a
rule near its edge, or when ranking two that both apply.

### R1 — Freeze the claim schema before extracting anything
**When** a corpus is starting and no claims exist
**Then** write the schema and its validator first, test both on one chunk, freeze the field list
**Because** everything downstream depends on it, and a field added later invalidates every claim written under the old version

### R2 — Give control flow to a script, never to the model
**When** deciding what selects the next unit, records outcomes, enforces retries
**Then** put it in a driver over a manifest
**Because** none of it needs reasoning, and a model used as a loop drifts: dispatch 400 is not performed the way dispatch 3 was

### R3 — Take EPUB and nothing else, and prefer an extractor that refuses over one that degrades
**When** a book enters the pipeline
**Then** require EPUB, record the original's digest, and refuse any segment the extractor could not read and nobody has declared
**Because** a format that states its reading order, headings and contents can be checked, while one that states none of them can only be guessed at — and a guess that reads well is the failure this pipeline exists to prevent

### R3a — Pin the extractor; its version is an input to every hash
**When** any source is converted
**Then** record name, version and flags plus a fingerprint over every page digest, and refuse a re-ingest that changes the text
**Because** a version change re-wraps a line, shifting chunk offsets and breaking every excerpt_hash built on the old text — silently, and only on someone else's machine

### R3b — Reconcile the extraction against the source markup
**When** a segment has been extracted
**Then** walk the source document and assert every prose text node reached the output, refusing the segment when one did not
**Because** this is the ingestion stage's adversary, and it is a stronger one than a second tool agreeing: it proves nothing was lost rather than that two guesses matched

### R4 — Make chunks tile the source exactly once
**When** cutting a document into extraction-sized spans
**Then** check that every character belongs to exactly one chunk, with any overlap declared
**Because** a chunk set that omits a region reports it as covered rather than missing

### R5 — Enumerate the whole corpus before extracting from any of it
**When** a source enters the pipeline
**Then** produce one manifest row per unit from the source's own contents, transcribed rather than recalled
**Because** the manifest is the denominator, and reconciliation only sees what it says exists — so a unit with no row is a gap no certificate can catch

### R6 — Size a unit so one probe round yields ten to forty claims
**When** choosing grain
**Then** split until a unit lands in that window
**Because** too coarse hides everything behind one status flag, too fine buys bookkeeping with no recall

### R7 — Require a condition and a consequence on every claim
**When** any claim is written
**Then** enforce both at write time
**Because** a summarising pass cannot populate these honestly: a summary says what the text covers, a claim says what changes under what circumstances

### R8 — Hash the exact span read, and store the hash rather than the text
**When** recording evidence
**Then** compute a real digest over the span actually consulted
**Because** it proves the span was read without reproducing it, and a placeholder that looks populated breaks traceability invisibly

### R9 — Rotate probe types and never run the same one twice in a row
**When** probing a unit after its base pass
**Then** change the question's angle each round
**Because** extraction under-catches what a source implies, and that blind spot is systematic: the same question finds the same things twice

### R10 — Stop on the saturation ratio, not on fatigue
**When** deciding whether a unit is done
**Then** stop when two consecutive probes each yield new claims below a fixed ratio
**Because** "iterate until complete" has no exit and terminates arbitrarily

### R11 — Log every probe, including the ones that find nothing
**When** a probe completes
**Then** append its type and new-claim count
**Because** a zero-yield probe is the evidence that saturation was reached: the measurement, not a wasted run

### R12 — Deny source access to every refinement stage
**When** claims are being merged, elevated, bounded, costed or compiled
**Then** work from the store alone
**Because** a stage that can reach the source fills gaps from it instead of reporting them, turning a measurable deficiency invisible

### R13 — Derive gaps from the defines-minus-mentions set difference
**When** a batch of extraction completes
**Then** compute which concepts are referenced by some claim and defined by none
**Because** it is the highest-yield completeness signal available, for one set operation, where typed edges would cost quadratic judgement for the same answer

### R14 — Merge on the condition, never on the wording
**When** two claims look like duplicates
**Then** compare conditions first, and keep both if they differ
**Because** identical advice under different conditions is two rules, and merging them destroys the distinction worth keeping

### R15 — Give every claim an explicit recorded fate
**When** refinement compresses many claims into few rules
**Then** write a disposition for each, with a required reason on the discarding ones
**Because** refinement compresses ten to one, and without a ledger that loss is an accident rather than a decision

### R16 — Elevate to the most general statement that still names a condition
**When** turning a consolidated claim into a rule
**Then** strip the source's vocabulary until it transfers, and stop the moment the condition would become unspecifiable
**Because** too little elevation needs the source's example to be usable; too much produces a platitude that passes every gate and changes no decision

### R17 — Give exceptions their own pass, over cross-unit input
**When** rules exist but their boundaries have not been sought
**Then** run a dedicated pass fed by every claim touching the rule's concepts, including claims from other units and other sources
**Because** exceptions are the most frequently lost knowledge, and a source routinely states a rule in one chapter and qualifies it in another

### R18 — Give cost its own pass, and never derive it from the rule's own claim
**When** rules have conditions and exceptions but no stated price
**Then** state what each trades away, quantified where the source quantifies
**Because** without cost, two rules that both apply cannot be ranked — cost is what turns a rule list into a decision procedure

### R19 — Read a cluster with no anti-pattern as an extraction gap
**When** failure modes are being paired and a cluster has none
**Then** issue a targeted probe at the originating units, and emit a gap record whether or not it finds anything
**Because** the source usually did state the failure and extraction missed it — this stage doubles as a gap detector

### R20 — Preserve a contested question instead of resolving it
**When** two sources disagree, or one disagrees with itself
**Then** present every position with attribution and mark the resolution unresolved
**Because** a domain's live arguments are its most valuable content, and flattening the contest destroys them

### R21 — Record an unknown, never a plausible value
**When** the evidence does not settle a field
**Then** write `{"status": "unknown", "gap": "<what would settle it>"}`
**Because** a field that looks filled is never questioned again — a mechanical one is more dangerous than an empty one

### R22 — Reject a rule whose evidence chain does not resolve
**When** compiling, and a derivation cannot be followed to claims and locators
**Then** reject the rule outright
**Because** an unresolvable chain means the rule came from outside the corpus, which is fabrication

### R23 — Compute confidence, never judge it
**When** assigning confidence
**Then** apply a written rubric mechanically, with corroboration as the primary input
**Because** hand-assigned confidence cannot be recomputed when new corroboration arrives

### R24 — Quarantine model-origin material in a separate tier
**When** content comes from the model rather than a source
**Then** tag it, cap its confidence, keep it in its own files
**Because** repeating a model inference is not corroboration, and blending the tiers makes the output unfalsifiable against the corpus

### R25 — Mark an empty source response failed, never done
**When** a source read returns nothing
**Then** mark the unit failed and surface it
**Because** a silent empty extraction looks like completion and reports as coverage

### R26 — Return work to pending when the prompt that produced it changes
**When** a stage's prompt file is edited
**Then** compare the recorded hash against the current one and re-run what no longer matches
**Because** it makes re-running safe by hash rather than by memory, so a killed run loses at most one unit

### R27 — Never let a different model invalidate existing work
**When** a session resumes days later with another model
**Then** record the model on the checkpoint and continue
**Because** evidence chains verify independently of who produced them, and treating a model change as invalidating makes the store unresumable

### R28 — Keep the graph derived, never authoritative
**When** relationships across the store are needed for retrieval
**Then** derive edges mechanically from fields that already exist, and rebuild rather than update
**Because** a second store drifts the way status once drifted from claims, and derived edges make an invented relationship impossible rather than forbidden

### R29 — Consolidate corpus-wide, never per-increment
**When** new material is added to a store that already has rules
**Then** re-run consolidation over everything
**Because** consolidating as material arrives makes the first increment's vocabulary the ontology every later one is forced into — unrecoverable once rules exist

### R30 — Withhold the certificate when the denominators do not reconcile
**When** completeness is reported
**Then** publish counts against stated denominators, print shortfalls in capitals, and refuse to issue while a hard invariant fails
**Because** a certificate reporting only successes measures nothing

### R31 — Send a defect back to the stage that caused it
**When** an audit or later stage finds a problem
**Then** fix it at its origin
**Because** patching downstream hides the defect: the rule reads correctly while its evidence points somewhere wrong

### R32 — Cluster by decision, never by document
**When** deciding what becomes one skill
**Then** group rules by the task a consumer is performing
**Because** a source's teaching order is rarely the consumer's task order, and a skill named after a chapter is the book again with extra steps

### R33 — Derive a field, never maintain it by hand
**When** a value can be computed from the artifacts — a segment's kind, a unit's status, a chunk's owner, a confidence score
**Then** compute it, and reject a stored value that disagrees with the computation
**Because** a hand-maintained field drifts from the artifact it describes, and the drift is invisible: the previous store marked chapters saturated while holding zero claims

### R34 — Give identifiers a structural derivation, never a positional one
**When** naming a unit or a chunk
**Then** derive the name from where it sits in the source, not from a running count
**Because** a positional id renumbers everything after an insertion, orphaning every claim that referenced one, and nothing downstream can tell that it happened

### R35 — Verify recorded digests, do not merely record them
**When** a store is checked in earnest
**Then** recompute every digest and length and compare against what was written
**Because** provenance that is never re-checked is recorded rather than verified — edit one segment file and every chunk offset and evidence chain silently stops matching while every other gate stays green

## Deciding between rules

Six tensions recur, and each has a discriminator that settles it. The table and
the ordering heuristics are in
[docs/rule-boundaries.md](docs/rule-boundaries.md#deciding-between-rules).

## Contested

Two questions this methodology deliberately does not settle — model-prior
knowledge, and evidence granularity in reference files. Both in
[docs/rule-boundaries.md](docs/rule-boundaries.md#contested).

## Failure modes

Pattern (rule violated) → the symptom. Full log with the evidence behind each:
[docs/pitfalls.md](docs/pitfalls.md).

- **Summarisation drift** (R7) → sentences say what a source says rather than
  what to do; they read well and decide nothing.
- **Confident incompleteness** (R5, R30) → a fluent library over a fraction of
  the source, with no signal of the remainder. Fluency is not coverage.
- **Fabrication** (R8, R22) → a rule with no chain, or one ending in a
  placeholder hash that looks populated.
- **Clean-looking wrong conversion** (R3, R3b) → the segment count reconciles
  while a third of the text was never captured.
- **Filled-but-empty fields** (R18, R21) → a cost restating the mechanism, a
  discriminator that is a word list.
- **Status outrunning artifacts** (R33) → the manifest says saturated while the
  store holds no claims for that unit.
- **Orphaned references** (R34) → an insertion renumbers chunks, and every
  claim pointing at one now names something else.
- **Unverified provenance** (R35) → digests recorded at ingest and never
  rechecked, so an edited segment passes every gate.

## Running it

```bash
node scripts/extractor-check.mjs --record                    # qualify the extractor
node scripts/ingest.mjs --source book.epub --slug my-book    # gates the conversion
node scripts/enumerate.mjs --slug my-book                    # the denominator, from the book's own contents
node scripts/chunk.mjs --slug my-book                        # tiles it, unit-linked, provably
node scripts/probe.mjs --record --unit U --type implicit --new-claims 4
node scripts/sync-corpus.mjs                                 # status and saturation, derived
node scripts/confidence.mjs                                  # scores, by rubric
node scripts/index.mjs && node scripts/dedupe.mjs            # gaps, then R1 candidates
node scripts/graph.mjs && node scripts/context.mjs --for rule/<id> --hops 2
node scripts/checkpoint.mjs --pending --stage R0             # what is left to do
node scripts/check-store.mjs --profile strict --verify       # every gate, digests included
node scripts/certify.mjs                                     # counts and shortfalls
node scripts/skill-lint.mjs --path <compiled-skill>          # will Cline load it
node scripts/install-hooks.mjs --cline --apply               # make it refuse
node scripts/hooks-lint.mjs                                  # check the hooks statically
```

`node tests/run-tests.mjs` proves the gates by what they refuse, and checks that
every rule above still has something enforcing it.

Stage prompts are in `templates/prompts/`, one per stage, and they outrank any
summary — including this one.

## Reference

- [docs/pipeline-stages.md](docs/pipeline-stages.md) — stage contracts and source-access rules
- [docs/no-guessing.md](docs/no-guessing.md) — the unknown/gap union and its three validators
- [docs/ingesting-a-book.md](docs/ingesting-a-book.md) — conversion gates, reconciliation, chunk tiling
- [docs/epub.md](docs/epub.md) — why EPUB only, and what the extractor refuses
- [docs/extractors.md](docs/extractors.md) — the adapter contract, conformance, pinning
- [docs/incremental-runs.md](docs/incremental-runs.md) — checkpoints, re-entry, adding material later
- [docs/graph-layer.md](docs/graph-layer.md) — derived edges, retrieval, why it is a projection
- [docs/validation-table.md](docs/validation-table.md) — every gate and its failure response
- [docs/data-model.md](docs/data-model.md) — claim, rule, chunk, disposition, confidence rubric
- [docs/compiling-skills.md](docs/compiling-skills.md) — R8, the body template, description and evals
- [docs/enforcement.md](docs/enforcement.md) — the three tiers, and what each surface gets
- [docs/migrating-an-existing-store.md](docs/migrating-an-existing-store.md) — adopting this on a store already in flight
- [docs/pitfalls.md](docs/pitfalls.md) — the evidenced failure log
