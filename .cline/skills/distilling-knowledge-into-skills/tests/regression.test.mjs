// regression.test.mjs — the refinement half must not have moved.
//
// EPUB replaced the ingestion tier. Everything downstream of the claim store —
// the concept index, merge-candidate generation, the certificate — was not
// touched, and the way to know that is to keep measuring it against the output
// the original Python pipeline produced on a real 184-claim store.
//
// The reference store lives outside this repository, so these tests skip when
// it is absent rather than failing. A skipped regression is reported as such;
// silently passing would be worse than not having it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it, assert, equal } from "./harness.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Set DISTILL_REFERENCE_STORE to a claim store produced by the original Python
// pipeline. No default path: hardcoding one would name a particular corpus in a
// skill that must stay domain-agnostic.
const REFERENCE = process.env.DISTILL_REFERENCE_STORE || "";

const available = Boolean(REFERENCE) && fs.existsSync(path.join(REFERENCE, "claims"));
const jsonl = (f) => fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

describe("regression · the refinement half is unchanged", () => {
  if (!available) {
    it("SKIPPED — the reference store is not present on this machine", () => {
      assert(true, "set DISTILL_REFERENCE_STORE to a Python-era claim store to run this group");
    });
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "distill-regression-"));
  fs.cpSync(REFERENCE, dir, { recursive: true });
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));

  const run = (name, args = []) =>
    execFileSync("node", [path.join(root, "scripts", name), "--root", ".", ...args], {
      cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });

  it("the concept index still derives 153 rows", () => {
    run("index.mjs", ["--quiet", "--generated-at", "2026-01-01T00:00:00+00:00"]);
    equal(jsonl(path.join(dir, "concepts.jsonl")).length, 153);
  });

  it("gap derivation still produces 175 rows", () => {
    equal(jsonl(path.join(dir, "gaps.jsonl")).length, 175);
  });

  it("merge-candidate generation still proposes 179 pairs", () => {
    run("dedupe.mjs");
    equal(jsonl(path.join(dir, "merge-candidates.jsonl")).length, 179);
  });

  it("the store still passes the compat profile at its recorded counts", () => {
    const out = execFileSync("node", [path.join(root, "scripts", "check-store.mjs"), "--root", ".", "--profile", "compat"], {
      cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    assert(out.includes("No problems found"), out);
    assert(out.includes("claims            184"), "claim count moved");
    assert(out.includes("rules             99"), "rule count moved");
  });

  it("the strict profile still surfaces the 45 truncated rule names", () => {
    let out = "";
    try {
      execFileSync("node", [path.join(root, "scripts", "check-store.mjs"), "--root", ".", "--profile", "strict"], {
        cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      out = (e.stdout || "") + (e.stderr || "");
    }
    const truncated = (out.match(/ends mid-clause/g) || []).length;
    equal(truncated, 45, "the finding the strict profile exists to surface");
  });

  it("a store with no converted sources certifies without ingestion findings", () => {
    let out = "";
    try {
      out = run("certify.mjs", ["--generated-at", "2026-01-01T00:00:00+00:00"]);
    } catch (e) {
      out = (e.stdout || "") + (e.stderr || "");
    }
    assert(!out.includes("CONVERSION SUSPECT"), "an EPUB-free legacy store must not acquire ingestion findings");
    assert(out.includes("NOT REACHED"), "the certificate must still report its shortfalls");
  });
});
