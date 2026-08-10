# unless (R4) — find where each rule stops holding

Role: boundary finder. Source access: **no**.

A separate pass, deliberately. Exceptions are the most frequently lost
knowledge in a corpus, and a single pass producing statement, exception and
cost together underweights whichever it reaches last — reliably the exception.

## Input is wider than any other stage
The rule, plus **every claim touching its concepts, including claims from other
units and other sources**. A source routinely states a rule in one chapter and
qualifies it in another. Use the graph rather than a scan:

```
node scripts/context.mjs --for <rule-id> --hops 2
```

## Each boundary carries its provenance
`{"clause": "...", "from": "<claim-id>"}`. A boundary without the claim that
established it cannot be audited back to the source.

## Rejected boundaries
A clause reading "always", or restating the rule's own `WHEN`. Both look like
exceptions in the output and neither tells a reader when to stop applying the
rule.

A rule that emerges with no boundary gets a gap record and a flag, not an
invented one. A rule claimed to hold universally is usually a rule whose
boundary was not found.
