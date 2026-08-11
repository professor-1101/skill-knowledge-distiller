#!/usr/bin/env node
// confidence.mjs — recompute every confidence score from the rubric.
//
// Reproducible by construction: run it again after new corroboration arrives
// and the numbers move for a reason anyone can check. A score somebody typed
// cannot do that.
//
//   node confidence.mjs [--root .] [--dry-run]
//
// Exit 0 when nothing changed, 1 when scores were corrected.

import path from "node:path";
import fs from "node:fs";
import { readJsonl, writeJsonl, collectClaims, parseArgs } from "./lib/jsonl.mjs";
import { expectedForClaim, expectedForRule, RUBRIC_VERSION, TOLERANCE } from "./lib/confidence.mjs";

function main() {
  const args = parseArgs(process.argv.slice(2), { root: "." });
  const changes = [];

  const claimsDir = path.join(args.root, "claims");
  const files = [];
  (function walk(d) {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".jsonl")) files.push(full);
    }
  })(claimsDir);

  for (const f of files) {
    const rows = readJsonl(f);
    let dirty = false;
    const next = rows.map((c) => {
      const want = expectedForClaim(c);
      if (Math.abs(Number(c.confidence) - want) > TOLERANCE) {
        changes.push({ id: c.id, from: c.confidence, to: want });
        dirty = true;
        return { ...c, confidence: want, confidence_rubric_version: RUBRIC_VERSION };
      }
      return c.confidence_rubric_version ? c : { ...c, confidence_rubric_version: RUBRIC_VERSION };
    });
    if (!args["dry-run"]) writeJsonl(f, next);
    void dirty;
  }

  const rulesPath = path.join(args.root, "rules.jsonl");
  const rules = readJsonl(rulesPath);
  if (rules.length) {
    const byId = new Map(collectClaims(args.root).map((c) => [c.id, c]));
    const next = rules.map((r) => {
      const want = expectedForRule(r, byId);
      if (want === null) return r;
      if (Math.abs(Number(r.confidence) - want) > TOLERANCE) {
        changes.push({ id: r.id, from: r.confidence, to: want });
        return { ...r, confidence: want, confidence_rubric_version: RUBRIC_VERSION };
      }
      return r;
    });
    if (!args["dry-run"]) writeJsonl(rulesPath, next);
  }

  process.stdout.write(`rubric            ${RUBRIC_VERSION}\n`);
  if (!changes.length) {
    process.stdout.write("confidence        already matches the rubric\n");
    return;
  }
  process.stdout.write(`corrected         ${changes.length}\n`);
  for (const c of changes.slice(0, 20)) {
    process.stdout.write(`  ${c.id}  ${c.from} -> ${c.to}\n`);
  }
  if (changes.length > 20) process.stdout.write(`  ... ${changes.length - 20} more\n`);
  if (args["dry-run"]) process.stdout.write("\ndry run — nothing written\n");
  process.exit(1);
}

main();
