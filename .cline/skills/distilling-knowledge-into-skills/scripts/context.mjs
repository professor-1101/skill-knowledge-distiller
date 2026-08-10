#!/usr/bin/env node
// context.mjs — assemble the minimal input set for one stage, from the graph.
//
// This is what makes the pipeline runnable over a book that does not fit in a
// context window. A refinement stage is not handed the corpus; it is handed
// the claims that actually touch the thing it is reasoning about, named and
// bounded, with a count it can check.
//
// The stage that needs this most is R4. Its contract is "the rule plus every
// claim mentioning its concepts, **including claims from other units and other
// books**", because a source routinely states a rule in one chapter and
// qualifies it in another. Without traversal that is a full scan of the store
// per rule; with it, it is two hops.
//
//   node context.mjs --for rule/some-id [--hops 2] [--root .] [--format ids|jsonl]
//   node context.mjs --for concept/equivalence-class --hops 1
//   node context.mjs --for <unit-or-claim-id>
//
// Exit 0 always. This assembles input; it does not judge it.

import path from "node:path";
import { readJsonl, collectClaims, dumps, parseArgs } from "./lib/jsonl.mjs";
import { buildGraph } from "./graph.mjs";

function adjacency(edges) {
  const out = new Map();
  const add = (a, b, type) => {
    if (!out.has(a)) out.set(a, []);
    out.get(a).push({ to: b, type });
  };
  for (const e of edges) {
    // Undirected for retrieval: a claim reached through the concept it mentions
    // is as relevant as one reached from the rule that derives from it.
    add(e.from, e.to, e.type);
    add(e.to, e.from, e.type);
  }
  return out;
}

function traverse(adj, start, hops) {
  const seen = new Map([[start, 0]]);
  let frontier = [start];
  for (let d = 1; d <= hops; d++) {
    const next = [];
    for (const node of frontier) {
      for (const { to } of adj.get(node) || []) {
        if (seen.has(to)) continue;
        seen.set(to, d);
        next.push(to);
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return seen;
}

function main() {
  const args = parseArgs(process.argv.slice(2), { root: ".", hops: "2", format: "ids" });
  const target = args.for;
  if (!target) {
    process.stderr.write("usage: context.mjs --for <node-id> [--hops N] [--format ids|jsonl]\n");
    process.exit(2);
  }

  const edges = buildGraph(args.root);
  const adj = adjacency(edges);
  if (!adj.has(target)) {
    process.stderr.write(
      `'${target}' is not in the graph. It is derived from the artifacts, so an ` +
        `absent node means the field that would create the edge is empty — which ` +
        `is itself worth knowing.\n`
    );
    process.exit(0);
  }

  const reached = traverse(adj, target, Number(args.hops));
  const claims = collectClaims(args.root);
  const byId = new Map(claims.map((c) => [c.id, c]));
  const rules = new Map(readJsonl(path.join(args.root, "rules.jsonl")).map((r) => [r.id, r]));

  const claimHits = [...reached.keys()].filter((id) => byId.has(id)).sort();
  const ruleHits = [...reached.keys()].filter((id) => rules.has(id) && id !== target).sort();
  const conceptHits = [...reached.keys()].filter((id) => id.startsWith("concept/")).sort();

  if (args.format === "jsonl") {
    for (const id of claimHits) process.stdout.write(dumps(byId.get(id)) + "\n");
    return;
  }

  process.stdout.write(`target            ${target}\n`);
  process.stdout.write(`hops              ${args.hops}\n`);
  process.stdout.write(`claims            ${claimHits.length}\n`);
  process.stdout.write(`concepts          ${conceptHits.length}\n`);
  process.stdout.write(`sibling rules     ${ruleHits.length}\n\n`);

  // Distance is worth printing: a claim two hops out arrived through a shared
  // concept, which is a weaker relationship than a direct derivation, and a
  // stage weighing evidence should be able to see the difference.
  for (const id of claimHits) {
    const c = byId.get(id);
    process.stdout.write(`  [${reached.get(id)}] ${id}\n      ${String(c.statement || "").slice(0, 96)}\n`);
  }
  if (conceptHits.length) {
    process.stdout.write("\n  concepts: " + conceptHits.map((c) => c.replace("concept/", "")).join(", ") + "\n");
  }
}

main();
