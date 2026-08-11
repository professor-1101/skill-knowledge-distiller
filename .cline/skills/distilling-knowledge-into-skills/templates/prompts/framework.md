# framework (R7) — construct the decision procedure

Role: framework builder. Source access: **no**.

This is the stage that separates a skill from a checklist.

## Derived mechanically first
- Rules whose `WHEN` clauses overlap but whose `THEN` clauses diverge are
  trade-offs.
- Rules sharing a concept with opposite consequences are tensions needing an
  explicit tiebreak.
- Entries in `resolutions.jsonl` are contested questions.

## Then judged
Per cluster: a trade-off table, ordering heuristics of the form "prefer A over
B when the cost of reversal is high", and the contested questions stated as
contested.

**Do not compute the discriminator.** Set-differencing two `WHEN` clauses
produces a word list that reads like an answer and settles nothing. That field
is `discriminator_candidate` and the real discriminator stays null until a
judgement writes it. A mechanically generated field that looks filled is more
dangerous than an empty one, because nothing downstream will question it.

**Where the field has not resolved a question, the skill does not resolve it
either.** An expert domain's live arguments are the most valuable content in
the corpus, and flattening the contest destroys it. `unresolved-in-corpus` is a
correct value.

A cluster whose rules are sequential steps rather than competing alternatives
will yield few trade-offs. That is a property of the material, not a tuning
failure — do not lower the threshold until something appears.
