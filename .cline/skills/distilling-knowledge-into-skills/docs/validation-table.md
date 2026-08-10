# Validation points, quality gates, and failure handling

Read this when wiring enforcement, or when deciding whether a requirement
belongs in a prompt or in a script.

The governing principle: **a rule that can be checked by a script is never left
to a prompt.** Prompts request; gates guarantee. Every mechanically checkable
requirement belongs in the table below rather than in prose asking politely.

## Validation points

| Point | Check | Mechanism | On failure |
|---|---|---|---|
| Ingest | pages converted equals pages in the original | `ingest.mjs` | blocked; count is the denominator |
| Ingest | a text page yielding far below the document median | `ingest.mjs` | `conversion-suspect`; extraction refused until declared |
| Ingest | every page carries a declared `kind` | `ingest.mjs`, `chunk.mjs` | blocked; an undeclared page bakes a possible loss into the denominator |
| Ingest | an image or mixed page has OCR **or** a gap | `ingest.mjs` | blocked; a skipped page reports as covered |
| Ingest | an OCR'd page records engine and confidence | `ingest.mjs` | blocked; OCR is a guess and its tier must be visible |
| Chunk | chunks tile the document exactly once | `chunk.mjs`, `check-store.mjs` | blocked; coverage cannot be measured against a partial denominator |
| Claim write | schema conformance, evidence present, locator non-empty, `origin` set | `check-store.mjs`, hooks | write blocked, error returned, worker retries |
| Claim write | `excerpt_hash` is a digest, not a placeholder | same | same |
| Claim write | `rule`-type claims carry a real condition, not "always" | same | same |
| Claim write | statement above the specificity floor | same | same |
| Claim write | `origin: model` never paired with `support: direct` | same | same |
| Any normative field | no hedge markers | `prose.mjs` | rejected; declare a gap instead |
| Any normative field | no self-reference between paired fields | `prose.mjs` | rejected |
| Any normative field | not a computed word list | `prose.mjs` | rejected |
| Declared unknown | carries a non-empty `gap` naming its cure | `prose.mjs` | rejected |
| Post-extraction | concepts referenced but never defined | `index.mjs` | gap queued |
| Post-extraction | zero-claim units, below-median density | `index.mjs` | targeted re-probe |
| Saturation | new-claim ratio over the last two probes | script | continue or stop |
| Post-consolidation | dispositions cover every claim | `check-store.mjs` | warning; certificate withheld |
| Rule construction | every rule has `when`, and `unless` or a gap | `check-store.mjs` | rule flagged |
| Rule construction | boundary clauses carry `from` provenance | `check-store.mjs` | rejected |
| Rule construction | every cluster has an anti-pattern | script | targeted probe issued |
| Compilation | every rule resolves to evidence | `check-store.mjs` | rule rejected |
| Skill lint | frontmatter, token budget, links, description | `validate-skill.mjs` | build fails |
| Re-entry | recorded prompt hash matches the prompt on disk | `checkpoint.mjs` | unit returns to pending |
| Audit | sampled rules verified against source | model | rule rejected, cluster re-examined |
| Certificate | all denominators reconcile | `certify.mjs` | certificate withheld |

## Failure handling

| Failure | Detection | Response |
|---|---|---|
| Source query timeout | adapter error | retry with backoff, then mark the unit `source-failed` |
| Empty source response | zero-length body | **mark failed, never done** — a silent empty extraction is the worst outcome, because it reports as coverage |
| Schema rejection loop | three consecutive rejections | mark `schema-failed`, halt the unit, surface for inspection |
| Worker crash | non-zero exit | unit stays pending, re-dispatched next pass |
| Saturation not reached at cap | probe registry exhausted, ratio still high | mark `saturation-not-reached`, carry into the certificate |
| Consolidation ambiguity | the merge judgement declines | keep both claims, record as distinct, flag for review |
| Unresolvable evidence chain | script check at compile | reject the rule outright; this is fabrication |
| Conversion suspect, unresolved | `ingest.mjs` | extraction from that page refused until declared |

The governing rule: **failures are recorded loudly and never resolved by
silently downgrading the requirement.** A unit that could not be processed
appears in the certificate as an unprocessed unit, not as an absence.

## Exit codes

Uniform across every script: `0` clean, `1` warnings only, `2` needs attention,
`3` the check could not run. Only `2` blocks a commit — warnings must not,
because a store part-way through the pipeline legitimately carries them.
