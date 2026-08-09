---
name: skill-knowledge-distiller
description: Turn a body of knowledge into a working agent skill. Use when the user wants documentation, a codebase, an API, a transcript, a runbook, a spec or hard-won session experience captured as a reusable SKILL.md - including phrasings like "make this a skill", "turn these docs into a skill", "distill this repo", "capture how we do X", "write a skill for this library", or when a workflow has just been worked out by hand and should not have to be worked out again. Covers scoping the source, deciding what is worth keeping, splitting the body from docs/ and scripts/, writing a description that actually triggers, and checking the result against the format's constraints. Does not run git operations, install skills, or design non-skill artifacts such as rules, hooks and plugins.
---

# Skill Knowledge Distiller

A skill is worth exactly what it saves the model from rediscovering. That single
idea decides every question below: what to keep, what to cut, what goes in the
body, and whether the skill should exist at all.

Distillation is subtraction, not summary. A summary shortens everything
proportionally. Distillation throws most of the source away and keeps the part
that is load-bearing.

## The pipeline

```
Scope -> Harvest -> Distill -> Structure -> Describe -> Validate
```

Run it in order. The most common failure is writing the description first, from
an idea of the skill, rather than last, from the skill that actually exists.

## 1. Scope

Before reading the source, settle three things with the user:

- **The task.** Not the topic. "Working with the payments API" is a topic;
  "issuing a refund and reconciling it" is a task. A skill scoped to a topic
  becomes a manual nobody reads.
- **The trigger.** What will someone actually type when they need this? Collect
  real phrasings now; they become the description and the eval set.
- **The reader.** A model with general knowledge and no access to this
  organisation, this codebase or last Tuesday's decision.

If the answer to "what does the model do differently once this loads" is vague,
stop and sharpen the scope. Building the wrong skill well is the expensive
outcome.

## 2. Harvest

Read the source in full before writing anything. Skimming produces a skill that
describes the intention of the documentation rather than the behaviour of the
system, and those diverge more often than anyone expects.

Where the source is a codebase, prefer what the code does over what its README
claims. Where the source is a transcript, mine the corrections - the moments
where the first attempt was wrong are the highest-value content in the whole
session, because they are exactly what will go wrong again.

Collect, without editing yet: commands that were run, exact file paths, formats
and schemas, constraints discovered the hard way, decisions and their reasons,
and the failure modes that were hit.

## 3. Distill

Judge every candidate line against one question: **would a competent model
already know this, or get it right by default?**

Keep it when it is:

- **Local.** True of this repository, this API, this team, and nowhere else.
- **Surprising.** The default guess is wrong. This is the highest-value class.
- **Expensive.** Rediscovering it costs a failed run, a long search, or a
  destructive mistake.
- **Exact.** A path, a flag, a schema, a version boundary, a magic string.

Cut it when it is:

- General programming knowledge, restated.
- Prose that hedges without deciding.
- An example that only illustrates the obvious case.
- History about how the system came to be, unless it changes what to do now.

Write the reason, not just the rule. A model that understands why a constraint
exists handles the case the instructions did not anticipate; one following
orders cannot. When a wall of MUST and NEVER is accumulating, the reasoning
behind them has not been written down yet - write that instead, and most of the
imperatives become unnecessary.

## 4. Structure

Front-load. The reader goes top to bottom, so the common case comes first and
edge cases go lower or out of the body entirely.

| Content | Where | Why |
|---|---|---|
| The decision procedure, the common path | `SKILL.md` body | Always read once the skill fires. |
| Reference tables, rare cases, deep background | `docs/`, linked | Loads only when the body points at it. |
| Anything deterministic and repeatable | `scripts/` | Only the output enters context, never the source. |
| Fill-in starting points | `templates/` | Copied, not read. |

Keep the body under roughly 5000 tokens. The limit is not bureaucratic: every
token the skill spends is a token the actual work does not get. A 500-line
validator in `scripts/` costs the same context as the word "Passed", which is
why deterministic checks belong there rather than as prose instructions the
model has to follow by hand.

Link every reference document from the body. An unlinked file in `docs/` is
invisible - nothing will ever load it.

## 5. Describe

The description is the entire trigger surface. Whatever else the skill contains,
the decision to load it is made from the name and description alone.

Write it last, once the scope has stopped moving. The shape that works:

1. What it does, in concrete action verbs, first clause.
2. When to use it - naming file types, tool names, commands and the phrasings a
   user would really type, including the sloppy ones.
3. What it does *not* cover, when a sibling skill would otherwise be shadowed.

Keep it inside the format's character limit and make the `name` match the
directory exactly. A mismatched name means the skill never loads at all, and
nothing reports an error.

## 6. Validate

Three checks, in increasing cost:

1. **Format.** Name matches the directory, description within limits, body
   within budget, every link resolves, only documented frontmatter keys present.
2. **Trigger.** Eight to ten queries that should fire it, eight to ten
   near-misses that should not. The negatives carry the signal: an obviously
   unrelated negative tests nothing, while a query that shares vocabulary and
   genuinely needs a different skill tests the boundary.
3. **Behaviour.** Run the real task with the skill loaded, on a case that is not
   in the source material. A skill that only handles its own examples has
   memorised, not distilled.

Fix what the checks report rather than relaxing the check. An eval tuned until
it is green has stopped being an eval.

## Failure modes

- **The encyclopedia.** Everything from the source, reorganised. Symptom: the
  body is mostly things the model already knew. Cure: apply the keep-test line
  by line and delete without mercy.
- **The skill that never fires.** Good content, vague description. Symptom:
  users solve the problem by hand while the skill sits unused. Cure: rewrite the
  description from the phrasings people actually type.
- **The stale twin.** The source moves; the skill does not. Symptom: confident
  instructions that no longer match reality, with no way for a reader to tell.
  Cure: record what the skill was distilled from, and re-distill when that
  changes.
- **Instructions without reasons.** Symptom: the model follows the letter and
  misses the point on any case not explicitly listed. Cure: state the goal
  behind each rule.

## When not to build a skill

Guidance that should apply to every request belongs in always-loaded project
instructions, not a skill that has to be triggered. Policy that must hold
whether or not a model cooperates belongs in a hook or in CI. A new capability
the model can call is a tool, not a set of instructions. Say so and stop - a
skill built for one of these is effort spent on something that will not work.
