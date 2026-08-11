// extractors.mjs — the extractor adapter contract.
//
// EPUB is the only supported format. That is not a convenience choice: a PDF
// has no semantic structure to recover, so reading order, headings and the
// table of contents must all be inferred, and every inference is a place where
// a wrong-but-plausible result enters the store. The pipeline used to carry a
// PDF path and a whole mechanism of human page declarations to compensate for
// exactly that; both are gone.
//
// An adapter returns `{ id, pages: [{page, text, error, …}] }`. `id` is the
// pinning string — name and version — because an extractor's version changes
// its output, and changed text changes every excerpt_hash downstream.
//
// The built-in extractor needs nothing installed. A project may qualify its
// own through the custom contract; whichever produced the text, the output
// faces the same reconciliation and the same gates.

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractEpub, EXTRACTOR_VERSION } from "./epub.mjs";

export function have(tool) {
  try {
    execSync(`command -v ${tool}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const builtin = {
  name: "epub-builtin",
  available: () => true,
  describe: () => `epub-builtin@${EXTRACTOR_VERSION}`,
  run(file) {
    return extractEpub(fs.readFileSync(file));
  },
};

/**
 * An arbitrary command, so a project can qualify its own extractor — a Python
 * script, a service, anything. The contract is deliberately minimal: given a
 * file, print one JSON object on stdout.
 *
 *   { "id": "my-extractor@2.1",
 *     "pages": [{ "page": 1, "text": "…", "error": null, "href": "…" }] }
 *
 * Declared in `.distill.json` under `extractors.custom`. Its `id` is recorded
 * exactly as returned, so a project pinning its own tool gets the same
 * provenance guarantees as one using the built-in — and faces the same
 * conformance suite, which is what makes the claim checkable.
 */
function customAdapter(spec) {
  return {
    name: spec.name || "custom",
    available: () => Boolean(spec.command),
    describe: () => spec.id || `${spec.name || "custom"}@declared`,
    run(file) {
      const cmd = spec.command.replace("{{FILE}}", JSON.stringify(file));
      const out = String(execSync(cmd, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }));
      let parsed;
      try {
        parsed = JSON.parse(out);
      } catch (e) {
        throw new Error(
          `custom extractor did not print JSON (${e.message}). The contract is one ` +
            `object with {id, pages:[{page,text,error}]} on stdout.`
        );
      }
      if (!Array.isArray(parsed.pages)) throw new Error("custom extractor returned no `pages` array");
      return { id: parsed.id || this.describe(), pages: parsed.pages };
    },
  };
}

export function getExtractor(name, config = {}) {
  if (name === "epub-builtin" || name === "builtin") return builtin;
  const custom = (config.extractors || {}).custom;
  if (custom && (custom.name === name || name === "custom")) return customAdapter(custom);
  return null;
}

export function listExtractors(config = {}) {
  const out = [builtin];
  const custom = (config.extractors || {}).custom;
  if (custom) out.push(customAdapter(custom));
  return out;
}

/**
 * Pick the extractor to run.
 *
 * There is no cross-check against a second extractor any more, and its absence
 * is deliberate rather than an omission. The PDF pipeline needed one because
 * nothing else could tell whether a page had been read correctly. For EPUB the
 * adversary is the source markup itself: `reconcile()` asserts every prose text
 * node reached the output, which is a stronger check than agreement between two
 * tools and needs nothing installed. Ordering, which reconciliation cannot
 * prove, is covered by fixtures with known-correct output.
 */
export function choose(config = {}, requested) {
  const cfg = config.extractors || {};
  const name = requested || cfg.primary || "epub-builtin";
  const primary = getExtractor(name, config);
  if (!primary) throw new Error(`unknown extractor '${name}'`);
  if (!primary.available()) {
    throw new Error(
      `extractor '${name}' is not available on this machine. Use the built-in, ` +
        `which needs nothing installed. No tool is installed on your behalf.`
    );
  }
  return { primary };
}

/** Temp path helper for adapters that need a file on disk. */
export function tmpFile(prefix, buf, ext = ".epub") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const f = path.join(dir, "book" + ext);
  fs.writeFileSync(f, buf);
  return f;
}
