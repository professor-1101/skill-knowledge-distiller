// skill-lint.test.mjs — the compiled skill has to load, and so does this one.
//
// R31 says a compiled package must be discoverable and within budget. Until
// now `docs/validation-table.md` named a `validate-skill.mjs` that did not
// exist — the exact defect class the R-gate test was written to catch, sitting
// one directory away from it. This is the missing implementation and its
// negative cases.
//
// Every failing case below is a real way a skill silently does not load:
// Cline discovers the directory, reads the frontmatter, and either never
// triggers or never resolves what the body points at.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it, assert, equal, includes } from "./harness.mjs";
import { lintSkill, estimateTokens, splitFrontmatter, SKILL_CONTRACT } from "../scripts/skill-lint.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cleanup = [];
process.on("exit", () => cleanup.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

/** A skill directory whose name is under our control, since name must match it. */
function skill(name, { frontmatter, body = "# Body\n\nSome instructions.\n", files = {} } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "distill-skill-"));
  cleanup.push(base);
  const dir = path.join(base, ".cline", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  const fm =
    frontmatter === undefined
      ? `name: ${name}\ndescription: ${"Do a specific thing with named artifacts. ".repeat(3)}\n`
      : frontmatter;
  fs.writeFileSync(path.join(dir, "SKILL.md"), fm === null ? body : `---\n${fm}---\n\n${body}`);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

describe("skill-lint · this skill conforms to the documented contract", () => {
  const { errors, measured } = lintSkill(root);

  it("has no contract violations", () => {
    equal(errors, []);
  });

  it("names itself exactly what its directory is called", () => {
    equal(measured.name, path.basename(root));
    equal(measured.name, "distilling-knowledge-into-skills");
  });

  it("stays inside the documented description limit", () => {
    assert(measured.descriptionChars > 0);
    assert(
      measured.descriptionChars <= SKILL_CONTRACT.descriptionMax,
      `${measured.descriptionChars} chars exceeds ${SKILL_CONTRACT.descriptionMax}`
    );
  });

  it("stays inside the documented body budget", () => {
    assert(
      measured.bodyTokensApprox <= SKILL_CONTRACT.bodyTokenMax,
      `~${measured.bodyTokensApprox} tokens exceeds ${SKILL_CONTRACT.bodyTokenMax}`
    );
  });

  it("exits 0 from the command line, so a build can gate on it", () => {
    const out = execFileSync("node", [path.join(root, "scripts", "skill-lint.mjs")], { encoding: "utf8" });
    includes(out, "Conforms to the documented skill contract");
  });
});

describe("skill-lint · what stops a skill from loading", () => {
  it("rejects a name that does not match the directory", () => {
    const dir = skill("real-name", { frontmatter: "name: other-name\ndescription: A sufficiently long and specific description of the work.\n" });
    includes(lintSkill(dir).errors.join("\n"), "requires an exact match");
  });

  it("rejects a name that is not kebab-case", () => {
    const dir = skill("Bad_Name", { frontmatter: "name: Bad_Name\ndescription: A sufficiently long and specific description of the work.\n" });
    includes(lintSkill(dir).errors.join("\n"), "not kebab-case");
  });

  it("rejects a missing description", () => {
    const dir = skill("no-description", { frontmatter: "name: no-description\n" });
    includes(lintSkill(dir).errors.join("\n"), "missing 'description'");
  });

  it("rejects a description over the documented 1024 characters", () => {
    const long = "x".repeat(SKILL_CONTRACT.descriptionMax + 1);
    const dir = skill("too-wordy", { frontmatter: `name: too-wordy\ndescription: ${long}\n` });
    includes(lintSkill(dir).errors.join("\n"), `over the documented ${SKILL_CONTRACT.descriptionMax}`);
  });

  it("rejects a body over the token budget", () => {
    const dir = skill("too-big", { body: "word ".repeat(SKILL_CONTRACT.bodyTokenMax) });
    includes(lintSkill(dir).errors.join("\n"), "over the documented 5000");
  });

  it("rejects a link to a bundled file that is not there", () => {
    const dir = skill("dead-link", { body: "See [setup](docs/setup.md).\n" });
    includes(lintSkill(dir).errors.join("\n"), "docs/setup.md");
  });

  it("accepts the same link once the file exists", () => {
    const dir = skill("live-link", { body: "See [setup](docs/setup.md).\n", files: { "docs/setup.md": "ok\n" } });
    equal(lintSkill(dir).errors, []);
  });

  it("rejects a SKILL.md with no frontmatter at all", () => {
    const dir = skill("bare", { frontmatter: null, body: "# Just a document\n" });
    includes(lintSkill(dir).errors.join("\n"), "no YAML frontmatter");
  });

  it("rejects a directory with no SKILL.md", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "distill-skill-"));
    cleanup.push(base);
    includes(lintSkill(base).errors.join("\n"), "no SKILL.md");
  });

  it("warns about frontmatter fields Cline does not read", () => {
    const dir = skill("extra-fields", {
      frontmatter: "name: extra-fields\ndescription: A sufficiently long and specific description of the work.\nversion: 2\n",
    });
    const { errors, warnings } = lintSkill(dir);
    equal(errors, [], "an inert field is not a violation");
    includes(warnings.join("\n"), "version");
  });

  it("warns about a description the reference itself calls too vague", () => {
    const dir = skill("vague", { frontmatter: "name: vague\ndescription: Helps with AWS stuff and other things you might need done here.\n" });
    includes(lintSkill(dir).warnings.join("\n"), "too vague to trigger");
  });

  it("notes a skill sitting outside every discovery root", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "distill-skill-"));
    cleanup.push(base);
    const dir = path.join(base, "somewhere", "my-skill");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"),
      "---\nname: my-skill\ndescription: A sufficiently long and specific description of the work.\n---\n\n# Body\n");
    includes(lintSkill(dir).notes.join("\n"), "discovery roots");
  });
});

describe("skill-lint · the measurements themselves", () => {
  it("estimates tokens on the high side, never the low", () => {
    // Underestimating is the dangerous direction: it reports a skill inside a
    // budget it has already left.
    assert(estimateTokens("a".repeat(4000)) >= 1000);
    assert(estimateTokens("word ".repeat(1000)) >= 1300, "dense short words tokenize worse than chars/4 suggests");
  });

  it("splits frontmatter without eating the body", () => {
    const { frontmatter, body } = splitFrontmatter("---\nname: x\n---\n\n# Title\n\ntext\n");
    includes(frontmatter, "name: x");
    includes(body, "# Title");
    assert(!body.includes("name: x"), "frontmatter must not be counted against the body budget");
  });

  it("measures the body only, so frontmatter never eats the budget", () => {
    const dir = skill("budget", { frontmatter: `name: budget\ndescription: ${"y".repeat(1000)}\n`, body: "short\n" });
    const { measured, errors } = lintSkill(dir);
    equal(errors, []);
    assert(measured.bodyTokensApprox < 20, `body measured at ${measured.bodyTokensApprox}`);
  });
});
