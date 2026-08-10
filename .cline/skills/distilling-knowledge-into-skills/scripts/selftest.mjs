#!/usr/bin/env node
// selftest.mjs — prove the gates by what they refuse.
//
// A validator tested only against good input measures nothing. Every case here
// is a defect that actually shipped in the previous project, or one the five
// design constraints exist to prevent, and each must be **rejected** with a
// message that names what is wrong.
//
// The positive cases matter too, in the other direction: an honest gap has to
// pass. A gate that rejects declared uncertainty teaches authors to fill
// fields with something plausible instead, which is the failure it was built
// to stop.
//
//   node selftest.mjs [--verbose]
//
// Exit 0 all passed, 2 otherwise.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateClaim, validateRule } from "./lib/schema.mjs";
import { checkChunkTiling, checkConversionFidelity } from "./lib/store.mjs";
import { writeJsonl, parseArgs } from "./lib/jsonl.mjs";
import { explainBadDigest, isRealDigest } from "./lib/evidence.mjs";
import { looksLikeWordList, findHedges, isSelfReference } from "./lib/prose.mjs";
import { allFixtures } from "./lib/fixtures.mjs";
import { extractPdf } from "./lib/pdf.mjs";

const args = parseArgs(process.argv.slice(2));
let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    if (args.verbose) process.stdout.write(`  pass  ${name}\n`);
  } else {
    failures.push(`${name}${detail ? " — " + detail : ""}`);
  }
}

/** A claim that is valid in every way, so each case varies exactly one thing. */
function goodClaim(over = {}) {
  return {
    id: "some-book/ch01/s01/c01",
    unit: "some-book/ch01/s01",
    type: "principle",
    statement: "Record the boundary of a rule where the source states it, not where it feels natural.",
    condition: "a rule has been formalized and its exceptions have not been sought",
    consequence: "the rule is applied outside the range the source supports",
    defines: ["boundary"],
    mentions: ["rule"],
    evidence: {
      source: "some-book",
      locator: "p.12",
      support: "direct",
      excerpt_hash: "a".repeat(64),
    },
    origin: "source",
    confidence: 0.9,
    prompt_version: "extract@abc1234",
    extracted_at: "2026-08-09T10:00:00+00:00",
    ...over,
  };
}

const rejects = (claim, needle) => {
  const errs = validateClaim(claim, "test", { profile: "strict" });
  return errs.some((e) => e.message.toLowerCase().includes(needle.toLowerCase()));
};

// ---------------------------------------------------------------------------
// The two defects that destroyed the previous claim store
// ---------------------------------------------------------------------------
check(
  "placeholder excerpt_hash is rejected",
  rejects(goodClaim({ evidence: { ...goodClaim().evidence, excerpt_hash: "md-derived-01" } }), "placeholder")
);
check(
  "a placeholder is explained, not just flagged",
  explainBadDigest("md-derived-01").includes("nothing was read")
);
check("a real digest passes", isRealDigest("sha256:" + "f".repeat(64)));
check(
  "condition 'always' on a rule-type claim is rejected as a platitude",
  rejects(goodClaim({ type: "rule", condition: "always" }), "platitude")
);

// ---------------------------------------------------------------------------
// The no-guessing policy
// ---------------------------------------------------------------------------
check(
  "a hedged consequence is rejected",
  rejects(goodClaim({ consequence: "this probably means the boundary was missed" }), "hedge")
);
check("hedge detection finds the marker", findHedges("it seems to hold").includes("seems to"));
check(
  "an empty condition is rejected",
  rejects(goodClaim({ condition: "   " }), "difference between a claim and a summary")
);
check(
  "origin=model cannot claim direct support",
  rejects(goodClaim({ origin: "model" }), "contradiction")
);
check(
  "a short statement is rejected as a label",
  rejects(goodClaim({ statement: "test early" }), "specificity floor")
);
check("a clean claim passes strict", validateClaim(goodClaim(), "test", { profile: "strict" }).length === 0);

// ---------------------------------------------------------------------------
// The R5 and R7 failures, which both looked filled
// ---------------------------------------------------------------------------
const because = "integration cost is paid once at the boundary while model clarity compounds";
check(
  "a cost that restates its because is rejected",
  validateRule(
    { id: "r/x", cluster: "c", name: "Split on the seam", when: "two teams own one entity",
      then: "split along the ownership seam", because, cost: because, derived_from: ["a/ch01/s01/c01"] },
    "test", { profile: "strict" }
  ).some((e) => e.message.includes("restates"))
);
check("self-reference detection is not fooled by punctuation", isSelfReference("A, b c!", "a b c"));
check(
  "a computed word list is rejected",
  looksLikeWordList("initially, lengths, side, specification versus classes, defined, invalid")
);
check(
  "an enumerating sentence is NOT rejected",
  !looksLikeWordList("The standard fault categories are input/output, logic, computation, interface, and data.")
);
check(
  "a truncated rule name is rejected",
  validateRule(
    { id: "r/x", cluster: "c", name: "T".repeat(109) + "e", when: "a condition holds",
      then: "do the thing", because, derived_from: ["a/ch01/s01/c01"] },
    "test", { profile: "strict" }
  ).some((e) => e.message.includes("mid-clause"))
);
check(
  "a boundary clause with no provenance is rejected",
  validateRule(
    { id: "r/x", cluster: "c", name: "Short name", when: "a condition holds", then: "do the thing",
      because, unless: [{ clause: "the teams are merging within the planning horizon" }],
      derived_from: ["a/ch01/s01/c01"] },
    "test", { profile: "strict" }
  ).some((e) => e.message.includes("'from'"))
);

// ---------------------------------------------------------------------------
// An honest gap must PASS. This is the direction that keeps the gate usable.
// ---------------------------------------------------------------------------
check(
  "a declared unknown cost passes",
  validateRule(
    { id: "r/x", cluster: "c", name: "Short name", when: "a condition holds", then: "do the thing",
      because, cost: { status: "unknown", gap: "the source states no price for this rule" },
      derived_from: ["a/ch01/s01/c01"] },
    "test", { profile: "strict" }
  ).length === 0
);
check(
  "an unknown with no gap is rejected",
  validateRule(
    { id: "r/x", cluster: "c", name: "Short name", when: "a condition holds", then: "do the thing",
      because, cost: { status: "unknown" }, derived_from: ["a/ch01/s01/c01"] },
    "test", { profile: "strict" }
  ).some((e) => e.message.includes("carries no 'gap'"))
);
check(
  "a rule deriving from nothing is rejected",
  validateRule(
    { id: "r/x", cluster: "c", name: "Short name", when: "a condition holds", then: "do the thing",
      because, derived_from: [] },
    "test", { profile: "strict" }
  ).some((e) => e.message.includes("resolves to nothing"))
);

// ---------------------------------------------------------------------------
// Ingestion and chunk-coverage gates, against a temporary store
// ---------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "distill-selftest-"));
const doc = path.join(tmp, "sources", "converted", "book");
fs.mkdirSync(doc, { recursive: true });

writeJsonl(path.join(doc, "pages.jsonl"), [
  { page: 1, kind: "text", char_count: 3000 },
  { page: 2, kind: "text", char_count: 3100 },
  { page: 3, kind: "text", char_count: 2900 },
  { page: 4, kind: "text", char_count: 3050 },
  { page: 5, kind: "text", char_count: 4 },
  { page: 6, kind: "image", char_count: 0 },
  { page: 7, char_count: 500 },
]);

const fidelity = checkConversionFidelity(tmp);
check(
  "a text page yielding almost nothing is flagged",
  fidelity.some((f) => f.kind === "conversion-suspect" && f.page === 5)
);
check(
  "an image page with neither OCR nor a gap is flagged",
  fidelity.some((f) => f.kind === "image-not-handled" && f.page === 6)
);
check(
  "a page with no declared kind is flagged",
  fidelity.some((f) => f.kind === "undeclared-page" && f.page === 7)
);

writeJsonl(path.join(doc, "chunks.jsonl"), [
  { id: "book/k0001", char_start: 0, char_end: 5000 },
  { id: "book/k0002", char_start: 5800, char_end: 12554 },
]);
const tiling = checkChunkTiling(tmp);
check(
  "a region belonging to no chunk is flagged",
  tiling.some((f) => f.kind === "gap" && f.detail.includes("800"))
);

writeJsonl(path.join(doc, "chunks.jsonl"), [
  { id: "book/k0001", char_start: 0, char_end: 6000 },
  { id: "book/k0002", char_start: 5800, char_end: 12554 },
]);
check(
  "undeclared overlap is flagged",
  checkChunkTiling(tmp).some((f) => f.kind === "undeclared-overlap")
);

writeJsonl(path.join(doc, "chunks.jsonl"), [
  { id: "book/k0001", char_start: 0, char_end: 6000 },
  { id: "book/k0002", char_start: 5800, char_end: 12554, overlap_declared: true },
]);
check("declared overlap passes", checkChunkTiling(tmp).length === 0);

writeJsonl(path.join(doc, "pages.jsonl"), [
  { page: 1, kind: "text", char_count: 3000 },
  { page: 2, kind: null, char_count: 0, extraction_error: "Type0 font with no ToUnicode map" },
  { page: 3, kind: "text", char_count: 3000, cross_check: { extractor: "other@1", similarity: 0.4 } },
]);
const ex = checkConversionFidelity(tmp);
check(
  "an undeclared extractor refusal is flagged",
  ex.some((f) => f.kind === "extraction-refused" && f.page === 2)
);
check(
  "two extractors disagreeing on a page is flagged",
  ex.some((f) => f.kind === "extraction-disagreement" && f.page === 3)
);

fs.rmSync(tmp, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// The built-in extractor, against the conformance fixtures
// ---------------------------------------------------------------------------
for (const fx of allFixtures()) {
  let pages = null;
  let threw = null;
  try {
    pages = extractPdf(fx.pdf).pages;
  } catch (e) {
    threw = e.message;
  }
  if (fx.expectRefusal) {
    check(`builtin refuses ${fx.name}`, Boolean(threw) && fx.expectRefusal.test(threw), threw || "did not refuse");
  } else if (fx.expectPageRefusal) {
    check(
      `builtin refuses per page on ${fx.name}`,
      !threw && pages.every((p, i) => !fx.expectPageRefusal[i] || (p.text === null && fx.expectPageRefusal[i].test(p.error || "")))
    );
  } else {
    const norm = (t) => String(t ?? "").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
    check(
      `builtin extracts ${fx.name} exactly`,
      !threw && pages.length === fx.expect.length && pages.every((p, i) => norm(p.text) === norm(fx.expect[i])),
      threw || "text did not match"
    );
  }
}

// ---------------------------------------------------------------------------
if (failures.length) {
  process.stderr.write(`\n${failures.length} FAILED of ${passed + failures.length}\n\n`);
  for (const f of failures) process.stderr.write(`  FAIL  ${f}\n`);
  process.exit(2);
}
process.stdout.write(`selftest: ${passed}/${passed} passed\n`);
