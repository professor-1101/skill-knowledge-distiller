# Incremental runs, checkpoints, and re-entry

A book does not fit in one session. Work stops and starts again days later,
possibly with a different model. Two properties must hold: the second session
can tell what is already done without being told, and nothing it does corrupts
what the first produced.

## A stage is complete for a chunk when three things hold

1. A checkpoint row says so.
2. The output file still exists.
3. The recorded prompt hash matches the prompt file on disk **today**.

The third condition is the design. Editing `extract.md` mid-project invalidates
every claim produced under the old wording — automatically, by hash, rather
than by somebody remembering. Those units return to pending and re-run.

Without it, a store slowly becomes a mixture of outputs from procedures that no
longer exist, and nothing can tell which is which.

```bash
node scripts/checkpoint.mjs --record --unit s/ch03/s01 --stage R0 \
  --prompt templates/prompts/extract.md --output claims/s/ch03.jsonl --model <id>
node scripts/checkpoint.mjs --status --stage R0
node scripts/checkpoint.mjs --pending --stage R0
```

`checkpoints.jsonl` is append-only. Correcting a checkpoint means appending a
newer one; the history of what was believed when is never destroyed.

## A different model does not invalidate anything

`model_id` is recorded and never invalidates. Artifacts are data, and their
evidence chains verify independently of who produced them — that is the entire
value of hashing the span rather than trusting the writer. Treating a model
change as invalidating would make the store unresumable, which is the opposite
of the requirement. It is recorded so an audit can segment by it if quality
turns out to vary.

## What is safe to interrupt

Everything. The driver can be killed at any moment and loses at most one unit
of work; re-running is always safe. No conversation, session or memory is
load-bearing anywhere. **If losing a process loses information, the design has
a defect.**

## Adding material later

Adding a chapter appends units, extracts them, and re-runs the derived stages.
Increments are cheap through R1.

**Consolidation is corpus-wide, never per-increment.** Consolidating as material
arrives lets the first increment's vocabulary become the ontology every later
one is forced into — source-order bias, and it is unrecoverable once the rules
are written. R2 onward re-runs over everything. That is affordable because the
expensive part is source queries, and those are hash-keyed and cached: re-running
after a prompt change costs model tokens and zero source reads.

## Context, not memory

No stage is handed the corpus. It is handed the bounded set the graph says it
needs:

```bash
node scripts/context.mjs --for rule/<id> --hops 2
```

R4 is the stage that needs this most — its contract is the rule plus every
claim touching its concepts including ones from other units and other sources,
which is a full scan per rule without traversal and two hops with it.
