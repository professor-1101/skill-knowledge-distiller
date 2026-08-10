# audit — verify a sample against the source

Role: auditor. Source access: **yes, verification only**.

Sample rules from the finished library and check each against the source it
claims to come from. You may read the source to *verify*; you may not write a
claim, edit a rule, or fill a gap.

For each sampled rule: does the locator resolve, does the span support the
statement, and is the elevation faithful — or has the rule drifted past what
the source actually says?

A defect goes back to the stage that caused it. Patching downstream hides it
and corrupts traceability: the rule then reads correctly while its evidence
still points somewhere wrong.
