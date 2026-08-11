#!/usr/bin/env node
// validate-claim.mjs — the write-time gate.
//
//   node validate-claim.mjs claims/<source>/ch07.jsonl
//   node validate-claim.mjs --profile compat claims/**/*.jsonl
//   echo '{...}' | node validate-claim.mjs -
//   node validate-claim.mjs --rules rules.jsonl
//
// Exit 2 on any violation, matching the hook contract: write blocked, error
// returned, worker retries. Exit 0 means everything passed.
//
// Profiles:
//   strict (default)  conformance plus the no-guessing gates
//   compat            exactly the checks the previous Python pipeline ran
//
// The script knows nothing about any book's content. It enforces shape, per
// "a rule that can be checked by a script is never left to a prompt."

import fs from "node:fs";
import { parseArgs } from "./lib/jsonl.mjs";
import { validateClaim, validateRule, DEFAULT_ID_RE, DEFAULT_UNIT_RE } from "./lib/schema.mjs";
import { loadConfig } from "./lib/store.mjs";

const USAGE = `usage: validate-claim.mjs [--profile strict|compat] [--root DIR] [--rules] <file...|->`;

function readLines(file) {
  if (file === "-") return fs.readFileSync(0, "utf8").split("\n");
  return fs.readFileSync(file, "utf8").split("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2), { profile: "strict", root: "." });
  const files = args._;
  if (!files.length) {
    process.stderr.write(USAGE + "\n");
    process.exit(2);
  }
  if (!["strict", "compat"].includes(args.profile)) {
    process.stderr.write(`unknown profile '${args.profile}' — use strict or compat\n`);
    process.exit(2);
  }

  let cfg = {};
  try {
    cfg = loadConfig(args.root);
  } catch (e) {
    process.stderr.write(`REJECT  ${e.message}\n`);
    process.exit(2);
  }

  const opts = {
    profile: args.profile,
    idRe: cfg.id_pattern ? new RegExp(cfg.id_pattern) : DEFAULT_ID_RE,
    unitRe: cfg.unit_pattern ? new RegExp(cfg.unit_pattern) : DEFAULT_UNIT_RE,
  };

  const asRules = Boolean(args.rules);
  const seen = new Map();
  let failures = 0;
  let checked = 0;

  for (const file of files) {
    let lines;
    try {
      lines = readLines(file);
    } catch (e) {
      process.stderr.write(`REJECT  ${file}: cannot read (${e.message})\n`);
      failures++;
      continue;
    }

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].trim();
      if (!raw) continue;
      const where = `${file}:${i + 1}`;
      let row;
      try {
        row = JSON.parse(raw);
      } catch (e) {
        process.stderr.write(`REJECT  ${where}: invalid JSON (${e.message})\n`);
        failures++;
        continue;
      }

      checked++;
      const errors = asRules ? validateRule(row, where, opts) : validateClaim(row, where, opts);
      for (const err of errors) {
        process.stderr.write(`REJECT  ${err.where}: ${err.message}\n`);
        failures++;
      }

      const id = row.id;
      if (id !== undefined) {
        if (seen.has(id)) {
          process.stderr.write(`REJECT  ${where}: duplicate id, first seen at ${seen.get(id)}\n`);
          failures++;
        } else {
          seen.set(id, where);
        }
      }
    }
  }

  if (failures) {
    process.stderr.write(
      `\nVALIDATION FAILED — ${failures} rejection(s) above.\n` +
        `A missing value is acceptable and a guessed one is not: where the evidence\n` +
        `does not settle a field, write {"status": "unknown", "gap": "..."} instead.\n`
    );
    process.exit(2);
  }

  process.stdout.write(
    `OK — ${checked} ${asRules ? "rule" : "claim"}(s) validated across ${files.length} file(s) [profile: ${args.profile}].\n`
  );
}

main();
