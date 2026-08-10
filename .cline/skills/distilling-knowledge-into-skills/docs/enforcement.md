# Enforcement — three tiers, one implementation

A methodology nothing refuses is a suggestion. The previous project proved the
gate design works; its mistake, for our purposes, was binding it to one agent's
hook system.

**One implementation of every check, three ways to invoke it.**

```
scripts/lib/            the checks — zero-dep Node, no runtime assumptions
   schema.mjs             claim/rule conformance, the unknown/gap union
   evidence.mjs           locator present, digest real, chain resolves
   prose.mjs              hedges, self-reference, specificity floor
   store.mjs              disposition coverage, chunk tiling, conversion fidelity

invoked by ─┬─ the skill body, as commands the model runs      every surface
            ├─ a git pre-commit hook                           every surface
            └─ a Cline hook, where the surface has one         CLI / SDK
```

Three enforcement points that disagree about the rules are three policies, so
they all shell out to `check-store.mjs`.

## The git tier is the load-bearing one

Not a fallback. Cline can write a malformed claim in the VS Code or JetBrains
extension and no Cline hook will see it — but the commit refuses, so the store
never accepts it.

```bash
node scripts/install-hooks.mjs            # preview; writes nothing
node scripts/install-hooks.mjs --apply
node scripts/install-hooks.mjs --uninstall --apply
```

An existing `pre-commit` is moved aside and chained, never replaced. Whoever
wrote it had a reason, and that reason is not ours to overrule.

Exit codes follow the family convention: 0 clean, 1 warnings, 2 needs
attention. **Only 2 blocks.** Warnings must not block, because a store part-way
through the pipeline legitimately carries them — claims awaiting refinement
have no disposition yet, and a gate that refused that would make incremental
work impossible and be switched off within a day.

## CI, because `--no-verify` exists

```bash
node scripts/install-ci.mjs --apply
node scripts/install-ci.mjs --platform gitlab --apply
```

Hooks are a courtesy and a per-machine setting nobody else can see. CI runs on
a clean checkout where the person being checked has no vote, and it carries the
two things a commit hook must not: the full test suite, and
`check-store.mjs --verify`, which re-reads every segment file to recompute its
digest. Recording a digest and never checking it is not provenance. It refuses to
write a pipeline when the skill is not committed, since CI has no other way to
reach it.

## The Cline tier

```bash
node scripts/install-hooks.mjs --cline --apply
cline --hooks-dir ./.cline/hooks
```

Writes `session_start`, `tool_call_before` and `tool_call_after` into
`.cline/hooks/`, carrying the activation-token design intact: the token records
the sha256 of the SKILL.md that was loaded, and the gate refuses claim-store
writes unless the token matches the file on disk **now**. Editing the
methodology without re-loading it leaves the token stale and the gate closed —
the same invalidation-by-hash rule the pipeline applies to prompt versions.

```bash
node scripts/activate.mjs            # write the token, print the ruleset
node scripts/activate.mjs --gate     # exit 2 unless the token is current
```

**Honest limitation.** Cline's CLI reads a hooks directory (`--hooks-dir`,
defaulting to `~/.cline/hooks`) and the stage vocabulary is documented, but the
exact discovery contract for a non-plugin hooks directory has not been verified
against a running Cline from this repository. Treat this tier as an addition.
The guarantee rests on git and CI, which are verified by
`tests/run-tests.mjs` and by the negative tests in `docs/pitfalls.md`.
