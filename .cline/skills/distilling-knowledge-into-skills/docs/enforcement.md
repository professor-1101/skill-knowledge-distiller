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

Cline has **two** hook systems, and conflating them is the trap. The first
attempt at this tier did, and was wrong on four counts at once.

| | SDK plugin hooks | File-based hooks |
|---|---|---|
| Where | `AgentPlugin.hooks` object | `.clinerules/hooks/` · `~/Documents/Cline/Rules/Hooks/` |
| Keyed by | *stage* — `tool_call_before`, `session_start` | *hook type* — `PreToolUse`, `TaskStart` |
| Written in | TypeScript | any executable |
| Needs a plugin | yes | **no** |

Plugins do not run in the VS Code or JetBrains extensions, so the file-based
system is the one used here.

```bash
node scripts/install-hooks.mjs --cline --apply
node scripts/hooks-lint.mjs                      # check them against the contract
```

The contract, as documented:

- the file name is **exactly** the hook type, with no extension, and executable
- one JSON object arrives on **stdin**: `clineVersion`, `hookName`, `timestamp`,
  `taskId`, `workspaceRoots`, `userId`, plus per-hook fields
- one JSON object goes to **stdout**: `{ cancel, errorMessage, contextModification }`
- **exit 2 blocks, and only for `PreToolUse`** — stderr reaches the model

Three hooks are installed. `TaskStart` writes the activation token and returns
the ruleset as `contextModification`. `PreToolUse` refuses a write into the
claim store when the token is missing or no longer matches the SKILL.md digest,
setting `cancel` **and** exiting 2 — both channels, because relying on one is a
bet. `PostToolUse` runs the store check and returns any rejections as context;
it never cancels, because it cannot.

All three are shims over `scripts/cline-hook.mjs`, which calls the same
`activate.mjs` and `check-store.mjs` the git tier runs.

### What is and is not verified

This tier **cannot be proven by running it** — that needs a live Cline, and the
environment this was built in has none. What it gets instead is static
analysis: `hooks-lint.mjs` checks location, naming, executability, that the
file parses in the language its shebang declares, that it reads stdin, that it
emits `cancel`, and that exit 2 appears only where it means something.

Twenty-one tests cover it, and the negative cases are all mistakes this tier
actually made: an SDK stage name used as a file name, `.cline/hooks/` as the
directory, no stdin handling, no JSON response, and a `#` comment marker that
is valid shell and a syntax error in JavaScript — which produced hooks that
were installed, executable, and could not run.

The handlers are also driven directly with the JSON Cline documents itself as
sending, which proves the round trip without proving that Cline invokes them.

**The guarantee still rests on git and CI.** This tier is an addition.
