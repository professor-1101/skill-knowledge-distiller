#!/usr/bin/env node
// install-hooks.mjs — make the methodology refuse, on every surface.
//
// The previous project's hardest-won lesson is that a methodology nothing
// enforces is a suggestion. Its gate was three Claude-Code-specific hooks, and
// porting that shape directly would strand every author working in the VS Code
// or JetBrains extension, where Cline plugins do not run.
//
// So enforcement is layered, and the layers run the same `check-store.mjs`:
//
//   git pre-commit   every surface, no Cline involvement    <- installed here
//   Cline hooks      CLI and SDK, via --hooks-dir           <- installed here
//   the skill body   advisory, everywhere                   <- always present
//
// The git tier is the load-bearing one and is not a fallback. Cline can write
// a malformed claim in an IDE extension and no Cline hook will see it — but
// the commit refuses, so the store never accepts it.
//
// An existing hook of the same name is chained, never replaced. A tool that
// silently overwrites somebody's pre-commit hook gets uninstalled once.
//
//   node install-hooks.mjs                 # preview; writes nothing
//   node install-hooks.mjs --apply
//   node install-hooks.mjs --cline --apply # also write .cline/hooks/
//   node install-hooks.mjs --uninstall --apply
//
// Exit 0 clean, 2 on refusal.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { parseArgs } from "./lib/jsonl.mjs";

// The marker identifies files we generated, so uninstall never removes
// somebody else's hook. It is matched on the bare text because the comment
// syntax differs by language — `#` is a comment in shell and a syntax error
// in JavaScript, which is exactly the bug this constant used to cause.
const MARKER_TEXT = "distilling-knowledge-into-skills";
const MARKER = `# ${MARKER_TEXT}`;
const JS_MARKER = `// ${MARKER_TEXT}`;
const SKILL_REL = ".cline/skills/distilling-knowledge-into-skills";

function gitDir(root) {
  try {
    return execSync("git rev-parse --git-dir", { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function preCommitBody(scriptPath) {
  return `#!/bin/sh
${MARKER}
# Refuses a commit that would put unverifiable material into the claim store.
#
# This runs on every surface, including the IDE extensions where Cline hooks
# are unavailable. It is the tier that makes the policy hold rather than be
# encouraged.
#
# Exit codes follow the family convention: 0 clean, 1 warnings only, 2 needs
# attention. Only 2 blocks. Warnings must not block, because a store part-way
# through the pipeline legitimately carries them — claims awaiting refinement
# have no disposition yet, and a gate that refused that would make the
# incremental workflow impossible and get switched off within a day.
#
# --no-verify defeats this, as it defeats any hook. That is why the same check
# also belongs in CI, where the person being checked cannot opt out: see
# install-ci.mjs.
node "${scriptPath}" --root . --staged --profile strict
rc=$?
if [ "$rc" -ge 2 ]; then
  echo "" >&2
  echo "Commit refused: the claim store would accept material that cannot be verified." >&2
  exit 1
fi
`;
}

function chainedBody(existingPath) {
  return `
${MARKER} chained the previous hook below
"${existingPath}" "$@" || exit $?
`;
}

function installGit(root, apply) {
  const gd = gitDir(root);
  if (!gd) {
    process.stderr.write("BLOCKED: not a git repository — nothing to install into\n");
    return 2;
  }
  const hooksDir = path.isAbsolute(gd) ? path.join(gd, "hooks") : path.join(root, gd, "hooks");
  const hook = path.join(hooksDir, "pre-commit");
  const script = path.join(root, SKILL_REL, "scripts", "check-store.mjs");

  if (!fs.existsSync(script)) {
    process.stderr.write(
      `BLOCKED: ${SKILL_REL}/scripts/check-store.mjs is not in this repository.\n` +
        `The hook runs from a clean checkout, so the checks have to be committed\n` +
        `here rather than installed globally on one machine.\n`
    );
    return 2;
  }

  let body = preCommitBody(path.relative(root, script));
  let note = "create pre-commit";

  if (fs.existsSync(hook)) {
    const current = fs.readFileSync(hook, "utf8");
    if (current.includes(MARKER)) {
      process.stdout.write(`  already installed  ${hook}\n`);
      return 0;
    }
    // Preserve what is there by moving it aside and calling it. Whoever wrote
    // it had a reason, and that reason is not ours to overrule.
    const kept = hook + ".pre-distill";
    note = `chain existing hook to ${path.basename(kept)}`;
    if (apply) {
      fs.renameSync(hook, kept);
      fs.chmodSync(kept, 0o755);
    }
    body += chainedBody(kept);
  }

  process.stdout.write(`  ${apply ? "write" : "would write"}  ${hook}   (${note})\n`);
  if (apply) {
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(hook, body, "utf8");
    fs.chmodSync(hook, 0o755);
  }
  return 0;
}

// Cline's *file-based* hook system, which is the one that needs no plugin.
//
// The earlier version of this file guessed, and guessed wrong on four counts:
// it wrote SDK stage names (`tool_call_before`) as file names, into the wrong
// directory (`.cline/hooks/`), with no stdin handling and no JSON response.
// Those are two different systems. The SDK one is TypeScript handlers inside
// an `AgentPlugin.hooks` object and needs a plugin; this one is executables
// discovered by name, and does not.
//
//   location  .clinerules/hooks/ (project) · ~/Documents/Cline/Rules/Hooks/ (global)
//   name      exactly the hook type, no extension, executable
//   stdin     one JSON object with clineVersion, hookName, taskId,
//             workspaceRoots, and per-hook fields
//   stdout    one JSON object: { cancel, errorMessage, contextModification }
//   exit 2    PreToolUse only — blocks the call, stderr goes to the model
//
// `scripts/hooks-lint.mjs` checks the generated files against that contract
// statically, because it cannot be checked by running Cline from here.
const CLINE_HOOK_DIR = path.join(".clinerules", "hooks");
const CLINE_HOOKS = ["TaskStart", "PreToolUse", "PostToolUse"];

/**
 * The generated hook is a shim. All the logic lives in `cline-hook.mjs`, which
 * calls the same `activate.mjs` and `check-store.mjs` the git tier runs — one
 * implementation of every rule, three ways to invoke it.
 *
 * It resolves its target relative to its own location rather than the working
 * directory, because a hook is not guaranteed to be run from the workspace
 * root. Written as CommonJS: a file with no extension is CJS to Node, and a
 * dynamic import reaches the ESM library from there.
 */
function clineHookBody(hookName, relToSkill) {
  return `#!/usr/bin/env node
${JS_MARKER}
// ${hookName} — generated. Edit scripts/cline-hook.mjs, not this file.
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const target = path.resolve(__dirname, ${JSON.stringify(relToSkill)}, "scripts", "cline-hook.mjs");
import(pathToFileURL(target).href)
  .then((m) => m.run(${JSON.stringify(hookName)}))
  .catch((e) => {
    // Fail open: a hook that refuses because it could not load itself halts
    // the pipeline for a reason unrelated to the work. The git tier still
    // catches whatever this misses.
    process.stdout.write(JSON.stringify({ cancel: false }));
    process.stderr.write("distill hook could not load: " + e.message + "\\n");
  });
`;
}

function installCline(root, apply) {
  const dir = path.join(root, CLINE_HOOK_DIR);
  const relToSkill = path.relative(dir, path.join(root, SKILL_REL)) || ".";
  for (const name of CLINE_HOOKS) {
    const file = path.join(dir, name);
    process.stdout.write(`  ${apply ? "write" : "would write"}  ${file}\n`);
    if (apply) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, clineHookBody(name, relToSkill), "utf8");
      fs.chmodSync(file, 0o755);
    }
  }
  process.stdout.write(
    `\n  Discovered automatically from ${CLINE_HOOK_DIR}/ — no plugin required, so\n` +
      `  this tier reaches the IDE extensions too. Check the generated files against\n` +
      `  the documented contract with:\n` +
      `    node ${SKILL_REL}/scripts/hooks-lint.mjs\n`
  );
  return 0;
}

function uninstall(root, apply) {
  const gd = gitDir(root);
  let rc = 0;
  if (gd) {
    const hooksDir = path.isAbsolute(gd) ? path.join(gd, "hooks") : path.join(root, gd, "hooks");
    const hook = path.join(hooksDir, "pre-commit");
    const kept = hook + ".pre-distill";
    if (fs.existsSync(hook) && fs.readFileSync(hook, "utf8").includes(MARKER)) {
      process.stdout.write(`  ${apply ? "remove" : "would remove"}  ${hook}\n`);
      if (apply) fs.unlinkSync(hook);
      if (fs.existsSync(kept)) {
        process.stdout.write(`  ${apply ? "restore" : "would restore"} ${kept} -> pre-commit\n`);
        if (apply) fs.renameSync(kept, hook);
      }
    } else {
      process.stdout.write("  no pre-commit hook of ours to remove\n");
    }
  }
  const dir = path.join(root, CLINE_HOOK_DIR);
  for (const name of CLINE_HOOKS) {
    const file = path.join(dir, name);
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(MARKER_TEXT)) {
      process.stdout.write(`  ${apply ? "remove" : "would remove"}  ${file}\n`);
      if (apply) fs.unlinkSync(file);
    }
  }
  return rc;
}

function main() {
  const args = parseArgs(process.argv.slice(2), { root: "." });
  const apply = Boolean(args.apply);

  process.stdout.write(apply ? "installing hooks\n" : "preview only — pass --apply to act\n");

  let rc = 0;
  if (args.uninstall) rc = uninstall(args.root, apply);
  else {
    rc = installGit(args.root, apply) || rc;
    if (args.cline) rc = installCline(args.root, apply) || rc;
    else process.stdout.write(`  (pass --cline to also write ${CLINE_HOOK_DIR}/)\n`);
  }

  if (!apply) process.stdout.write("\nNothing was written.\n");
  process.exit(rc);
}

main();
