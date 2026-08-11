#!/usr/bin/env node
// graph.mjs — derive the structural graph from the artifacts.
//
// The previous architecture rejected an early typed knowledge graph, and that
// rejection was right about the thing it was aimed at: authoring **semantic**
// edges by judgement across thousands of raw claims is quadratic in judgement
// calls, and the payoff concentrated in one query that a set difference
// already answers for free.
//
// It did not reject **structural** edges, which cost no judgement at all
// because a script derives every one of them from a field that already exists.
// Those are what this file builds, and they are what makes incremental work
// possible: a stage can be handed the claims that touch a rule instead of the
// corpus that contains them.
//
// The guarantee that keeps this honest: **the graph is a projection.** It is
// rebuilt from the JSONL artifacts on demand, nothing writes to it directly,
// and deleting it loses nothing. The claim store remains the only source of
// truth. If the graph ever became authoritative it would be a second store to
// keep in sync, and the two would drift exactly the way status once drifted
// from claims.
//
//   node graph.mjs [--root .] [--out graph.jsonl] [--stats]

import path from "node:path";
import { readJsonl, writeJsonl, collectClaims, parseArgs } from "./lib/jsonl.mjs";

export function buildGraph(root) {
  const edges = [];
  const add = (from, to, type, derivedBy) => {
    if (!from || !to) return;
    edges.push({ from, to, type, derived_by: derivedBy });
  };

  const corpus = readJsonl(path.join(root, "corpus.jsonl"));
  const claims = collectClaims(root);
  const rules = readJsonl(path.join(root, "rules.jsonl"));
  const dispositions = readJsonl(path.join(root, "dispositions.jsonl"));
  const resolutions = readJsonl(path.join(root, "resolutions.jsonl"));
  const frameworks = readJsonl(path.join(root, "frameworks.jsonl"));

  // contains: the source's own structure, read off the unit identifiers rather
  // than assumed. A unit `slug/ch03/s01` yields slug → slug/ch03 → slug/ch03/s01.
  for (const u of corpus) {
    if (!u.unit) continue;
    const parts = String(u.unit).split("/");
    for (let i = 1; i < parts.length; i++) {
      add(parts.slice(0, i).join("/"), parts.slice(0, i + 1).join("/"), "contains", "corpus.jsonl");
    }
  }

  for (const c of claims) {
    add(c.unit, c.id, "evidences", "claim.unit");
    for (const slug of c.defines || []) add(c.id, `concept/${slug}`, "defines", "claim.defines");
    for (const slug of c.mentions || []) add(c.id, `concept/${slug}`, "mentions", "claim.mentions");
  }

  for (const r of rules) {
    for (const cid of r.derived_from || []) add(r.id, cid, "derived_from", "rules.derived_from");
    if (r.cluster) add(`cluster/${r.cluster}`, r.id, "contains", "rules.cluster");
    for (const ap of r.anti_patterns || []) add(r.id, ap, "guards_against", "rules.anti_patterns");
    // R4's boundary clauses carry the claim that established them, which is the
    // cross-unit link nothing else records.
    for (const u of r.unless || []) {
      if (u && typeof u === "object" && u.from) add(u.from, r.id, "bounds", "rules.unless[].from");
    }
  }

  for (const d of dispositions) {
    if (d.disposition === "merged" && d.target) add(d.claim, d.target, "merged_into", "dispositions.jsonl");
    else if (d.target) add(d.claim, d.target, "dispositioned_to", "dispositions.jsonl");
  }

  for (const r of resolutions) {
    const ids = r.claims || r.between || [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) add(ids[i], ids[j], "contradicts", "resolutions.jsonl");
    }
  }

  for (const f of frameworks) {
    for (const t of f.tradeoffs || []) {
      if (t.rule_a && t.rule_b) add(t.rule_a, t.rule_b, "trades_off_with", "frameworks.tradeoffs");
    }
  }

  // Deterministic order, so a rebuild is byte-comparable with the copy it
  // replaced. That reproducibility is the test that it is really a projection.
  edges.sort((a, b) =>
    a.type < b.type ? -1 : a.type > b.type ? 1
      : a.from < b.from ? -1 : a.from > b.from ? 1
      : a.to < b.to ? -1 : a.to > b.to ? 1 : 0
  );
  return edges;
}

function main() {
  const args = parseArgs(process.argv.slice(2), { root: "." });
  const edges = buildGraph(args.root);
  const out = args.out || path.join(args.root, "graph.jsonl");
  writeJsonl(out, edges);

  const byType = new Map();
  for (const e of edges) byType.set(e.type, (byType.get(e.type) || 0) + 1);
  const nodes = new Set(edges.flatMap((e) => [e.from, e.to]));

  process.stdout.write(`edges             ${edges.length}\n`);
  process.stdout.write(`nodes             ${nodes.size}\n`);
  for (const [t, n] of [...byType.entries()].sort()) {
    process.stdout.write(`  ${t.padEnd(18)}${n}\n`);
  }
  process.stdout.write(`written           ${out}\n`);
  process.stdout.write(
    `\nDerived, not authoritative: delete this file and rebuild it, and nothing\n` +
      `is lost. Nothing may write to it directly.\n`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
