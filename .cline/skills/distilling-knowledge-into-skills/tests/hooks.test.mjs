// hooks.test.mjs — the Cline hook tier, checked statically.
//
// This tier cannot be proven by running it: that needs a live Cline, and there
// is none here. So it is checked two ways that do not need one — the generated
// files are linted against the documented contract, and the handlers are
// driven directly with the JSON Cline documents itself as sending.
//
// The negative cases are the point. Every one of them is a mistake the first
// attempt at this tier actually made: SDK stage names used as file names, no
// stdin handling, no JSON response, and a `#` comment marker that is valid
// shell and a syntax error in JavaScript.
//
// The directory is the case that changed shape. Cline's references name two
// project locations — `.clinerules/hooks/` and, in the CLI reference's
// configuration tree, `.cline/hooks/` — so installing one and calling the
// other wrong was itself a guess. Both are written; covering only one is what
// the lint now warns about.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it, assert, equal, includes } from "./harness.mjs";
import { lintHooks, CONTRACT, LEGACY_PROJECT_DIR } from "../scripts/hooks-lint.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SKILL_REL = ".cline/skills/distilling-knowledge-into-skills";
const cleanup = [];
process.on("exit", () => cleanup.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

/** A throwaway workspace with the skill in it and the hooks installed. */
function workspace({ install = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "distill-hooks-"));
  cleanup.push(dir);
  fs.mkdirSync(path.join(dir, SKILL_REL), { recursive: true });
  fs.cpSync(root, path.join(dir, SKILL_REL), { recursive: true });
  execFileSync("git", ["init", "-q", "."], { cwd: dir });
  if (install) {
    execFileSync("node", [path.join(dir, SKILL_REL, "scripts", "install-hooks.mjs"), "--root", ".", "--cline", "--apply"],
      { cwd: dir, stdio: "ignore" });
  }
  return dir;
}

/** Drive a hook exactly as Cline documents: JSON in, JSON out, exit code. */
function invoke(dir, hook, input, location = CONTRACT.projectDirs[0]) {
  const file = path.join(dir, location, hook);
  try {
    const out = execFileSync(file, [], {
      cwd: dir, input: JSON.stringify({ clineVersion: "3.36", hookName: hook, taskId: "t1", workspaceRoots: [dir], ...input }),
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    return { code: 0, json: JSON.parse(out), raw: out };
  } catch (e) {
    const raw = e.stdout || "";
    let json = null;
    try { json = JSON.parse(raw); } catch { /* the response is what is being tested */ }
    return { code: e.status, json, raw, stderr: e.stderr || "" };
  }
}

// ---------------------------------------------------------------------------
describe("hooks · the generated set conforms to the documented contract", () => {
  const dir = workspace();

  it("installs into .cline/hooks/, the documented project location", () => {
    equal(CONTRACT.projectDirs, [path.join(".cline", "hooks")]);
    for (const name of ["TaskStart", "PreToolUse", "PostToolUse"]) {
      assert(fs.existsSync(path.join(dir, CONTRACT.projectDirs[0], name)), `${name} is missing`);
    }
  });

  it("writes nothing into .clinerules/hooks/, which nothing reads", () => {
    // An earlier version wrote there on a citation that does not exist:
    // `customization/hooks` is a stub reading "See details under SDK Plugins",
    // and `.clinerules/` is documented for rules and skills, never hooks.
    assert(!fs.existsSync(path.join(dir, LEGACY_PROJECT_DIR)), "that directory was invented");
  });

  it("names files after the hook type with no extension, and makes them executable", () => {
    for (const location of CONTRACT.projectDirs) {
      for (const name of fs.readdirSync(path.join(dir, location))) {
        assert(CONTRACT.types.includes(name), `'${name}' is not a hook type`);
        assert(fs.statSync(path.join(dir, location, name)).mode & 0o111, `'${name}' is not executable`);
      }
    }
  });

  it("passes hooks-lint with no findings", () => {
    const { errors, warnings } = lintHooks(dir);
    equal(errors, []);
    equal(warnings, []);
  });

  it("resolves its delegate relative to its own directory, not the cwd", () => {
    // A hook is not guaranteed to be run from the workspace root.
    const r = invoke(dir, "TaskStart", {});
    equal(r.code, 0);
    includes(r.json.contextModification, "KNOWLEDGE-DISTILLATION METHODOLOGY ACTIVE");
  });
});

describe("hooks · behaviour against the documented JSON", () => {
  it("TaskStart returns contextModification carrying the activation ruleset", () => {
    const dir = workspace();
    const r = invoke(dir, "TaskStart", {});
    equal(r.code, 0);
    equal(r.json.cancel, false);
    includes(r.json.contextModification, "KNOWLEDGE-DISTILLATION METHODOLOGY ACTIVE");
  });

  it("PreToolUse blocks a guarded write while the methodology is inactive", () => {
    const dir = workspace();
    const r = invoke(dir, "PreToolUse", { toolInput: { path: "claims/book/ch01.jsonl" } });
    equal(r.json.cancel, true, "the JSON contract says cancel");
    includes(r.json.errorMessage, "no activation token");
    equal(r.code, 2, "exit 2 is the documented block for PreToolUse");
    includes(r.stderr, "activation token", "stderr is what reaches the model");
  });

  it("PreToolUse allows the same write once TaskStart has run", () => {
    const dir = workspace();
    invoke(dir, "TaskStart", {});
    const r = invoke(dir, "PreToolUse", { toolInput: { path: "claims/book/ch01.jsonl" } });
    equal(r.code, 0);
    equal(r.json.cancel, false);
  });

  it("PreToolUse leaves ungoverned paths alone", () => {
    const dir = workspace();
    const r = invoke(dir, "PreToolUse", { toolInput: { path: "README.md" } });
    equal(r.code, 0);
    equal(r.json.cancel, false);
  });

  it("PreToolUse blocks again once SKILL.md changes under a stale token", () => {
    const dir = workspace();
    invoke(dir, "TaskStart", {});
    fs.appendFileSync(path.join(dir, SKILL_REL, "SKILL.md"), "\nedited\n");
    const r = invoke(dir, "PreToolUse", { toolInput: { path: "rules.jsonl" } });
    equal(r.json.cancel, true);
    includes(r.json.errorMessage, "changed since the methodology was activated");
  });

  it("PostToolUse never cancels — only PreToolUse can block", () => {
    const dir = workspace();
    invoke(dir, "TaskStart", {});
    const r = invoke(dir, "PostToolUse", { toolInput: { path: "corpus.jsonl" } });
    equal(r.code, 0);
    equal(r.json.cancel, false);
  });

  it("a hook given malformed stdin fails open rather than halting the session", () => {
    const dir = workspace();
    const file = path.join(dir, CONTRACT.projectDirs[0], "PreToolUse");
    const out = execFileSync(file, [], { cwd: dir, input: "not json at all", encoding: "utf8" });
    equal(JSON.parse(out).cancel, false, "our own bug must not stop the user's work");
  });
});

describe("hooks · the lint catches every mistake this tier already made", () => {
  // Every documented location is populated by default, so a finding in these
  // tests is about the file being tested and not about coverage.
  const withHooks = (files, { locations = CONTRACT.projectDirs } = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "distill-lint-"));
    cleanup.push(dir);
    for (const location of locations) {
      const hooks = path.join(dir, location);
      fs.mkdirSync(hooks, { recursive: true });
      for (const [name, { body, mode = 0o755 }] of Object.entries(files)) {
        fs.writeFileSync(path.join(hooks, name), body);
        fs.chmodSync(path.join(hooks, name), mode);
      }
    }
    return dir;
  };
  const good = `#!/usr/bin/env node\nconst i = require("node:fs").readFileSync(0, "utf8");\nprocess.stdout.write(JSON.stringify({ cancel: false }));\n`;

  it("rejects an SDK stage name used as a file name", () => {
    const { errors } = lintHooks(withHooks({ tool_call_before: { body: good } }));
    includes(errors.join("\n"), "SDK plugin *stage* name");
  });

  it("reports hooks orphaned in the location an earlier version invented", () => {
    const dir = withHooks({ PreToolUse: { body: good } });
    const legacy = path.join(dir, LEGACY_PROJECT_DIR);
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "PreToolUse"), good);
    const { errors, warnings } = lintHooks(dir);
    equal(errors, [], "a stale file is not a contract violation");
    includes(warnings.join("\n"), "which Cline does not read");
    includes(warnings.join("\n"), "--uninstall");
  });

  it("rejects a file that never reads stdin", () => {
    const body = `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ cancel: false }));\n`;
    includes(lintHooks(withHooks({ PreToolUse: { body } })).errors.join("\n"), "never reads stdin");
  });

  it("rejects a file that never emits cancel", () => {
    const body = `#!/usr/bin/env node\nrequire("node:fs").readFileSync(0, "utf8");\nprocess.stdout.write("ok");\n`;
    includes(lintHooks(withHooks({ PreToolUse: { body } })).errors.join("\n"), "never emits a 'cancel' field");
  });

  it("rejects a file that does not parse — the '#' marker bug", () => {
    const body = `#!/usr/bin/env node\n# distilling-knowledge-into-skills\nprocess.stdout.write("{}");\n`;
    includes(lintHooks(withHooks({ PreToolUse: { body } })).errors.join("\n"), "does not parse as JavaScript");
  });

  it("rejects a non-executable hook", () => {
    const { errors } = lintHooks(withHooks({ PreToolUse: { body: good, mode: 0o644 } }));
    includes(errors.join("\n"), "not executable");
  });

  it("rejects an extension on the file name", () => {
    includes(lintHooks(withHooks({ "PreToolUse.sh": { body: good } })).errors.join("\n"), "has an extension");
  });

  it("warns when nothing refuses a claim-store write", () => {
    const { warnings } = lintHooks(withHooks({ PostToolUse: { body: good } }));
    includes(warnings.join("\n"), "no PreToolUse hook");
  });

  it("says nothing when the tier is simply not installed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "distill-lint-"));
    cleanup.push(dir);
    const { errors, warnings, notes } = lintHooks(dir);
    equal(errors, []);
    equal(warnings, []);
    includes(notes.join("\n"), "not installed");
  });
});

describe("hooks · uninstall reverses cleanly", () => {
  it("removes what it wrote and nothing else", () => {
    const dir = workspace();
    fs.writeFileSync(path.join(dir, CONTRACT.projectDirs[0], "TaskComplete"), "#!/bin/sh\nexit 0\n");
    execFileSync("node", [path.join(dir, SKILL_REL, "scripts", "install-hooks.mjs"), "--root", ".", "--uninstall", "--apply"],
      { cwd: dir, stdio: "ignore" });
    equal(fs.readdirSync(path.join(dir, CONTRACT.projectDirs[0])), ["TaskComplete"],
      "somebody else's hook is not ours to remove");
  });

  it("still clears the location an earlier version wrote to", () => {
    // Someone who installed the previous version has three executables sitting
    // in a directory nothing reads. Uninstall has to reach them, or upgrading
    // leaves an orphan that looks like enforcement.
    const dir = workspace();
    const legacy = path.join(dir, LEGACY_PROJECT_DIR);
    fs.mkdirSync(legacy, { recursive: true });
    for (const name of ["TaskStart", "PreToolUse", "PostToolUse"]) {
      fs.writeFileSync(path.join(legacy, name), `#!/usr/bin/env node\n// distilling-knowledge-into-skills\n`);
    }
    execFileSync("node", [path.join(dir, SKILL_REL, "scripts", "install-hooks.mjs"), "--root", ".", "--uninstall", "--apply"],
      { cwd: dir, stdio: "ignore" });
    equal(fs.readdirSync(legacy), []);
  });
});
