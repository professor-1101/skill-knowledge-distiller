#!/usr/bin/env node
// dedupe.mjs — R1 merge-candidate generation.
//
// Reduces an O(n²) claim comparison to a few hundred pairs for R2 to
// adjudicate. Cheap and approximate **by design**: precision does not matter
// here, recall does. A false candidate costs one cheap judgement at R2; a
// missed pair costs a duplicate rule in the finished library, which nothing
// downstream will catch.
//
// Two signals, either sufficient to nominate a pair:
//   1. shared concept slugs across `defines`/`mentions`
//   2. lexical overlap on content words, stopwords removed
//
// Note what this stage does **not** do: it does not merge anything. The
// discriminator for a real merge is the condition, and that is a judgement R2
// makes with the pair in front of it. The previous run proposed 266 candidates
// here and merged exactly 2 — everything else had a different condition, and
// merging on wording would have destroyed the distinction worth keeping.
//
//   node dedupe.mjs [--root DIR] [--threshold 0.35] [--max-pairs 500]

import path from "node:path";
import { collectClaims, writeJsonl, parseArgs, pyFloat } from "./lib/jsonl.mjs";

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "than", "that", "this",
  "these", "those", "is", "are", "was", "were", "be", "been", "being", "to",
  "of", "in", "on", "at", "by", "for", "with", "from", "as", "it", "its",
  "not", "no", "can", "cannot", "may", "might", "must", "should", "would",
  "will", "when", "where", "which", "who", "whom", "how", "what", "why",
  "each", "every", "any", "all", "some", "only", "also", "more", "most",
  "other", "such", "one", "two", "into", "out", "up", "down", "over",
  "under", "again", "further", "do", "does", "did", "done", "has", "have",
  "had", "having", "you", "your", "we", "our", "they", "their",
]);

const WORD_RE = /[a-z][a-z0-9-]{2,}/g;

function contentWords(claim) {
  const text = [claim.statement || "", claim.condition || "", claim.consequence || ""]
    .join(" ")
    .toLowerCase();
  const out = new Set();
  for (const m of text.matchAll(WORD_RE)) {
    if (!STOPWORDS.has(m[0])) out.add(m[0]);
  }
  return out;
}

function slugsOf(claim) {
  return new Set([...(claim.defines || []), ...(claim.mentions || [])]);
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0.0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Python's round(): half to **even**, applied to the exact binary value.
 *
 * JavaScript's Math.round is half-up, so 1/16 scores 0.063 here and 0.062
 * there. Matching matters only because these files are diffed against a store
 * the Python pipeline produced — a one-digit drift would read as a real
 * divergence and cost someone an afternoon.
 */
function round3(n) {
  if (!Number.isFinite(n)) return n;
  const exact = n.toFixed(20);
  const [intPart, fracPart = ""] = exact.split(".");
  const keep = fracPart.slice(0, 3).padEnd(3, "0");
  const rest = fracPart.slice(3);
  let carry = 0;
  if (rest) {
    const first = rest[0];
    const tail = rest.slice(1).replace(/0+$/, "");
    if (first > "5" || (first === "5" && tail)) carry = 1;
    else if (first === "5" && !tail) carry = Number(keep[2]) % 2 === 1 ? 1 : 0; // tie: to even
  }
  const scaled = Number(intPart) * 1000 + Number(keep) + carry;
  return scaled / 1000;
}

function main() {
  const args = parseArgs(process.argv.slice(2), { root: ".", threshold: "0.35", "max-pairs": "500" });
  const threshold = Number(args.threshold);
  const maxPairs = Number(args["max-pairs"]);

  const claims = collectClaims(args.root);
  if (claims.length < 2) {
    process.stdout.write(`only ${claims.length} claim(s) — nothing to compare\n`);
    return;
  }

  const prepared = claims.map((c) => ({ claim: c, words: contentWords(c), slugs: slugsOf(c) }));

  // Blocking: only compare claims sharing at least one concept slug or content
  // word. Pairs with no vocabulary in common are not merge candidates under
  // either signal, so skipping them costs no recall and buys the whole speedup.
  const buckets = new Map();
  prepared.forEach((p, idx) => {
    for (const key of new Set([...p.slugs, ...p.words])) {
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(idx);
    }
  });

  const seen = new Set();
  const pairs = [];
  for (const members of buckets.values()) {
    // A term shared by this many claims carries no discriminating signal, and
    // comparing every pair under it is where the cost would come back.
    if (members.length > 200) continue;
    const sorted = [...members].sort((a, b) => a - b);
    for (let a = 0; a < sorted.length; a++) {
      for (let b = a + 1; b < sorted.length; b++) {
        const i = sorted[a];
        const j = sorted[b];
        const key = i * 1e6 + j;
        if (seen.has(key)) continue;
        seen.add(key);
        const pi = prepared[i];
        const pj = prepared[j];
        if (pi.claim.id === pj.claim.id) continue;
        const slugOverlap = jaccard(pi.slugs, pj.slugs);
        const wordOverlap = jaccard(pi.words, pj.words);
        const score = Math.max(slugOverlap, wordOverlap);
        if (score < threshold) continue;
        pairs.push({
          _score: round3(score),
          claim_a: pi.claim.id,
          claim_b: pj.claim.id,
          score: pyFloat(round3(score)),
          slug_overlap: pyFloat(round3(slugOverlap)),
          word_overlap: pyFloat(round3(wordOverlap)),
          shared_slugs: [...pi.slugs].filter((s) => pj.slugs.has(s)).sort(),
          same_unit: pi.claim.unit === pj.claim.unit,
          same_book: (pi.claim.evidence || {}).source === (pj.claim.evidence || {}).source,
          status: "pending-R2",
        });
      }
    }
  }

  // Highest signal first, so R2 can work down the list and stop when the tail
  // goes cold. `_score` is the unboxed value used only for ordering.
  pairs.sort((x, y) => y._score - x._score);
  const kept = pairs.slice(0, maxPairs).map(({ _score, ...row }) => row);

  const out = path.join(args.root, "merge-candidates.jsonl");
  writeJsonl(out, kept);

  const crossBook = kept.filter((p) => !p.same_book).length;
  process.stdout.write(`claims           ${claims.length}\n`);
  process.stdout.write(`candidate pairs  ${kept.length}  (threshold ${threshold})\n`);
  process.stdout.write(`cross-book       ${crossBook}   <- where corroboration comes from\n`);
  process.stdout.write(`written          ${out}\n`);
}

main();
