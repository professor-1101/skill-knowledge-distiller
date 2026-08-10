#!/usr/bin/env node
// sync-corpus.mjs — recompute unit status from the artifacts, never by hand.
//
// The previous project's store drifted badly: units were marked `saturated`
// while holding zero claims, because status was written by judgement and never
// reconciled against what the store actually contained. That is its
// best-documented pitfall — and this pipeline reproduced it, stating the cure
// in its own documentation while `certify.mjs` counted a field nobody derived.
//
// Status here is computed, so the failure cannot recur:
//
//   pending      no claims
//   extracted    claims exist, fewer than two probe rounds logged
//   saturated    at least two probes, and the last two each yielded new claims
//                below the saturation ratio
//   stale        claims exist but were produced under a different prompt hash
//                than the current one
//
// `stale` is the invalidation-by-hash rule made visible: editing a prompt
// invalidates the claims produced under the old one automatically rather than
// by memory, and those units return to the work queue.
//
//   node sync-corpus.mjs [--ratio 0.05] [--root .] [--dry-run]
//
// Exit 0 clean, 1 when something was corrected.

import fs from "node:fs";
import path from "node:path";
import { readJsonl, writeJsonl, collectClaims, parseArgs } from "./lib/jsonl.mjs";
import { sha256 } from "./lib/evidence.mjs";
import { loadConfig } from "./lib/store.mjs";

function currentPromptHashes(root) {
  const dir = path.join(root, "prompts");
  const alt = path.join(root, "templates", "prompts");
  const base = fs.existsSync(dir) ? dir : fs.existsSync(alt) ? alt : null;
  const out = new Map();
  if (!base) return out;
  for (const f of fs.readdirSync(base).sort()) {
    if (!f.endsWith(".md")) continue;
    out.set(f.replace(/\.md$/, ""), sha256(fs.readFileSync(path.join(base, f))));
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2), { root: "." });
  const config = loadConfig(args.root);
  const ratio = Number(args.ratio ?? (config.saturation || {}).ratio ?? 0.05);

  const corpusPath = path.join(args.root, "corpus.jsonl");
  const corpus = readJsonl(corpusPath);
  if (!corpus.length) {
    process.stdout.write("corpus.jsonl is empty — run enumerate.mjs first\n");
    return;
  }

  const claims = collectClaims(args.root);
  const probes = readJsonl(path.join(args.root, "probes.jsonl"));
  const prompts = currentPromptHashes(args.root);
  const extractHash = prompts.get("extract");

  const byUnit = new Map();
  for (const c of claims) {
    if (!byUnit.has(c.unit)) byUnit.set(c.unit, []);
    byUnit.get(c.unit).push(c);
  }
  const probesByUnit = new Map();
  for (const p of probes) {
    if (!probesByUnit.has(p.unit)) probesByUnit.set(p.unit, []);
    probesByUnit.get(p.unit).push(p);
  }

  const changes = [];
  const updated = corpus.map((row) => {
    if (!row.unit) return row;
    const unitClaims = byUnit.get(row.unit) || [];
    const unitProbes = (probesByUnit.get(row.unit) || [])
      .slice()
      .sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));

    let status;
    let why;
    if (!unitClaims.length) {
      status = "pending";
      why = "no claims";
    } else if (extractHash && unitClaims.some((c) => hashOf(c.prompt_version) && hashOf(c.prompt_version) !== extractHash.slice(0, hashLen(c.prompt_version)))) {
      status = "stale";
      why = "claims were produced under a different extract prompt";
    } else if (unitProbes.length < 2) {
      status = "extracted";
      why = `${unitProbes.length} probe round(s), fewer than the two saturation needs`;
    } else {
      // Two consecutive probes each yielding new claims below the floor is the
      // stopping rule. "Iterate until complete" has no exit and terminates
      // arbitrarily, which is the same defect whether the loop runs forever or
      // stops early.
      const lastTwo = unitProbes.slice(-2);
      const floor = Math.max(1, Math.ceil(unitClaims.length * ratio));
      const belowFloor = lastTwo.every((p) => Number(p.new_claims ?? 0) < floor);
      status = belowFloor ? "saturated" : "extracted";
      why = belowFloor
        ? `last two probes yielded ${lastTwo.map((p) => p.new_claims ?? 0).join(" and ")} new claims, below the floor of ${floor}`
        : `last two probes yielded ${lastTwo.map((p) => p.new_claims ?? 0).join(" and ")} new claims, at or above the floor of ${floor}`;
    }

    if ((row.status || "pending") !== status) {
      changes.push({ unit: row.unit, from: row.status || "pending", to: status, why });
    }
    return { ...row, status, claims: unitClaims.length, probes: unitProbes.length };
  });

  const counts = new Map();
  for (const r of updated) counts.set(r.status, (counts.get(r.status) || 0) + 1);
  for (const [k, v] of [...counts.entries()].sort()) process.stdout.write(`${k.padEnd(18)}${v}\n`);

  if (!changes.length) {
    process.stdout.write("\nstatus already matches the artifacts\n");
    return;
  }

  process.stdout.write(`\n${changes.length} unit(s) corrected:\n`);
  for (const c of changes.slice(0, 40)) {
    process.stdout.write(`  ${c.unit}  ${c.from} -> ${c.to}   (${c.why})\n`);
  }
  if (changes.length > 40) process.stdout.write(`  ... ${changes.length - 40} more\n`);

  if (args["dry-run"]) {
    process.stdout.write("\ndry run — nothing written\n");
    process.exit(1);
  }
  writeJsonl(corpusPath, updated);
  process.stdout.write(`\nwritten           ${corpusPath}\n`);
  process.exit(1);
}

/** `<stage>@<hash>` — the hash half, or null if the field is malformed. */
function hashOf(promptVersion) {
  const m = /^[a-z-]+@([0-9a-f]{7,64})$/.exec(String(promptVersion || ""));
  return m ? m[1] : null;
}
function hashLen(promptVersion) {
  const h = hashOf(promptVersion);
  return h ? h.length : 0;
}

main();
