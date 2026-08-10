#!/usr/bin/env node
// ingest.mjs — turn a book into a converted, gated, page-addressable source.
//
// This tier did not exist in the previous project, which consumed exports that
// were already text. A PDF is a different problem, and the risk sits somewhere
// counter-intuitive: **a failed conversion is loud and harmless. A conversion
// that succeeds and is wrong reports as coverage.** Half a book silently
// missing looks exactly like half a book that had nothing in it.
//
// So this script does not implement conversion. It drives a declared external
// extractor, records exactly which one and what it returned, and enforces the
// invariants that make a silent loss impossible to mistake for an empty page.
// Bundling a PDF parser would mean npm dependencies, and a skill directory
// copied into ~/.cline/skills/ never gets an `npm install`.
//
//   node ingest.mjs --source book.pdf --slug my-book [--root .]
//   node ingest.mjs --source notes.md --slug my-book --extractor text
//   node ingest.mjs --slug my-book --declare blank:41
//   node ingest.mjs --slug my-book --declare image:88 --ocr tesseract --ocr-confidence 0.82
//   node ingest.mjs --slug my-book --declare gap:88 --reason "figure carries the content; no OCR available"
//
// Exit 0 clean, 2 when a gate blocks, 3 when a required tool is missing.

import fs from "node:fs";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { readJsonl, writeJsonl, nowIso, parseArgs } from "./lib/jsonl.mjs";
import { sha256 } from "./lib/evidence.mjs";
import { checkConversionFidelity } from "./lib/store.mjs";

function have(tool) {
  try {
    execSync(`command -v ${tool}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Report a missing tool. Never install one — that changes the machine to suit us. */
function requireTool(tool) {
  if (have(tool)) return;
  process.stderr.write(
    `MISSING TOOL: ${tool} is not on PATH.\n` +
      `Install it yourself and re-run — nothing is installed on your behalf.\n` +
      `  pdftotext / pdfinfo   poppler-utils\n` +
      `  mutool                mupdf-tools\n`
  );
  process.exit(3);
}

function pdfPageCount(file) {
  requireTool("pdfinfo");
  const out = execFileSync("pdfinfo", [file], { encoding: "utf8" });
  const m = out.match(/^Pages:\s+(\d+)/m);
  if (!m) {
    process.stderr.write(
      `BLOCKED: pdfinfo did not report a page count for ${file}.\n` +
        `The page count is the denominator every coverage number is measured ` +
        `against. Without it, "fully extracted" cannot mean anything.\n`
    );
    process.exit(2);
  }
  return Number(m[1]);
}

function extractPdfPage(file, page) {
  return execFileSync("pdftotext", ["-f", String(page), "-l", String(page), "-layout", file, "-"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function docDir(root, slug) {
  return path.join(root, "sources", "converted", slug);
}

function convert(args) {
  const { root, slug, source } = args;
  const extractor = args.extractor || (source.toLowerCase().endsWith(".pdf") ? "pdftotext" : "text");

  if (!fs.existsSync(source)) {
    process.stderr.write(`BLOCKED: source '${source}' does not exist.\n`);
    process.exit(2);
  }

  // The original is recorded before anything reads it, and never modified.
  // Every locator in the finished library resolves back through this digest.
  const originalDir = path.join(root, "sources", "original");
  fs.mkdirSync(originalDir, { recursive: true });
  const kept = path.join(originalDir, path.basename(source));
  if (path.resolve(kept) !== path.resolve(source)) fs.copyFileSync(source, kept);
  const originalHash = sha256(fs.readFileSync(kept));

  const dir = docDir(root, slug);
  fs.mkdirSync(dir, { recursive: true });

  const pages = [];
  let extractorVersion = "unknown";

  if (extractor === "text") {
    const text = fs.readFileSync(source, "utf8");
    fs.writeFileSync(path.join(dir, "page-0001.txt"), text, "utf8");
    pages.push({
      page: 1,
      kind: "text",
      char_count: text.length,
      extractor: "text",
      extractor_version: process.version,
      text_sha256: sha256(Buffer.from(text, "utf8")),
    });
  } else if (extractor === "pdftotext") {
    requireTool("pdftotext");
    try {
      extractorVersion = String(execSync("pdftotext -v 2>&1 | head -1", { encoding: "utf8" })).trim();
    } catch {
      /* version is nice to have, not required */
    }
    const total = pdfPageCount(source);
    for (let p = 1; p <= total; p++) {
      const text = extractPdfPage(source, p);
      fs.writeFileSync(path.join(dir, `page-${String(p).padStart(4, "0")}.txt`), text, "utf8");
      pages.push({
        page: p,
        // `kind` starts unset on purpose for a PDF. Whether a thin page is
        // genuinely blank or a scanned image is not something the character
        // count can settle, and guessing it is the exact failure this tier
        // exists to prevent. The fidelity gate below forces the question.
        kind: text.trim().length ? "text" : null,
        char_count: text.length,
        extractor: "pdftotext",
        extractor_version: extractorVersion,
        text_sha256: sha256(Buffer.from(text, "utf8")),
      });
    }
  } else {
    process.stderr.write(`BLOCKED: unknown extractor '${extractor}' — use pdftotext or text.\n`);
    process.exit(2);
  }

  writeJsonl(path.join(dir, "pages.jsonl"), pages);
  fs.writeFileSync(
    path.join(dir, "source.json"),
    JSON.stringify(
      {
        slug,
        original: path.relative(root, kept),
        original_sha256: originalHash,
        extractor,
        extractor_version: extractorVersion,
        pages: pages.length,
        ingested_at: nowIso(),
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  process.stdout.write(`ingested          ${slug}\n`);
  process.stdout.write(`original sha256   ${originalHash}\n`);
  process.stdout.write(`pages             ${pages.length}\n`);
  process.stdout.write(`extractor         ${extractor} ${extractorVersion}\n`);
}

/**
 * Resolve a flagged page by declaring what it actually is. A declaration is a
 * human judgement recorded as data, which is the only thing that can settle
 * "is this page blank, or did the converter drop it?"
 */
function declare(args) {
  const { root, slug } = args;
  const spec = String(args.declare);
  const [kind, pageStr] = spec.split(":");
  const page = Number(pageStr);
  if (!["blank", "image", "mixed", "text", "gap"].includes(kind) || !Number.isFinite(page)) {
    process.stderr.write(`BLOCKED: --declare expects blank|image|mixed|text|gap:<page>\n`);
    process.exit(2);
  }

  const file = path.join(docDir(root, slug), "pages.jsonl");
  const pages = readJsonl(file);
  const row = pages.find((p) => p.page === page);
  if (!row) {
    process.stderr.write(`BLOCKED: ${slug} has no page ${page}\n`);
    process.exit(2);
  }

  if (kind === "gap") {
    if (!args.reason) {
      process.stderr.write(
        `BLOCKED: declaring a gap requires --reason. A gap that does not say what is ` +
          `missing is indistinguishable from a page nobody looked at.\n`
      );
      process.exit(2);
    }
    row.kind = row.kind || "image";
    row.gap = String(args.reason);
  } else if (kind === "blank") {
    row.kind = "text";
    row.declared_blank = true;
  } else {
    row.kind = kind;
    if (args.ocr) {
      row.ocr_engine = String(args.ocr);
      if (args["ocr-confidence"] === undefined) {
        process.stderr.write(
          `BLOCKED: --ocr requires --ocr-confidence. OCR is a transcription guess, ` +
            `and a guess whose uncertainty is not recorded reads as fact downstream.\n`
        );
        process.exit(2);
      }
      row.ocr_confidence = Number(args["ocr-confidence"]);
    }
  }

  writeJsonl(file, pages);
  process.stdout.write(`declared          ${slug} page ${page}: ${kind}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2), { root: "." });

  if (args.declare) {
    if (!args.slug) {
      process.stderr.write("BLOCKED: --declare needs --slug\n");
      process.exit(2);
    }
    declare(args);
  } else if (args.source) {
    if (!args.slug) {
      process.stderr.write("BLOCKED: --source needs --slug\n");
      process.exit(2);
    }
    convert(args);
  } else {
    process.stderr.write("usage: ingest.mjs --source FILE --slug SLUG [--extractor pdftotext|text]\n");
    process.exit(2);
  }

  const findings = checkConversionFidelity(args.root);
  if (!findings.length) {
    process.stdout.write("fidelity          no findings\n");
    return;
  }

  process.stderr.write(`\nCONVERSION GATE — ${findings.length} finding(s)\n\n`);
  for (const f of findings.slice(0, 40)) {
    process.stderr.write(`  ${f.kind}  ${f.doc} page ${f.page ?? "-"}\n    ${f.detail}\n`);
  }
  if (findings.length > 40) process.stderr.write(`  ... ${findings.length - 40} more\n`);
  process.stderr.write(
    `\nExtraction from these pages is refused until each is declared. A page that\n` +
      `is genuinely empty, a page that is a scan, and a page the converter dropped\n` +
      `all look identical from a character count — and only the third is a defect.\n` +
      `Resolve each with --declare, which records the judgement rather than\n` +
      `inferring it.\n`
  );
  process.exit(2);
}

main();
