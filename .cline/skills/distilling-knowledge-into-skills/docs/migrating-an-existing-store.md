# Migrating an existing store

**PDF is no longer an input.** A store built from PDFs keeps every claim it
has, and the whole refinement half is untouched — but the book behind it can no
longer be re-ingested, and any segment it needs to re-read must come from an
EPUB. The regression suite proves the refinement half still behaves exactly as
it did, so nothing already extracted is invalidated.


This methodology is a continuation, not a replacement. A store built under the
previous Python pipeline adopts it without touching its data.

## Nothing changes in the data

Claim, rule, framework and disposition shapes are unchanged. Artifact paths are
unchanged: `corpus.jsonl`, `claims/<source>/<unit>.jsonl`, `probes.jsonl`,
`rules.jsonl`, `dispositions.jsonl`, `frameworks.jsonl`, `anti-patterns.jsonl`,
`resolutions.jsonl`, `concepts.jsonl`, `gaps.jsonl`, `reports/certificate.md`.

New fields are additive and optional, so existing rows stay valid.

## Verified, not asserted

The ported Node scripts reproduce the Python originals' output on a real store
of 184 claims and 99 rules:

| Artifact | Result |
|---|---|
| `concepts.jsonl` | 153 rows, identical |
| `gaps.jsonl` | 175 rows, identical |
| `merge-candidates.jsonl` | 179 pairs, identical |
| `reports/certificate.md` | identical, line for line |

Two divergences were found and fixed during the port, both in number
formatting: Python rounds half-to-even where JavaScript rounds half-up, and
Python distinguishes `1.0` from `1` where JavaScript does not. Neither changes
a decision, and both would have read as real disagreement in a diff.

## Steps

```bash
# 1. Nothing to the data. Check it under the old rules first.
node scripts/check-store.mjs --root <store> --profile compat

# 2. Then under the new ones. The delta is a finding, not a failure.
node scripts/check-store.mjs --root <store> --profile strict

# 3. Backfill the graph — derived, so this is free and reversible.
node scripts/graph.mjs --root <store>

# 4. Install enforcement.
node scripts/install-hooks.mjs --apply
node scripts/install-ci.mjs --apply

# 5. Re-certify.
node scripts/certify.mjs --root <store>
```

## The two profiles

`compat` is exactly what the Python pipeline enforced. `strict` adds the
no-guessing gates. Running an existing store under `strict` is a measurement:
the delta is a list of fields that were filled when they should have been gap
records.

On the reference store the delta was **45 rules whose `name` was mechanically
truncated at exactly 110 characters, several mid-word** — a defect the previous
certificate never reported, because nothing was looking for it.

That is what the strict profile is for. Fix them at R3, do not relax the check.

## The ingestion tier is opt-in

A store with no `sources/converted/` tree certifies exactly as before: the
conversion and tiling gates find nothing to check. They engage when a document
is ingested through `ingest.mjs`, which is how a store built from
already-textual exports migrates without being told its history is invalid.

## Carrying an unfinished pipeline

The reference store stopped mid-flight: R4 filled 29 of 99 rules, R5 filled 22,
R8 never ran, 41 of 115 units probed, saturation zero. None of that is
discarded. The certificate reports each shortfall in capitals, the gap records
are the artifact, and `checkpoint.mjs --pending` says what to run next.

A store mid-pipeline is a normal state. The methodology's job is to make that
state visible, not to pretend it is finished.
