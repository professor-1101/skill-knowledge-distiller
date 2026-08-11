# Validation points, quality gates, and failure handling

Read this when wiring enforcement, or when deciding whether a requirement
belongs in a prompt or in a script.

The governing principle: **a rule that can be checked by a script is never left
to a prompt.** Prompts request; gates guarantee. Every mechanically checkable
requirement belongs in the table below rather than in prose asking politely.

## Validation points

| Point | Check | Mechanism | On failure |
|---|---|---|---|
| Ingest | the source is an EPUB | `ingest.mjs` | blocked; there is no fallback format |
| Ingest | every prose text node reached the output | `lib/epub.mjs` | segment refused, naming the offset |
| Ingest | DRM, missing spine document, dangling idref, corrupt entry | `lib/epub.mjs` | blocked; a partial book that looks whole is the failure |
| Ingest | an extractor refusal is declared | `lib/store.mjs` | blocked; an undeclared refusal is a segment nobody accounted for |
| Ingest | `kind` is derived, not written | `lib/store.mjs` | flagged; a hand-written row is not describing the markup |
| Ingest | image-only and empty segments are flagged | `lib/store.mjs` | flagged; figures are not counted as covered |
| Ingest | re-ingest does not change the text | `ingest.mjs` | blocked; every excerpt_hash was built on the old text |
| Enumerate | units transcribed from nav or NCX | `enumerate.mjs` | no navigation is a gap, never an invented structure |
| Enumerate | a spine document the TOC omits still gets a unit | `enumerate.mjs` | unit added at spine grain, gap recorded |
| Chunk | chunks tile the document exactly once | `chunk.mjs` | blocked |
| Chunk | every chunk resolves to a unit | `lib/store.mjs` | blocked; a chunk with no unit is text coverage cannot see |
| Chunk | ids are structural, not positional | `chunk.mjs` | stable under insertion elsewhere |
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
| Compilation | the package Cline will actually load: name matches directory, description within 1024, body within budget, every linked file present | `skill-lint.mjs` | build fails |
| Cline hooks | file-based contract: location, name, executability, stdin, `cancel`, exit 2 | `hooks-lint.mjs` | build fails |
| Re-entry | recorded prompt hash matches the prompt on disk | `checkpoint.mjs` | target returns to pending, at chunk grain |
| Status | unit status derived from claims and probes | `sync-corpus.mjs` | corrected; never accepted as written |
| Saturation | two consecutive probes below the ratio | `sync-corpus.mjs` | continue or stop |
| Probe | every round logged, including zero-yield | `probe.mjs` | blocked; the same type twice in a row is refused |
| Confidence | matches the rubric | `lib/schema.mjs`, `confidence.mjs` | rejected; run confidence.mjs |
| Claim write | `unit` agrees with the chunk that was read | `lib/schema.mjs` | rejected; two places to write one fact is one place to disagree |
| Any artifact | every JSONL line parses | `check-store.mjs` | error; a skipped line makes every total below it wrong |
| Integrity | recorded digests and lengths recompute | `check-store.mjs --verify` | error; provenance never rechecked is not provenance |
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
