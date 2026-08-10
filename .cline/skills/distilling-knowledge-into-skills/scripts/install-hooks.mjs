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

const MARKER = "# distilling-knowledge-into-skills";
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

// The Cline CLI reads additional hooks from a directory (`--hooks-dir`,
// defaulting to ~/.cline/hooks). The stage vocabulary is documented, but the
// exact discovery contract for a non-plugin hooks directory is not something
// this repository has verified against a running Cline — so these are written
// as plain executables named for their stage, and the git tier is what the
// guarantee actually rests on.
const CLINE_HOOKS = {
  session_start: `#!/bin/sh
${MARKER}
# Announce the methodology at session start, and record which SKILL.md was
# loaded. The gate below binds to that hash: editing the methodology without
# re-loading it leaves the token stale and the gate closed — the same
# invalidation-by-hash rule the pipeline applies to prompt versions.
node "${SKILL_REL}/scripts/activate.mjs" --root . || true
`,
  tool_call_before: `#!/bin/sh
${MARKER}
# Refuse a write into the claim store while the methodology is not active.
node "${SKILL_REL}/scripts/activate.mjs" --root . --gate || exit 2
`,
  tool_call_after: `#!/bin/sh
${MARKER}
# Validate what was just written and hand the rejections back to the model.
# Only exit 2 (needs attention) blocks; warnings are reported and allowed.
node "${SKILL_REL}/scripts/check-store.mjs" --root . --profile strict --quiet
[ $? -ge 2 ] && exit 2
exit 0
`,
};

function installCline(root, apply) {
  const dir = path.join(root, ".cline", "hooks");
  for (const [name, body] of Object.entries(CLINE_HOOKS)) {
    const file = path.join(dir, name);
    process.stdout.write(`  ${apply ? "write" : "would write"}  ${file}\n`);
    if (apply) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, body, "utf8");
      fs.chmodSync(file, 0o755);
    }
  }
  process.stdout.write(
    `\n  Cline reads these with: cline --hooks-dir ./.cline/hooks\n` +
      `  Unverified against a running Cline in this repository. The git hook is\n` +
      `  what the guarantee rests on; this tier is an addition, not a substitute.\n`
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
  const dir = path.join(root, ".cline", "hooks");
  for (const name of Object.keys(CLINE_HOOKS)) {
    const file = path.join(dir, name);
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(MARKER)) {
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
    else process.stdout.write("  (pass --cline to also write .cline/hooks/)\n");
  }

  if (!apply) process.stdout.write("\nNothing was written.\n");
  process.exit(rc);
}

main();
