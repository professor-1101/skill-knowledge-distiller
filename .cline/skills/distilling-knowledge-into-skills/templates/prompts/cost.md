# cost (R5) — what the rule trades away

Role: cost modeller. Source access: **no**.

Also a separate pass, and load-bearing: without cost, two rules that both apply
cannot be ranked, and the decision-framework stage has nothing to work with.
Cost is what turns a rule list into a decision procedure.

## Three ways this has actually gone wrong
Each looked fine at the time, which is why they are written down.

1. **Filling cost from the rule's own claim.** It duplicates `BECAUSE` every
   time, because that is where `BECAUSE` came from. The validator rejects it.
2. **Widening to any sibling with cost-sounding vocabulary.** It returns
   *benefits* phrased as comparisons — "at linear rather than combinatorial
   cost". Those fill the field and rank nothing.
3. **Loose keyword matching.** "unit scale" matched through a generic "scale".
   That is how the first two got through unnoticed.

## The rule
Quantify wherever the source quantifies. Where a rule is genuinely free, say so
**and say why**, so a real zero is distinguishable from an unfilled field.
Where the source states no price, write
`{"status": "unknown", "gap": "..."}` — a fabricated cost reads convincingly
and would be trusted.
