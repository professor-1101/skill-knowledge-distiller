// rgate.test.mjs — the Skill and the implementation cannot drift apart.
//
// The review that produced this suite found four defects of one shape: the
// Skill stated a rule and no code implemented it. `corpus.jsonl` was read by
// seven scripts and written by none. `certify.mjs` counted a status field
// nobody derived. `probes.jsonl` was read and never written. The confidence
// rubric was documented and absent. Every one of those passed every check that
// existed, because nothing checked that a rule had an enforcer.
//
// This does. Each rule in SKILL.md must name the script that enforces it, or
// be explicitly declared advisory with a reason. A new rule with neither
// fails the build, which is the only way this class of defect stops recurring.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, assert, equal } from "./harness.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const skill = fs.readFileSync(path.join(root, "SKILL.md"), "utf8");

/**
 * Rule → what enforces it.
 *
 * A script name means a mechanical gate exists and is expected to mention the
 * rule's subject. `advisory` means the rule is a judgement no script can make,
 * and the string says why — an unexplained advisory is how a rule quietly
 * stops being enforced.
 */
const ENFORCEMENT = {
  R1: "scripts/validate-claim.mjs",
  R2: "advisory: whether a step needs reasoning is a design judgement, not a state a script can read",
  R3: "scripts/ingest.mjs",
  R3a: "scripts/ingest.mjs",
  R3b: "scripts/lib/epub.mjs",
  R4: "scripts/chunk.mjs",
  R5: "scripts/enumerate.mjs",
  R6: "advisory: claim yield per unit is only knowable after extraction, and the grain is a judgement about the book",
  R7: "scripts/lib/schema.mjs",
  R8: "scripts/lib/evidence.mjs",
  R9: "scripts/probe.mjs",
  R10: "scripts/sync-corpus.mjs",
  R11: "scripts/probe.mjs",
  R12: "advisory: source access is a property of how a stage is run, which the store cannot observe",
  R13: "scripts/index.mjs",
  R14: "advisory: whether two conditions differ is the judgement R2 consolidation exists to make",
  R15: "scripts/check-store.mjs",
  R16: "advisory: elevation is the central judgement of refinement; a script can only reject platitudes after the fact",
  R17: "scripts/context.mjs",
  R18: "scripts/lib/schema.mjs",
  R19: "scripts/certify.mjs",
  R20: "advisory: preserving a contested question is an editorial act; the store can only count what was recorded",
  R21: "scripts/lib/prose.mjs",
  R22: "scripts/check-store.mjs",
  R23: "scripts/confidence.mjs",
  R24: "scripts/lib/schema.mjs",
  R25: "scripts/lib/store.mjs",
  R26: "scripts/checkpoint.mjs",
  R27: "scripts/checkpoint.mjs",
  R28: "scripts/graph.mjs",
  R29: "advisory: consolidation scope is an ordering decision about when to run a stage",
  R30: "scripts/certify.mjs",
  R31: "advisory: routing a defect to its origin stage is a judgement about cause",
  R32: "advisory: clustering by decision rather than document is the compile stage's central judgement",
  R33: "scripts/sync-corpus.mjs",
  R34: "scripts/enumerate.mjs",
  R35: "scripts/check-store.mjs",
};

const ruleIds = [...skill.matchAll(/^### (R\d+[a-z]?) — /gm)].map((m) => m[1]);

describe("rgate · every rule is accounted for", () => {
  it("SKILL.md actually declares rules", () => {
    assert(ruleIds.length >= 20, `found only ${ruleIds.length} rules — the parse is probably wrong`);
  });

  it("no rule is declared twice", () => {
    equal([...new Set(ruleIds)].length, ruleIds.length, "duplicate rule ids");
  });

  it("every rule names an enforcer or an explained advisory", () => {
    const unmapped = ruleIds.filter((id) => !ENFORCEMENT[id]);
    equal(
      unmapped,
      [],
      "these rules have no entry in ENFORCEMENT. Add the script that gates them, " +
        "or declare them advisory with the reason no script can"
    );
  });

  it("the map has no entries for rules that no longer exist", () => {
    const stale = Object.keys(ENFORCEMENT).filter((id) => !ruleIds.includes(id));
    equal(stale, [], "these entries name rules SKILL.md does not declare");
  });

  it("every named enforcer exists on disk", () => {
    const missing = Object.entries(ENFORCEMENT)
      .filter(([, v]) => !v.startsWith("advisory:"))
      .map(([id, v]) => [id, v])
      .filter(([, v]) => !fs.existsSync(path.join(root, v)))
      .map(([id, v]) => `${id} -> ${v}`);
    equal(missing, [], "a rule points at a script that is not there");
  });

  it("every advisory says why no script can enforce it", () => {
    const bare = Object.entries(ENFORCEMENT)
      .filter(([, v]) => v.startsWith("advisory:"))
      .filter(([, v]) => v.replace("advisory:", "").trim().length < 30)
      .map(([id]) => id);
    equal(bare, [], "an unexplained advisory is how a rule quietly stops being enforced");
  });

  it("mechanical enforcement outnumbers advisory, or the Skill is mostly suggestion", () => {
    const advisory = Object.values(ENFORCEMENT).filter((v) => v.startsWith("advisory:")).length;
    const mechanical = Object.values(ENFORCEMENT).length - advisory;
    assert(
      mechanical > advisory,
      `${mechanical} mechanical against ${advisory} advisory — "a rule a script can check is ` +
        `never left to a prompt" stops being true somewhere around here`
    );
  });
});

describe("rgate · the Skill matches the tree", () => {
  it("every script the Skill tells you to run exists", () => {
    const invoked = [...skill.matchAll(/node (scripts\/[\w.-]+\.mjs|tests\/[\w.-]+\.mjs)/g)].map((m) => m[1]);
    const missing = [...new Set(invoked)].filter((f) => !fs.existsSync(path.join(root, f)));
    equal(missing, [], "the Skill names a script that is not in the tree");
  });

  it("every docs/ link in the Skill resolves", () => {
    const links = [...skill.matchAll(/\]\((docs\/[\w./-]+)\)/g)].map((m) => m[1]);
    const missing = [...new Set(links)].filter((f) => !fs.existsSync(path.join(root, f)));
    equal(missing, [], "a reference link points at nothing");
  });

  it("no script in the tree is unreachable from the Skill or another script", () => {
    const scripts = fs.readdirSync(path.join(root, "scripts")).filter((f) => f.endsWith(".mjs"));
    const corpus =
      skill +
      scripts.map((f) => fs.readFileSync(path.join(root, "scripts", f), "utf8")).join("\n") +
      fs.readdirSync(path.join(root, "docs")).map((f) => fs.readFileSync(path.join(root, "docs", f), "utf8")).join("\n");
    const orphans = scripts.filter((f) => corpus.split(f).length < 2);
    equal(orphans, [], "a script nobody references is a script nobody runs");
  });

  it("the Skill no longer mentions PDF as a supported input", () => {
    const claimsPdfSupport = /\bPDF\b(?![^\n]*\b(not supported|no fallback|only supported|instead of|rather than)\b)/i.test(
      skill.replace(/^description:.*$/m, "")
    );
    assert(!claimsPdfSupport, "EPUB is the only supported format; the Skill must not imply otherwise");
  });
});
