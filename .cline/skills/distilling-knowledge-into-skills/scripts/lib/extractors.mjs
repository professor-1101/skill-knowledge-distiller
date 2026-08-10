// extractors.mjs — the extractor adapter contract.
//
// One interface, several implementations, and the pipeline treats them
// identically: whichever produced the text, the output faces the same
// reconciliation and quality gates.
//
// An adapter returns `{ id, pages: [{page, text, error}] }`. `id` is the
// pinning string — name, version, and the flags actually used — because an
// extractor's *version* changes its output, and text that changes changes
// every excerpt_hash downstream. Recording only "pdftotext" would leave the
// evidence chain scoped to one machine without saying so.
//
// `builtin` is always available and needs nothing installed. External
// adapters are used when configured and reported as missing when not — no
// tool is ever installed on anyone's behalf.

import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractPdf } from "./pdf.mjs";

export function have(tool) {
  try {
    execSync(`command -v ${tool}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function version(cmd) {
  try {
    return String(execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))
      .split("\n")[0]
      .trim();
  } catch {
    return "unknown";
  }
}

const builtin = {
  name: "builtin",
  available: () => true,
  describe: () => `builtin@${BUILTIN_VERSION}`,
  run(file) {
    const { pages } = extractPdf(fs.readFileSync(file));
    return { id: this.describe(), pages };
  },
};

// Bumped whenever the extractor's output could change. Pinning by content
// hash would be stricter, but a comment change would then invalidate a whole
// corpus for no reason — the version is a claim about behaviour, not bytes.
export const BUILTIN_VERSION = "1.0.0";

const pdftotext = {
  name: "pdftotext",
  available: () => have("pdftotext") && have("pdfinfo"),
  describe: () => `pdftotext@${version("pdftotext -v 2>&1 | head -1")}+layout`,
  run(file) {
    const out = String(execFileSync("pdfinfo", [file], { encoding: "utf8" }));
    const m = out.match(/^Pages:\s+(\d+)/m);
    if (!m) throw new Error("pdfinfo did not report a page count");
    const total = Number(m[1]);
    const pages = [];
    for (let p = 1; p <= total; p++) {
      try {
        const text = String(
          execFileSync("pdftotext", ["-f", String(p), "-l", String(p), "-layout", file, "-"], {
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
          })
        );
        pages.push({ page: p, text, error: null });
      } catch (e) {
        pages.push({ page: p, text: null, error: e.message });
      }
    }
    return { id: this.describe(), pages };
  },
};

const mutool = {
  name: "mutool",
  available: () => have("mutool"),
  describe: () => `mutool@${version("mutool -v 2>&1 | head -1")}+text`,
  run(file) {
    const info = String(execFileSync("mutool", ["info", file], { encoding: "utf8" }));
    const m = info.match(/Pages:\s*(\d+)/);
    if (!m) throw new Error("mutool info did not report a page count");
    const total = Number(m[1]);
    const pages = [];
    for (let p = 1; p <= total; p++) {
      try {
        const text = String(
          execFileSync("mutool", ["draw", "-F", "txt", "-o", "-", file, String(p)], {
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
          })
        );
        pages.push({ page: p, text, error: null });
      } catch (e) {
        pages.push({ page: p, text: null, error: e.message });
      }
    }
    return { id: this.describe(), pages };
  },
};

/**
 * An arbitrary command, so a project can qualify its own extractor — a Python
 * script over PyMuPDF, a service, anything. The contract is deliberately
 * minimal: given a file, print one JSON object with a `pages` array.
 *
 *   { "id": "my-extractor@2.1", "pages": [{ "page": 1, "text": "…", "error": null }] }
 *
 * `{{FILE}}` in the command is replaced with the path. The command must be
 * declared in `.distill.json` under `extractors.custom`, and its `id` is
 * recorded exactly as returned, so a project that pins its own tool has the
 * same provenance guarantees as one using the built-in.
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
  if (name === "builtin") return builtin;
  if (name === "pdftotext") return pdftotext;
  if (name === "mutool") return mutool;
  const custom = (config.extractors || {}).custom;
  if (custom && (custom.name === name || name === "custom")) return customAdapter(custom);
  return null;
}

export function listExtractors(config = {}) {
  const out = [builtin, pdftotext, mutool];
  const custom = (config.extractors || {}).custom;
  if (custom) out.push(customAdapter(custom));
  return out;
}

/**
 * Pick the primary and, where possible, a second independent one to check it
 * against. Two extractors agreeing on a page is real evidence the conversion
 * is right; that is the ingestion tier's version of "every producer has an
 * adversary", which the rest of the pipeline already relies on.
 */
export function choose(config = {}, requested) {
  const cfg = config.extractors || {};
  const primaryName = requested || cfg.primary || "builtin";
  const primary = getExtractor(primaryName, config);
  if (!primary) throw new Error(`unknown extractor '${primaryName}'`);
  if (!primary.available()) {
    throw new Error(
      `extractor '${primaryName}' is not available on this machine. Install it ` +
        `yourself, or use --extractor builtin, which needs nothing. Nothing is ` +
        `installed on your behalf.`
    );
  }
  let cross = null;
  const crossName = cfg.cross_check === false ? null : cfg.cross_check;
  if (crossName) {
    cross = getExtractor(crossName, config);
    if (cross && !cross.available()) cross = null;
  } else if (cfg.cross_check !== false) {
    cross = listExtractors(config).find((e) => e.name !== primary.name && e.available()) || null;
  }
  return { primary, cross };
}

/** Temp path helper for adapters that need a file on disk. */
export function tmpFile(prefix, buf, ext = ".pdf") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const f = path.join(dir, "doc" + ext);
  fs.writeFileSync(f, buf);
  return f;
}
