#!/usr/bin/env node
// activate.mjs — the activation token, and the gate that binds to it.
//
// "The methodology should be loaded before any pipeline step runs" is only
// true if something refuses when it was not. This is that something, carried
// over from the previous project where it was the piece that worked.
//
// The token records the sha256 of the SKILL.md that was loaded. The gate
// refuses a write into the claim store unless a token exists **and** matches
// the SKILL.md on disk right now. The second condition does the real work:
// editing the methodology without re-loading it leaves the token stale and the
// gate closed, rather than letting the pipeline run under a version of the
// procedure nobody read. It is the same invalidation-by-hash rule applied to
// prompt versions — a changed procedure invalidates work done under the old one.
//
//   node activate.mjs [--root .]            # write the token, print the ruleset
//   node activate.mjs --root . --gate       # exit 2 unless the token is current
//   node activate.mjs --root . --gate --path claims/x.jsonl
//
// Activation always exits 0: a hook that blocks session start would be worse
// than the problem it guards. The gate exits 2 to block.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "./lib/jsonl.mjs";
import { sha256 } from "./lib/evidence.mjs";

const SKILL_REL = ".cline/skills/distilling-knowledge-into-skills";
const TOKEN_REL = path.join(".cline", ".distill-active");

// Artifacts only the governed pipeline may produce. A write outside this set
// is ordinary work and is none of the gate's business.
const GUARDED = [
  "claims/", "sources/converted/",
  "rules.jsonl", "frameworks.jsonl", "dispositions.jsonl", "anti-patterns.jsonl",
  "resolutions.jsonl", "probes.jsonl", "corpus.jsonl", "checkpoints.jsonl",
];

const RULESET = `KNOWLEDGE-DISTILLATION METHODOLOGY ACTIVE

The skill \`distilling-knowledge-into-skills\` governs every ingestion,
extraction, refinement and compilation step. Load it before running any stage;
its prompts outrank any summary, including this one.

Non-negotiable while it is active:

- Evidence or omission. Nothing enters the store unsourced, and every locator
  resolves to a real digest over the span actually read.
- Cannot prove, so record a gap. Never infer. A missing value is acceptable
  and a guessed one is not, because a field that looks filled is never
  questioned again.
- Refinement stages work from the store, not the source. The one exception is
  a targeted probe when a rule cluster has no anti-pattern, and it emits a gap
  record either way.
- Every claim gets a disposition. Claims minus dispositions is empty before
  anything may be certified.
- Status is derived from artifacts, never authored by hand.
`;

function skillFile(root) {
  return path.join(root, SKILL_REL, "SKILL.md");
}

function isGuarded(root, p) {
  if (!p) return false;
  const rel = path.relative(path.resolve(root), path.resolve(p)).split(path.sep).join("/");
  if (rel.startsWith("..")) return false;
  return GUARDED.some((g) => (g.endsWith("/") ? rel.startsWith(g) : rel === g));
}

function main() {
  const args = parseArgs(process.argv.slice(2), { root: "." });
  const root = args.root;
  const skill = skillFile(root);
  const tokenPath = path.join(root, TOKEN_REL);

  if (!args.gate) {
    let hash = null;
    try {
      hash = sha256(fs.readFileSync(skill));
    } catch {
      process.stderr.write(`distill: SKILL.md not found at ${skill} — nothing to activate\n`);
      process.exit(0);
    }
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(
      tokenPath,
      JSON.stringify({ skill_sha256: hash, activated_at: new Date().toISOString() }, null, 2) + "\n",
      "utf8"
    );
    process.stdout.write(RULESET);
    process.exit(0);
  }

  // --- gate ---
  if (args.path && !isGuarded(root, args.path)) process.exit(0);

  let current;
  try {
    current = sha256(fs.readFileSync(skill));
  } catch {
    process.stderr.write(
      `BLOCKED: the methodology skill is missing (${skill}). The claim store is ` +
        `governed by it, so writes are refused until it is restored.\n`
    );
    process.exit(2);
  }

  let token;
  try {
    token = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
  } catch {
    process.stderr.write(
      `BLOCKED: no activation token, so distilling-knowledge-into-skills was never ` +
        `loaded this session and the pipeline would be running ungoverned.\n` +
        `Fix: node ${SKILL_REL}/scripts/activate.mjs\n`
    );
    process.exit(2);
  }

  if (token.skill_sha256 !== current) {
    process.stderr.write(
      `BLOCKED: SKILL.md changed since the methodology was activated, so the loaded ` +
        `procedure is not the current one.\n` +
        `This is the same invalidation-by-hash rule the pipeline applies to prompt ` +
        `versions: a changed procedure invalidates work done under the old one.\n` +
        `Fix: re-read the skill, then run node ${SKILL_REL}/scripts/activate.mjs\n`
    );
    process.exit(2);
  }

  process.exit(0);
}

main();
