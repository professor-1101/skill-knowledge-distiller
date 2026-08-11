// install.test.mjs — the installer, including what it refuses to do.
//
// `install.mjs` lives at the repository root, outside the skill directory, so
// an installed copy cannot reach it. These tests skip in that case rather than
// failing: a suite that breaks when the skill is installed correctly would be
// measuring the wrong thing.
//
// The case that matters most is the refusal. An installer that silently
// overwrites somebody's edits gets deleted once, and rightly.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it, assert, equal, includes } from "./harness.mjs";

const skillRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(skillRoot, "..", "..", "..");
const INSTALLER = path.join(repoRoot, "install.mjs");
const available = fs.existsSync(INSTALLER);

const cleanup = [];
process.on("exit", () => cleanup.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "distill-install-"));
  cleanup.push(d);
  return d;
}

function run(args) {
  try {
    return { code: 0, out: execFileSync("node", [INSTALLER, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { code: e.status, out: (e.stdout || "") + (e.stderr || "") };
  }
}

describe("install · the installer", () => {
  if (!available) {
    it("SKIPPED — install.mjs is outside an installed copy, which is expected", () => {
      assert(true);
    });
    return;
  }

  it("reports honestly before anything is installed", () => {
    const target = path.join(tmp(), "skill");
    const r = run(["--check", "--path", target]);
    equal(r.code, 0);
    includes(r.out, "not installed");
  });

  it("installs the skill and writes a manifest", () => {
    const target = path.join(tmp(), "skill");
    equal(run(["--path", target]).code, 0);
    assert(fs.existsSync(path.join(target, "SKILL.md")));
    assert(fs.existsSync(path.join(target, "scripts", "check-store.mjs")));
    const manifest = JSON.parse(fs.readFileSync(path.join(target, ".install-manifest.json"), "utf8"));
    equal(manifest.name, "distilling-knowledge-into-skills");
    assert(Object.keys(manifest.files).length > 40, "the manifest must cover the whole install");
  });

  it("ships no development scaffolding it does not need", () => {
    const target = path.join(tmp(), "skill");
    run(["--path", target]);
    for (const junk of ["node_modules", ".git", "reports"]) {
      assert(!fs.existsSync(path.join(target, junk)), `${junk} has no business in an installed skill`);
    }
  });

  it("refuses to update over a local edit, and writes nothing when it refuses", () => {
    const target = path.join(tmp(), "skill");
    run(["--path", target]);
    const edited = path.join(target, "SKILL.md");
    fs.appendFileSync(edited, "\n# a local change\n");
    const before = fs.readFileSync(edited, "utf8");

    const r = run(["--path", target]);
    equal(r.code, 2, "an update over an edit must refuse");
    includes(r.out, "REFUSED");
    includes(r.out, "SKILL.md");
    equal(fs.readFileSync(edited, "utf8"), before, "the edit must survive a refusal untouched");
  });

  it("names the edits under --check and exits 1", () => {
    const target = path.join(tmp(), "skill");
    run(["--path", target]);
    fs.appendFileSync(path.join(target, "docs", "epub.md"), "\nedited\n");
    const r = run(["--check", "--path", target]);
    equal(r.code, 1);
    includes(r.out, "docs/epub.md");
    includes(r.out, "--force");
  });

  it("--check writes nothing at all", () => {
    const target = path.join(tmp(), "skill");
    run(["--path", target]);
    const before = fs.readFileSync(path.join(target, ".install-manifest.json"), "utf8");
    run(["--check", "--path", target]);
    equal(fs.readFileSync(path.join(target, ".install-manifest.json"), "utf8"), before);
  });

  it("--force discards the edit, as asked", () => {
    const target = path.join(tmp(), "skill");
    run(["--path", target]);
    fs.appendFileSync(path.join(target, "SKILL.md"), "\n# a local change\n");
    equal(run(["--path", target, "--force"]).code, 0);
    assert(!fs.readFileSync(path.join(target, "SKILL.md"), "utf8").includes("a local change"));
  });

  it("removes a file the previous install wrote and this one does not", () => {
    const target = path.join(tmp(), "skill");
    run(["--path", target]);
    const orphan = path.join(target, "docs", "removed-upstream.md");
    fs.writeFileSync(orphan, "stale\n");
    const manifestPath = path.join(target, ".install-manifest.json");
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    m.files["docs/removed-upstream.md"] = "0".repeat(64);
    fs.writeFileSync(manifestPath, JSON.stringify(m));

    // The digest is deliberately wrong, so this also proves --force is what
    // clears a stale file rather than the refusal path swallowing it.
    run(["--path", target, "--force"]);
    assert(!fs.existsSync(orphan), "a stale doc still loads and no longer matches anything");
  });

  it("installs into a project tree on request", () => {
    const proj = tmp();
    equal(run(["--project", "--root", proj]).code, 0);
    assert(fs.existsSync(path.join(proj, ".cline", "skills", "distilling-knowledge-into-skills", "SKILL.md")));
  });

  it("uninstalls, and says it touched nothing else", () => {
    const dir = tmp();
    const target = path.join(dir, "skill");
    const neighbour = path.join(dir, "someone-elses-skill");
    fs.mkdirSync(neighbour, { recursive: true });
    fs.writeFileSync(path.join(neighbour, "SKILL.md"), "not ours\n");

    run(["--path", target]);
    equal(run(["--uninstall", "--path", target]).code, 0);
    assert(!fs.existsSync(target));
    assert(fs.existsSync(path.join(neighbour, "SKILL.md")), "only this skill is removed");
  });

  it("uninstalling something that is not there is not an error", () => {
    const r = run(["--uninstall", "--path", path.join(tmp(), "absent")]);
    equal(r.code, 0);
    includes(r.out, "nothing installed");
  });

  it("an installed copy carries everything its own suite needs", () => {
    const target = path.join(tmp(), "skill");
    run(["--path", target]);
    let out = "";
    try {
      out = execFileSync("node", [path.join(target, "tests", "run-tests.mjs")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      out = (e.stdout || "") + (e.stderr || "");
      throw new Error(`the installed copy cannot verify itself:\n${out.slice(-1200)}`);
    }
    includes(out, "passed", "an installed skill that cannot re-verify itself is a black box");
  });
});
