# The graph layer

## What was rejected, precisely

The previous architecture rejected an early typed knowledge graph. Read that
rejection carefully, because it does not say what it first appears to.

It rejected **typed semantic edges authored by judgement across thousands of
raw claims** — quadratic in judgement calls, with a payoff concentrating almost
entirely in one query that `defines` minus `mentions` already answers as a set
difference for free.

It did not reject **structural edges derived mechanically**. Those cost no
judgement at all, because a script reads each one off a field that already
exists.

Both hold here. R7 still constructs semantic relationships, over a few hundred
canonical rules rather than thousands of raw claims, where the cost is two
orders of magnitude lower and the results are used.

## The edges

| Type | Edge | Derived from |
|---|---|---|
| `contains` | doc → chapter → section → unit, cluster → rule | `corpus.jsonl`, `rules.cluster` |
| `evidences` | unit → claim | `claim.unit` |
| `defines` / `mentions` | claim → concept | claim fields |
| `derived_from` | rule → claim | `rules.derived_from` |
| `bounds` | claim → rule | `rules.unless[].from` |
| `merged_into` | claim → claim | `dispositions.jsonl` |
| `contradicts` | claim → claim | `resolutions.jsonl` |
| `guards_against` | rule → anti-pattern | `rules.anti_patterns` |
| `trades_off_with` | rule → rule | `frameworks.tradeoffs` |

## The guarantee: it is a projection

`graph.mjs` rebuilds it from the JSONL artifacts. Nothing writes to it
directly. Deleting it loses nothing, and rebuilding it is byte-identical —
that reproducibility is the test, and it runs in `selftest`-adjacent CI.

If the graph ever became authoritative it would be a second store to keep in
sync, and the two would drift exactly the way status once drifted from claims.
The claim store remains the only source of truth.

## What it buys

Bounded, named input sets for stages that would otherwise scan the corpus:

```bash
node scripts/context.mjs --for rule/<id> --hops 2
node scripts/context.mjs --for concept/<slug> --hops 1
```

Distance is reported alongside each hit, because a claim reached at two hops
arrived through a shared concept — a weaker relationship than a direct
derivation, and a stage weighing evidence should be able to see the difference.

## On a graph MCP server: evaluated, deferred

An MCP server is a runtime dependency, and portability across every Cline
surface is the binding constraint here. The retrieval need is served by a local
query over a derived file at the scale this pipeline targets — a few thousand
claims, a few hundred rules.

It becomes worth revisiting if graph queries need to span sessions or tools, or
if traversal outgrows a linear scan. The edge schema is deliberately plain so
an adapter is additive rather than a rewrite.
