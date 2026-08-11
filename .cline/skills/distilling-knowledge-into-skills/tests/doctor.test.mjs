// doctor.test.mjs — every way a skill is discovered and silently not loaded.
//
// This exists because the question "why does Cline not see my skill" had no
// mechanical answer, and a skill with unparseable frontmatter therefore sat
// installed and inert until a person noticed by hand. Each case below produces
// the same symptom from outside — the skill is simply absent from the Skills
// tab — which is exactly why they have to be enumerated.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it, assert, equal, includes } from "./harness.mjs";
import { diagnose, inspect, discoveryRoots } from "../scripts/doctor.mjs";
import { SKILL_CONTRACT } from "../scripts/skill-lint.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cleanup = [];
process.on("exit", () => cleanup.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const GOOD_FM = "name: NAME\ndescription: Do one specific thing with named artifacts, at enough length to trigger.\n";

/** A workspace with a project skill in it, written exactly as given. */
function workspace(name, { frontmatter = GOOD_FM, body = "# Body\n\ntext\n", entry = "SKILL.md", raw = null } = {}) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "distill-doctor-"));
  cleanup.push(ws);
  const dir = path.join(ws, ".cline", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  const content = raw !== null ? raw : `---\n${frontmatter.replace("NAME", name)}---\n\n${body}`;
  fs.writeFileSync(path.join(dir, entry), content);
  return { ws, dir };
}

const errorsOf = (dir) => inspect(dir).findings.filter((f) => f.level === "error").map((f) => f.message).join("\n");
const warnsOf = (dir) => inspect(dir).findings.filter((f) => f.level === "warn").map((f) => f.message).join("\n");

describe("doctor · the locations it looks in are the documented ones", () => {
  it("checks every documented root and nothing invented", () => {
    const rels = discoveryRoots("/ws").map((r) => r.rel);
    for (const r of SKILL_CONTRACT.projectRoots) assert(rels.includes(r), `${r} is not checked`);
    for (const r of SKILL_CONTRACT.globalRoots) assert(rels.includes(`~/${r}`), `~/${r} is not checked`);
    equal(rels.length, SKILL_CONTRACT.projectRoots.length + SKILL_CONTRACT.globalRoots.length);
  });

  it("reads global before project, which is the order that decides who wins", () => {
    const scopes = discoveryRoots("/ws").map((r) => r.scope);
    equal(scopes[0], "global", "global skills take precedence — the reverse of rules");
  });

  it("reports an absent root as absent rather than as a failure", () => {
    const { ws } = workspace("present-skill");
    const { rootReports } = diagnose(ws);
    const claude = rootReports.find((r) => r.rel.endsWith(path.join(".claude", "skills")));
    equal(claude.state, "absent");
  });
});

describe("doctor · the things that stop a skill loading", () => {
  it("catches frontmatter that no YAML parser can read", () => {
    // The exact defect that shipped: a colon followed by a space in an
    // unquoted value opens a nested mapping.
    const { dir } = workspace("yaml-broken", {
      frontmatter: "name: yaml-broken\ndescription: Extract knowledge into a skill: ingesting and chunking a book.\n",
    });
    includes(errorsOf(dir), "': '");
  });

  it("catches a UTF-8 BOM in front of the delimiter", () => {
    const { dir } = workspace("bom-skill", {
      raw: "﻿---\nname: bom-skill\ndescription: A long enough and specific description of the work.\n---\n\n# Body\n",
    });
    includes(errorsOf(dir), "BOM");
  });

  it("catches a case-wrong SKILL.md, which reads correctly to a human", () => {
    const { dir } = workspace("case-skill", { entry: "Skill.md" });
    includes(errorsOf(dir), "case-sensitive");
  });

  it("catches a missing SKILL.md", () => {
    const { dir } = workspace("no-entry", { entry: "README.md" });
    includes(errorsOf(dir), "no SKILL.md");
  });

  it("catches a name that does not match the directory", () => {
    const { dir } = workspace("dir-name", { frontmatter: "name: other-name\ndescription: A long enough and specific description of the work.\n" });
    includes(errorsOf(dir), "must match exactly");
  });

  it("catches a missing description, which is what triggering matches on", () => {
    const { dir } = workspace("no-desc", { frontmatter: "name: no-desc\n" });
    includes(errorsOf(dir), "no 'description'");
  });

  it("catches an over-long description", () => {
    const { dir } = workspace("long-desc", {
      frontmatter: `name: long-desc\ndescription: ${"x".repeat(SKILL_CONTRACT.descriptionMax + 5)}\n`,
    });
    includes(errorsOf(dir), "over the documented");
  });

  it("catches frontmatter that is not delimited at all", () => {
    const { dir } = workspace("bare", { raw: "# Just a document\n\ntext\n" });
    includes(errorsOf(dir), "no --- delimited frontmatter");
  });

  it("notes CRLF without calling it fatal, because Cline tolerates it", () => {
    const { dir } = workspace("crlf-skill", {
      raw: "---\r\nname: crlf-skill\r\ndescription: A long enough and specific description of the work.\r\n---\r\n\r\n# Body\r\n",
    });
    equal(errorsOf(dir), "", "CRLF must not be reported as a load failure");
    includes(warnsOf(dir), "CRLF");
  });

  it("notes a dead link without calling it fatal", () => {
    const { dir } = workspace("dead-link", { body: "See [setup](docs/setup.md).\n" });
    equal(errorsOf(dir), "");
    includes(warnsOf(dir), "docs/setup.md");
  });

  it("passes a skill with nothing wrong with it", () => {
    const { dir } = workspace("healthy-skill");
    equal(errorsOf(dir), "");
    equal(warnsOf(dir), "");
  });

  it("passes this skill, the one being shipped", () => {
    const { findings } = inspect(root);
    equal(findings.filter((f) => f.level === "error"), []);
  });
});

describe("doctor · shadowing, which looks like nothing at all", () => {
  it("names the copy that wins when a skill exists twice", () => {
    // Simulated by pointing both a project root and a second project root at
    // the same name; the real case is global over project, which cannot be
    // created in a test without writing to the user's home directory.
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "distill-doctor-"));
    cleanup.push(ws);
    for (const rel of [path.join(".cline", "skills"), path.join(".clinerules", "skills")]) {
      const dir = path.join(ws, rel, "twinned");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), `---\n${GOOD_FM.replace("NAME", "twinned")}---\n\n# Body\n`);
    }
    const { shadowed } = diagnose(ws);
    equal(shadowed.length, 1);
    equal(shadowed[0].name, "twinned");
    equal(shadowed[0].copies.length, 2);
  });

  it("says nothing when each skill exists once", () => {
    const { ws } = workspace("only-once");
    equal(diagnose(ws).shadowed, []);
  });
});

describe("doctor · it reports, and changes nothing", () => {
  const run = (ws) => {
    try {
      return { code: 0, out: execFileSync("node", [path.join(root, "scripts", "doctor.mjs"), "--root", ws], { encoding: "utf8" }) };
    } catch (e) {
      return { code: e.status, out: (e.stdout || "") + (e.stderr || "") };
    }
  };

  it("exits 2 and names the file when a skill cannot load", () => {
    const { ws } = workspace("broken-yaml", {
      frontmatter: "name: broken-yaml\ndescription: Do a thing: and break the parse for everyone.\n",
    });
    const r = run(ws);
    equal(r.code, 2);
    includes(r.out, "WILL NOT LOAD");
    includes(r.out, "broken-yaml");
  });

  it("exits 1 and says where to install when nothing is found anywhere", () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "distill-doctor-"));
    cleanup.push(ws);
    const r = run(ws);
    equal(r.code, 1);
    includes(r.out, "No skill directory in any documented location");
    includes(r.out, "install.mjs --project");
  });

  it("writes nothing, whatever it finds", () => {
    const { ws } = workspace("untouched");
    const before = JSON.stringify(fs.readdirSync(path.join(ws, ".cline", "skills", "untouched")));
    run(ws);
    equal(JSON.stringify(fs.readdirSync(path.join(ws, ".cline", "skills", "untouched"))), before);
  });

  it("tells the reader what to do next, not just that something is wrong", () => {
    const { ws } = workspace("advice-case");
    includes(run(ws).out, "read at startup");
  });
});
