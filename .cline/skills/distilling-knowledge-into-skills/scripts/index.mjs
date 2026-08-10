#!/usr/bin/env node
// index.mjs — the completeness engine.
//
// Derives two artifacts from the claim store:
//
//   concepts.jsonl   every concept slug, who defines it, who mentions it
//   gaps.jsonl       rows owned by `found_by: indexer`, rewritten in place
//
// The load-bearing query is a set difference: concepts *mentioned* by some
// claim and *defined* by none. That one query is why an early typed knowledge
// graph was rejected as premature — it delivers the highest-yield completeness
// signal for the cost of a set operation, where authoring typed edges across
// thousands of raw claims would have cost quadratic judgement for the same
// answer. It earned its place on the first chapter of the previous run, which
// flagged three concepts that turned out to be genuine extraction misses.
//
// Idempotent. Rows written by other stages are preserved untouched; only
// `found_by: indexer` rows are regenerated, so re-running never destroys a
// finding some other pass recorded.
//
//   node index.mjs [--root DIR] [--quiet]
//
// Exit 0 always — this reports, it does not gate.

import path from "node:path";
import { readJsonl, writeJsonl, collectClaims, nowIso, parseArgs } from "./lib/jsonl.mjs";

const INDEXER = "indexer";

function buildConcepts(claims) {
  const defined = new Map();
  const mentioned = new Map();
  for (const c of claims) {
    for (const slug of c.defines || []) {
      if (!defined.has(slug)) defined.set(slug, []);
      defined.get(slug).push(c.id);
    }
    for (const slug of c.mentions || []) {
      if (!mentioned.has(slug)) mentioned.set(slug, []);
      mentioned.get(slug).push(c.id);
    }
  }
  const slugs = [...new Set([...defined.keys(), ...mentioned.keys()])].sort();
  return slugs.map((slug) => ({
    concept: slug,
    defined_by: (defined.get(slug) || []).slice().sort(),
    mentioned_by: (mentioned.get(slug) || []).slice().sort(),
    status: defined.has(slug) ? "defined" : "referenced-undefined",
  }));
}

/** Python's statistics.median: the mean of the two middle values when even. */
function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Python's `%g`: drop a trailing `.0`, keep six significant digits. */
function fmtG(n) {
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toPrecision(6)));
}

function buildGaps(concepts, claims, corpus, now) {
  const gaps = [];

  for (const row of concepts) {
    if (row.status !== "referenced-undefined") continue;
    gaps.push({
      concept: row.concept,
      gap:
        `concept '${row.concept}' is referenced by ${row.mentioned_by.length} claim(s) ` +
        `but defined by none — either the defining passage was never extracted, or ` +
        `the concept belongs to a unit still pending`,
      mentioned_by: row.mentioned_by.slice(0, 10),
      found_by: INDEXER,
      status: "open",
      found_at: now,
    });
  }

  const perUnit = new Map();
  for (const c of claims) perUnit.set(c.unit, (perUnit.get(c.unit) || 0) + 1);

  // A unit marked done while holding no claims is the exact failure that
  // corrupted the first claim store: status authored by judgement, never
  // reconciled against the artifacts it claimed to describe.
  for (const unitRow of corpus) {
    if (!unitRow.unit) continue;
    const count = perUnit.get(unitRow.unit) || 0;
    const status = String(unitRow.status || "").toLowerCase();
    if (count === 0 && !["pending", "deferred", "source-failed"].includes(status)) {
      gaps.push({
        unit: unitRow.unit,
        gap:
          `unit is marked '${status}' but holds zero claims — a status that outruns ` +
          `the claim store is the failure this check exists to catch`,
        found_by: INDEXER,
        status: "open",
        found_at: now,
      });
    }
  }

  const counts = [...perUnit.values()].filter((n) => n > 0);
  if (counts.length >= 4) {
    const med = median(counts);
    const floor = med / 3.0;
    const units = [...perUnit.keys()].sort();
    for (const unit of units) {
      const count = perUnit.get(unit);
      if (count > 0 && count < floor) {
        gaps.push({
          unit,
          gap:
            `claim density ${count} is far below the corpus median ${fmtG(med)} — ` +
            `candidate for a targeted re-probe`,
          found_by: INDEXER,
          status: "open",
          found_at: now,
        });
      }
    }
  }

  return gaps;
}

function main() {
  const args = parseArgs(process.argv.slice(2), { root: "." });
  const root = args.root;
  const now = nowIso();

  const claims = collectClaims(root);
  const corpus = readJsonl(path.join(root, "corpus.jsonl"));

  const concepts = buildConcepts(claims);
  writeJsonl(path.join(root, "concepts.jsonl"), concepts);

  const gapsPath = path.join(root, "gaps.jsonl");
  const preserved = readJsonl(gapsPath).filter((g) => g.found_by !== INDEXER);
  const derived = buildGaps(concepts, claims, corpus, now);
  writeJsonl(gapsPath, [...preserved, ...derived]);

  if (args.quiet) return;

  const undefinedConcepts = concepts.filter((c) => c.status === "referenced-undefined");
  process.stdout.write(`claims            ${claims.length}\n`);
  process.stdout.write(`units enumerated  ${corpus.length}\n`);
  process.stdout.write(
    `concepts          ${concepts.length}  (${concepts.length - undefinedConcepts.length} defined, ${undefinedConcepts.length} referenced-undefined)\n`
  );
  process.stdout.write(
    `gaps              ${derived.length} derived + ${preserved.length} from other stages\n`
  );
  if (undefinedConcepts.length) {
    process.stdout.write("\nREFERENCED-UNDEFINED (the completeness signal):\n");
    for (const row of undefinedConcepts.slice(0, 20)) {
      process.stdout.write(`  ${row.concept}  (${row.mentioned_by.length} mentions)\n`);
    }
    if (undefinedConcepts.length > 20) {
      process.stdout.write(`  ... ${undefinedConcepts.length - 20} more\n`);
    }
  }
}

main();
