# Pipeline stages — the stage-by-stage contract

Read this when you need to know what a stage may consult, what it consumes, and
what it must emit. `SKILL.md` says *why*; this says *what*.

## Execution order

```
ingest → chunk → enumerate → R0 extract → probe×n → index
       → R1 dedupe → R2 consolidate
       → R3 formalize → R4 unless → R5 cost → R6 failure-modes
       → R7 framework → R8 compile → audit → certify
```

The order is not negotiable in three places.

**Ingest precedes everything**, because coverage measured against a source that
was silently truncated in conversion is measuring the wrong denominator.

**Probing precedes indexing**, because the referenced-but-undefined query is
only meaningful against a store that has stopped growing.

**R4 and R5 follow R3 as separate passes** rather than folding into it. A single
pass producing statement, exception and cost together underweights whichever it
reaches last, and that is reliably the exception.

## Stage contracts

| Stage | Performer | Source access | Consumes | Emits |
|---|---|---|---|---|
| ingest | script + external extractor | the original file | a book | `sources/converted/<doc>/pages.jsonl` |
| chunk | script | converted text | pages | `chunks.jsonl`, tiling proof |
| enumerate | model | yes | the source's table of contents | `corpus.jsonl` — the denominator |
| R0 extract | model | yes, one chunk | one chunk | `claims/<source>/<unit>.jsonl` |
| probe | model | yes, one unit | one unit, one probe type | claims (grown), `probes.jsonl` |
| index | script | n/a | claim store | `concepts.jsonl`, `gaps.jsonl` |
| R1 dedupe | script | n/a | claim store | `merge-candidates.jsonl` |
| R2 consolidate | model | **no** | candidate pairs | `dispositions.jsonl`, `resolutions.jsonl` |
| R3 formalize | model | **no** | consolidated claims | `rules.jsonl` |
| R4 unless | model | **no** | rule + every claim touching its concepts | `unless` filled, or a gap row |
| R5 cost | model | **no** | rules | `cost` filled, or a gap row |
| R6 failure-modes | model | **targeted probe only** | rules | `anti-patterns.jsonl`, gap rows |
| R7 framework | model | **no** | rules, resolutions | `frameworks.jsonl` |
| R8 compile | model | **no** | rules, frameworks, anti-patterns | `skills/<name>/` |
| audit | model | yes, verification only | sampled rules | `reports/audit.md` |
| certify | script | n/a | everything | `reports/certificate.md` |

Six model roles, six deterministic components. Each model role is one versioned
prompt file, byte-stable during a run — that stability is what makes the prompt
hash a usable invalidation signal.

## Why R2 through R8 are denied the source

If a skill can only be written by returning to the book, the claim store is
incomplete. Denying the tool converts an invisible quality problem into a
visible ledger entry. A compiler that can reach the source will fill gaps from
it rather than report them, and the certificate then measures nothing.

R6 holds the single exception, narrowly: a rule cluster with no anti-pattern
usually means the source stated the failure and extraction missed it. The probe
is scoped to the originating units, its result enters through the normal
extraction path with the normal validator, and a gap record is emitted whether
or not it finds anything.

## Which component owns a step

Ask whether the step requires a judgement.

Selecting the next unit, recording an outcome, retrying, comparing a number to
a threshold — none of those need reasoning, and a model used as a loop costs
tokens per iteration and drifts. Dispatch 400 is not performed the way dispatch
3 was.

Merging, elevating, bounding, costing — anything where two competent people
could differ — is a stage, and belongs to the model.
