# Compiling a skill package

R8, fully specified. Input: `rules.jsonl`, `frameworks.jsonl`,
`anti-patterns.jsonl`, `dispositions.jsonl`, `claims/` for evidence resolution
only. Source access: **no**.

## Mapping refinement output onto the format

Mechanical. It should not require invention at compile time.

| Refinement artifact | Destination | Loaded |
|---|---|---|
| concept cluster | one skill package | — |
| canonical rules | body → Rules | on trigger |
| trade-off table, tie-breaks | body → Deciding between rules | on trigger |
| anti-patterns paired to rules | body → Failure modes | on trigger |
| claims dispositioned `context` | body → Principles | on trigger |
| `resolutions.jsonl` entries | body → Contested | on trigger |
| claims dispositioned `supporting` | `docs/examples.md` | when linked |
| evidence locators | `docs/evidence.md` | when linked |

**Contested questions belong in the body, not in `docs/`.** Where two sources
disagree, that disagreement is often the most valuable content in the corpus —
an expert domain's live arguments. Burying it in a reference file is exactly
the flattening R7 forbids.

## The budget resolves the central tension

Complete source traceability and a lean body look contradictory. They are not,
because they live at different levels: rules go in the body, and the
claim-to-locator chain goes in `docs/evidence.md`, where it is fully preserved
and costs nothing until someone asks where a rule came from.

Cline's body budget is **under 5k tokens** — tighter than the 500-line / 2000-word
guidance other formats use, so a skill written against those routinely arrives
150% over. Measure it, do not estimate it:

```bash
node <creator>/scripts/validate-skill.mjs <skill-dir>
```

It names the fattest sections, because the fix is nearly always "move these two
things out".

## Layout

Cline's directories are `docs/`, `templates/`, `scripts/`. `references/` and
`assets/` come from other formats and are wrong here — the validator flags
them, and a skill that triggers and then reads a missing file is worse than one
that never triggers.

## Canonical body template

Consistency across a library matters more than per-skill optimisation, because
the consumer learns the shape once.

```markdown
# <Title>

<Two sentences: the capability this confers, and the decision it helps make.>

## When this applies
<Situations as the reader would recognise them. Not a restatement of the
description — this is for the model that has already loaded the skill.>

## Principles
<3-6. The mental model under the rules. What lets a reader handle a case the
rules do not cover.>

## Rules
### R1 — <short imperative>
**When** <condition>  **Then** <action>  **Because** <mechanism>
**Unless** <exceptions>  **Cost** <what it trades away>

<Ordered by frequency of application, never by source order.>

## Deciding between rules
<Trade-off table and tie-break heuristics. This is what separates a skill from
a checklist.>

## Contested
<Where sources disagree, with attribution. Do not resolve what the field has
not resolved.>

## Failure modes
<Per anti-pattern: what it looks like, the symptom that reveals it, the rule it
violates.>

## Checklist
## Sources
```

## Writing doctrine

**Explain the mechanism; do not issue commands.** Reasoning generalises to the
case nobody anticipated. Finding yourself writing `MUST`, `ALWAYS` or `NEVER`
in capitals means the reasoning behind them has not been written down yet —
write that instead, and most of the imperatives become unnecessary.

**Two registers.** Description in third person; body in the imperative.

**Lead with the decision, follow with the justification.** The reader is
mid-task, not studying. Never open a skill with background.

**Generalise past the source's examples.** State the rule so it transfers to a
reader who never saw the example, then use the example as illustration.

## The description

The entire trigger surface: name and description are all the model sees when
deciding whether to load the skill. Nothing in the body affects that.

Written **first** as a design instrument — if you cannot write one crisp
trigger sentence, the boundary is wrong, so go back and re-cut it. Then the
draft is **discarded and rewritten last**, from the finished body, and
trigger-evalled. The first writing tests the boundary; the second is the
product. (The two source traditions disagree here; this resolves it by doing
both, for their different reasons.)

Name the *symptoms*, not only the vocabulary. The reader who has the problem
but not the term is where a skill is most valuable and least likely to fire.
The known default failure is under-triggering, so be assertive about scope
rather than modest — then bound it, because saying what a skill does not cover
reduces false triggers more reliably than more keywords do.

## Evals

**Trigger:** 8-10 positives, 8-10 negatives. The negatives carry the signal, and
they must be near-misses. In a library distilled from one corpus the dominant
failure is not a skill failing against unrelated queries — it is **sibling
skills firing against each other**, because they share vocabulary throughout.
So most negatives for skill A should be queries that ought to fire sibling B,
descriptions are optimised jointly across the library, and any change re-runs
the whole library's evals rather than one skill's.

Select on a held-out split. Selecting on training score reliably produces a
description that has memorised twenty queries and generalises worse than the
one you started with.

**Task:** two or three realistic tasks per skill, run with and without. Read
the transcripts, not just the outputs. A skill that reads well and changes
nothing has failed.

## Definition of done

- frontmatter valid; `name` equals the directory; description under 1024 chars
- body under 5k tokens; every link resolves
- every rule carries `when`, and `unless` or a gap record explaining its absence
- every rule resolves to evidence, script-verified
- at least one anti-pattern per rule cluster
- contested points preserved with attribution, in the body
- trigger eval held out above threshold, no sibling collisions
- task eval distinguishable from baseline
- `docs/evidence.md` complete
