#!/usr/bin/env node
// check-store.mjs — every gate in one place, in one command.
//
// This is the single entry point the three enforcement tiers share: the skill
// body tells the model to run it, the git pre-commit hook runs it, and a Cline
// hook runs it where the surface has one. There is one implementation of each
// check so the three can never disagree about what the rules are — a policy
// enforced differently in three places is three policies.
//
//   node check-store.mjs [--root .] [--profile strict|compat] [--quiet]
//   node check-store.mjs --staged            # only files git has staged
//
// Exit 0 clean, 1 warnings only, 2 needs attention. The same exit-code
// convention the rest of the family uses.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { readJsonl, readJsonlWithLines, collectClaimsLocated, parseArgs } from "./lib/jsonl.mjs";
import { validateClaim, validateRule, DEFAULT_ID_RE, DEFAULT_UNIT_RE } from "./lib/schema.mjs";
import { resolveRule } from "./lib/evidence.mjs";
import {
  checkDispositionCoverage,
  checkChunkTiling,
  checkChunkUnits,
  checkConversionFidelity,
  checkUnitReferences,
  verifyDigests,
  loadConfig,
} from "./lib/store.mjs";

function stagedFiles(root) {
  try {
    return execSync("git diff --cached --name-only --diff-filter=ACM", { cwd: root, encoding: "utf8" })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2), { root: ".", profile: "strict" });
  const root = args.root;
  const errors = [];
  const warnings = [];

  let cfg = {};
  try {
    cfg = loadConfig(root);
  } catch (e) {
    process.stderr.write(`ERROR  ${e.message}\n`);
    process.exit(2);
  }

  const opts = {
    profile: args.profile,
    idRe: cfg.id_pattern ? new RegExp(cfg.id_pattern) : DEFAULT_ID_RE,
    unitRe: cfg.unit_pattern ? new RegExp(cfg.unit_pattern) : DEFAULT_UNIT_RE,
  };

  // When invoked from a pre-commit hook there is no point validating a store
  // the commit does not touch — but a partial check must never report a clean
  // store, so the scope is stated in the output.
  let scope = "whole store";
  let touchesStore = true;
  if (args.staged) {
    const files = stagedFiles(root);
    touchesStore = files.some(
      (f) => f.startsWith("claims/") || ["rules.jsonl", "dispositions.jsonl", "corpus.jsonl"].includes(f) ||
        f.startsWith("sources/converted/")
    );
    scope = touchesStore ? "staged store changes (whole store re-checked)" : "no store files staged";
    if (!touchesStore) {
      if (!args.quiet) process.stdout.write("check-store: no store files staged, nothing to check\n");
      process.exit(0);
    }
  }

  // Every artifact is parsed strictly. A corrupt line used to be warned about
  // and skipped, so a damaged store reported *fewer* rows and still looked
  // healthy — the certificate shrank and nothing said why.
  for (const name of ["corpus.jsonl", "rules.jsonl", "dispositions.jsonl", "probes.jsonl",
                      "frameworks.jsonl", "anti-patterns.jsonl", "resolutions.jsonl",
                      "gaps.jsonl", "concepts.jsonl", "checkpoints.jsonl"]) {
    for (const { row, line, error } of readJsonlWithLines(path.join(root, name))) {
      if (row === null) {
        errors.push(
          `${name}:${line}: unparseable JSON (${error}). A skipped line is a row that ` +
            `silently stops counting, which makes every total below it wrong`
        );
      }
    }
  }

  // --- claims ---------------------------------------------------------
  const located = collectClaimsLocated(root);
  const chunkUnits = collectChunkUnits(root);
  opts.chunkUnits = chunkUnits;
  let claimCount = 0;
  for (const { claim, where, error } of located) {
    if (error) {
      errors.push(`${where}: unparseable JSON (${error})`);
      continue;
    }
    claimCount++;
    for (const e of validateClaim(claim, where, opts)) errors.push(`${e.where}: ${e.message}`);
  }

  // --- rules ----------------------------------------------------------
  const rules = readJsonl(path.join(root, "rules.jsonl"));
  const claimIds = new Set(located.filter((l) => l.claim).map((l) => l.claim.id));
  rules.forEach((r, i) => {
    const where = `rules.jsonl:${i + 1}`;
    for (const e of validateRule(r, where, opts)) errors.push(`${e.where}: ${e.message}`);
    const res = resolveRule(r, claimIds);
    if (!res.ok) {
      errors.push(
        `${where}: ${res.reason} — an unresolvable chain means the rule came from ` +
          `somewhere other than the corpus, which is fabrication. Repair it at its ` +
          `origin or drop it; never patch it at the skill`
      );
    }
  });

  // --- store-wide invariants -------------------------------------------
  const disp = checkDispositionCoverage(root);
  if (disp.undisposed.length) {
    warnings.push(
      `${disp.undisposed.length}/${disp.total} claims have no disposition — the certificate ` +
        `is withheld while this holds, because an unaccounted claim is a silent loss ` +
        `rather than a decision`
    );
  }
  for (const id of disp.orphaned.slice(0, 10)) {
    errors.push(`dispositions.jsonl: disposition for '${id}', which is not a claim in the store`);
  }

  for (const u of checkUnitReferences(root)) errors.push(`corpus.jsonl: ${u.detail}`);
  for (const f of checkChunkTiling(root)) errors.push(`${f.doc}: ${f.kind} — ${f.detail}`);
  for (const f of checkChunkUnits(root)) errors.push(`${f.doc}: ${f.detail}`);

  // Verification is opt-in because it re-reads every segment file. Recording a
  // digest and never checking it is not provenance, so this runs in CI where
  // the cost does not fall on a commit.
  if (args.verify) {
    for (const f of verifyDigests(root)) {
      errors.push(`${f.doc}${f.page ? ` segment ${f.page}` : ""}: ${f.kind} — ${f.detail}`);
    }
  }
  for (const f of checkConversionFidelity(root)) {
    errors.push(`${f.doc} page ${f.page ?? "-"}: ${f.kind} — ${f.detail}`);
  }

  // --- report -----------------------------------------------------------
  if (!args.quiet) {
    process.stdout.write(`scope             ${scope}\n`);
    process.stdout.write(`profile           ${args.profile}\n`);
    process.stdout.write(`claims            ${claimCount}\n`);
    process.stdout.write(`digests           ${args.verify ? "verified" : "recorded, not verified (pass --verify)"}\n`);
    process.stdout.write(`rules             ${rules.length}\n`);
  }

  for (const w of warnings) process.stdout.write(`WARN   ${w}\n`);
  for (const e of errors.slice(0, 100)) process.stderr.write(`ERROR  ${e}\n`);
  if (errors.length > 100) process.stderr.write(`ERROR  ... ${errors.length - 100} more\n`);

  if (errors.length) {
    process.stderr.write(
      `\n${errors.length} error(s). A missing value is acceptable and a guessed one is not:\n` +
        `where the evidence does not settle a field, write\n` +
        `  {"status": "unknown", "gap": "<what would settle it>"}\n` +
        `rather than something plausible. A field that looks filled is never questioned again.\n`
    );
    process.exit(2);
  }
  if (warnings.length) {
    if (!args.quiet) process.stdout.write("\nNo errors; warnings above.\n");
    process.exit(1);
  }
  if (!args.quiet) process.stdout.write("\nNo problems found.\n");
  process.exit(0);
}

main();

/** Which unit each chunk belongs to, so a claim's own `unit` can be checked. */
function collectChunkUnits(root) {
  const map = new Map();
  const base = path.join(root, "sources", "converted");
  if (!fs.existsSync(base)) return map;
  for (const doc of fs.readdirSync(base).sort()) {
    for (const c of readJsonl(path.join(base, doc, "chunks.jsonl"))) {
      if (c.id) map.set(c.id, c.unit || null);
    }
  }
  return map;
}
