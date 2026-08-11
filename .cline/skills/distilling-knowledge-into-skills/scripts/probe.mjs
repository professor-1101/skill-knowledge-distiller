#!/usr/bin/env node
// probe.mjs — the half of R11 that was missing.
//
// `probes.jsonl` was read by the certificate and written by nothing, so the
// saturation rule the Skill states had no data to stand on. A probe is only
// evidence if it was recorded, including — especially — the ones that found
// nothing: a zero-yield probe is what proves saturation was reached. It is the
// measurement, not a wasted run.
//
//   node probe.mjs --record --unit U --type implicit --new-claims 3
//   node probe.mjs --status --unit U
//
// Exit 0 always. This records; sync-corpus.mjs decides what it means.

import path from "node:path";
import { readJsonl, appendJsonl, collectClaims, nowIso, parseArgs } from "./lib/jsonl.mjs";

// Rotating the angle is the point: extraction under-catches what a source
// implies rather than states, and a second read asking the same question finds
// the same things.
const TYPES = ["implicit", "conditions", "contrarian", "cross-reference"];

function main() {
  const args = parseArgs(process.argv.slice(2), { root: "." });
  const file = path.join(args.root, "probes.jsonl");

  if (args.status) {
    const rows = readJsonl(file).filter((r) => !args.unit || r.unit === args.unit);
    if (!rows.length) {
      process.stdout.write("no probes logged\n");
      return;
    }
    const byUnit = new Map();
    for (const r of rows) {
      if (!byUnit.has(r.unit)) byUnit.set(r.unit, []);
      byUnit.get(r.unit).push(r);
    }
    for (const [unit, list] of [...byUnit.entries()].sort()) {
      const seq = list.map((p) => `${p.type}:${p.new_claims ?? 0}`).join(" ");
      process.stdout.write(`${unit}\n  ${list.length} round(s)  ${seq}\n`);
    }
    return;
  }

  if (!args.record) {
    process.stderr.write(
      "usage: probe.mjs --record --unit U --type " + TYPES.join("|") + " --new-claims N\n" +
        "       probe.mjs --status [--unit U]\n"
    );
    process.exit(2);
  }

  for (const req of ["unit", "type"]) {
    if (!args[req]) {
      process.stderr.write(`BLOCKED: --record needs --${req}\n`);
      process.exit(2);
    }
  }
  if (!TYPES.includes(String(args.type))) {
    process.stderr.write(`BLOCKED: unknown probe type '${args.type}' — use one of ${TYPES.join(", ")}\n`);
    process.exit(2);
  }
  if (args["new-claims"] === undefined) {
    process.stderr.write(
      "BLOCKED: --new-claims is required, including when it is 0. An unlogged\n" +
        "zero-yield probe cannot support the stopping claim that depends on it.\n"
    );
    process.exit(2);
  }

  const previous = readJsonl(file).filter((r) => r.unit === args.unit);
  const last = previous[previous.length - 1];
  if (last && last.type === args.type) {
    process.stderr.write(
      `BLOCKED: the previous probe of '${args.unit}' was also '${args.type}'. Rotate the\n` +
        `angle: the same question asked twice finds the same things, so a repeat\n` +
        `round measures nothing and would count toward saturation anyway.\n`
    );
    process.exit(2);
  }

  const total = collectClaims(args.root).filter((c) => c.unit === args.unit).length;
  appendJsonl(file, [{
    unit: String(args.unit),
    type: String(args.type),
    round: previous.length + 1,
    new_claims: Number(args["new-claims"]),
    total_claims: total,
    at: nowIso(),
  }]);
  process.stdout.write(`recorded          ${args.unit} round ${previous.length + 1} (${args.type}), ${args["new-claims"]} new\n`);
}

main();
