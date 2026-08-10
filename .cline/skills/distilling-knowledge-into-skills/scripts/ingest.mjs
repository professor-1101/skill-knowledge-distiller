#!/usr/bin/env node
// ingest.mjs — turn a book into a converted, gated, page-addressable source.
//
// The risk here is counter-intuitive: **a failed conversion is loud and
// harmless; one that succeeds and is wrong reports as coverage.** A silently
// truncated book looks exactly like a thin one.
//
// Three mechanisms answer that, and none of them is "trust the tool":
//
//   1. A pinned extraction profile. The extractor's name AND version go into
//      the record, plus a fingerprint over the per-page output. Extractor
//      versions change their text, and changed text changes every downstream
//      excerpt_hash — so an unrecorded extractor makes the evidence chain
//      environment-scoped without saying so.
//   2. Conformance. `extractor-check.mjs` scores whichever extractor is
//      configured against fixtures with known-correct text, so quality is a
//      measured property rather than an assumption about the machine.
//   3. Cross-check. Where a second independent extractor is available, pages
//      where the two disagree are flagged. Two extractors agreeing is real
//      evidence; this is the ingestion tier's version of "every producer has
//      an adversary".
//
// The built-in extractor needs nothing installed and refuses rather than
// degrades. External ones are used when configured and reported as missing
// when not. Whichever produced the text, it faces the same gates.
//
//   node ingest.mjs --source book.pdf --slug my-book
//   node ingest.mjs --source book.pdf --slug my-book --extractor pdftotext
//   node ingest.mjs --source notes.md --slug my-book --extractor text
//   node ingest.mjs --slug my-book --declare blank:41
//   node ingest.mjs --slug my-book --declare image:88 --ocr tesseract --ocr-confidence 0.82
//   node ingest.mjs --slug my-book --declare gap:88 --reason "figure carries the content"
//
// Exit 0 clean, 2 when a gate blocks, 3 when a required tool is missing.

import fs from "node:fs";
import path from "node:path";
import { readJsonl, writeJsonl, nowIso, parseArgs } from "./lib/jsonl.mjs";
import { sha256 } from "./lib/evidence.mjs";
import { checkConversionFidelity, loadConfig } from "./lib/store.mjs";
import { choose, getExtractor } from "./lib/extractors.mjs";

const docDir = (root, slug) => path.join(root, "sources", "converted", slug);
const norm = (s) => String(s ?? "").replace(/\r/g, "").replace(/\s+/g, " ").trim();

/** Similarity on word multisets — robust to the layout differences between
 *  extractors, which reorder and re-wrap without changing what the page says. */
function similarity(a, b) {
  const wa = norm(a).toLowerCase().split(" ").filter(Boolean);
  const wb = norm(b).toLowerCase().split(" ").filter(Boolean);
  if (!wa.length && !wb.length) return 1;
  if (!wa.length || !wb.length) return 0;
  const count = new Map();
  for (const w of wa) count.set(w, (count.get(w) || 0) + 1);
  let shared = 0;
  for (const w of wb) {
    const n = count.get(w) || 0;
    if (n > 0) {
      shared++;
      count.set(w, n - 1);
    }
  }
  return (2 * shared) / (wa.length + wb.length);
}

function convert(args, config) {
  const { root, slug, source } = args;
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

  const isPdf = fs.readFileSync(kept).subarray(0, 5).toString("latin1") === "%PDF-";
  const wantText = args.extractor === "text" || (!isPdf && !args.extractor);

  let primaryId;
  let pages;
  let crossReport = null;

  if (wantText) {
    const text = fs.readFileSync(kept, "utf8");
    primaryId = `text@node-${process.version}`;
    pages = [{ page: 1, text, error: null }];
  } else {
    let primary, cross;
    try {
      ({ primary, cross } = choose(config, args.extractor));
    } catch (e) {
      process.stderr.write(`MISSING TOOL: ${e.message}\n`);
      process.exit(3);
    }
    primaryId = primary.describe();
    process.stdout.write(`extractor         ${primaryId}\n`);

    let result;
    try {
      result = primary.run(kept);
    } catch (e) {
      process.stderr.write(
        `BLOCKED: ${primary.name} could not read this document: ${e.message}\n` +
          `Refusing is correct — text produced from a document the extractor does not\n` +
          `understand looks like text and is not. Try another extractor, or record a gap.\n`
      );
      process.exit(2);
    }
    pages = result.pages;

    if (cross) {
      process.stdout.write(`cross-check       ${cross.describe()}\n`);
      try {
        const other = cross.run(kept);
        crossReport = comparePages(pages, other.pages, cross.describe(), config);
      } catch (e) {
        // A cross-check that cannot run is recorded, not silently skipped: the
        // absence of a second opinion is itself worth knowing later.
        crossReport = { extractor: cross.describe(), failed: e.message, disagreements: [] };
      }
    }
  }

  const rows = pages.map((p) => {
    const text = p.text;
    const file = path.join(dir, `page-${String(p.page).padStart(4, "0")}.txt`);
    fs.writeFileSync(file, text ?? "", "utf8");
    return {
      page: p.page,
      // `kind` starts unset for anything the extractor could not settle.
      // Whether a thin page is blank, a scan, or a dropped one is not
      // something a character count can decide, and guessing it is the exact
      // failure this tier exists to prevent.
      kind: p.error ? null : text && text.trim().length ? "text" : null,
      char_count: (text ?? "").length,
      extractor: primaryId,
      text_sha256: sha256(Buffer.from(text ?? "", "utf8")),
      extraction_error: p.error || undefined,
      cross_check: undefined,
    };
  });

  if (crossReport) {
    for (const d of crossReport.disagreements) {
      const row = rows.find((r) => r.page === d.page);
      if (row) row.cross_check = { extractor: crossReport.extractor, similarity: d.similarity };
    }
  }

  writeJsonl(path.join(dir, "pages.jsonl"), rows);

  // The fingerprint is what makes a re-ingest comparable. It covers the
  // per-page digests, so any change of extractor, version or flags produces a
  // different value — and the store can say so instead of quietly accepting
  // text that no longer matches the hashes its claims were built on.
  const manifestHash = sha256(
    Buffer.from(rows.map((r) => `${r.page}:${r.char_count}:${r.text_sha256}`).join("\n"), "utf8")
  );

  const profilePath = path.join(dir, "source.json");
  const previous = fs.existsSync(profilePath) ? JSON.parse(fs.readFileSync(profilePath, "utf8")) : null;

  const conformance = readConformance(root, primaryId);
  fs.writeFileSync(
    profilePath,
    JSON.stringify(
      {
        slug,
        original: path.relative(root, kept),
        original_sha256: originalHash,
        extractor_id: primaryId,
        conformance: conformance ?? "not measured — run extractor-check.mjs --record",
        manifest_sha256: manifestHash,
        pages: rows.length,
        cross_check: crossReport,
        ingested_at: nowIso(),
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  process.stdout.write(`ingested          ${slug}\n`);
  process.stdout.write(`original sha256   ${originalHash.slice(0, 16)}\n`);
  process.stdout.write(`manifest sha256   ${manifestHash.slice(0, 16)}\n`);
  process.stdout.write(`pages             ${rows.length}\n`);
  if (conformance) {
    process.stdout.write(`conformance       ${conformance.pass}/${conformance.of} fixtures\n`);
  } else {
    process.stdout.write(`conformance       NOT MEASURED — run: node extractor-check.mjs --record\n`);
  }

  if (previous && previous.manifest_sha256 !== manifestHash) {
    process.stderr.write(
      `\nRE-INGEST CHANGED THE TEXT\n` +
        `  was  ${previous.extractor_id}  ${previous.manifest_sha256.slice(0, 16)}\n` +
        `  now  ${primaryId}  ${manifestHash.slice(0, 16)}\n\n` +
        `Every excerpt_hash in the store was computed against the old text, so those\n` +
        `evidence chains no longer resolve. This is not a warning to click past:\n` +
        `re-extract the affected units, or restore the previous extractor.\n`
    );
    process.exitCode = 2;
  }

  return crossReport;
}

function comparePages(a, b, crossId, config) {
  const threshold = Number((config.extractors || {}).cross_check_threshold ?? 0.75);
  const disagreements = [];
  const byPage = new Map(b.map((p) => [p.page, p]));
  if (a.length !== b.length) {
    disagreements.push({
      page: null,
      similarity: 0,
      detail: `page counts differ: ${a.length} vs ${b.length}`,
    });
  }
  for (const p of a) {
    const q = byPage.get(p.page);
    if (!q) continue;
    // One refusing while the other produces text is the most informative case:
    // it usually means the confident one is guessing.
    if ((p.text === null) !== (q.text === null)) {
      disagreements.push({ page: p.page, similarity: 0, detail: "one extractor refused, the other did not" });
      continue;
    }
    if (p.text === null) continue;
    const s = similarity(p.text, q.text);
    if (s < threshold) {
      disagreements.push({ page: p.page, similarity: Number(s.toFixed(3)), detail: "text differs materially" });
    }
  }
  return { extractor: crossId, threshold, disagreements };
}

function readConformance(root, extractorId) {
  const f = path.join(root, "reports", "extractor-conformance.json");
  if (!fs.existsSync(f)) return null;
  try {
    const r = JSON.parse(fs.readFileSync(f, "utf8"));
    const hit = (r.extractors || []).find((e) => e.id === extractorId);
    return hit ? { pass: hit.pass, of: hit.of, checked_at: r.checked_at, suite: r.suite_sha256 } : null;
  } catch {
    return null;
  }
}

function declare(args) {
  const { root, slug } = args;
  const [kind, pageStr] = String(args.declare).split(":");
  const page = Number(pageStr);
  if (!["blank", "image", "mixed", "text", "gap"].includes(kind) || !Number.isFinite(page)) {
    process.stderr.write("BLOCKED: --declare expects blank|image|mixed|text|gap:<page>\n");
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
        "BLOCKED: declaring a gap requires --reason. A gap that does not say what is\n" +
          "missing is indistinguishable from a page nobody looked at.\n"
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
      if (args["ocr-confidence"] === undefined) {
        process.stderr.write(
          "BLOCKED: --ocr requires --ocr-confidence. OCR is a transcription guess, and a\n" +
            "guess whose uncertainty is not recorded reads as fact downstream.\n"
        );
        process.exit(2);
      }
      row.ocr_engine = String(args.ocr);
      row.ocr_confidence = Number(args["ocr-confidence"]);
    }
  }

  writeJsonl(file, pages);
  process.stdout.write(`declared          ${slug} page ${page}: ${kind}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2), { root: "." });
  let config = {};
  try {
    config = loadConfig(args.root);
  } catch (e) {
    process.stderr.write(`BLOCKED: ${e.message}\n`);
    process.exit(2);
  }

  if (args.extractor && args.extractor !== "text" && !getExtractor(args.extractor, config)) {
    process.stderr.write(`BLOCKED: unknown extractor '${args.extractor}'\n`);
    process.exit(2);
  }

  let crossReport = null;
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
    crossReport = convert(args, config);
  } else {
    process.stderr.write(
      "usage: ingest.mjs --source FILE --slug SLUG [--extractor builtin|pdftotext|mutool|text]\n" +
        "       ingest.mjs --slug SLUG --declare blank|image|mixed|gap:<page> [--reason ...]\n"
    );
    process.exit(2);
  }

  if (crossReport && crossReport.disagreements.length) {
    process.stderr.write(`\nCROSS-CHECK — ${crossReport.disagreements.length} page(s) where the two extractors disagree\n\n`);
    for (const d of crossReport.disagreements.slice(0, 20)) {
      process.stderr.write(`  page ${d.page ?? "-"}  similarity ${d.similarity}  ${d.detail}\n`);
    }
    process.stderr.write(
      `\nTwo independent extractors reading the same page should mostly agree. Where\n` +
        `they do not, one of them is wrong and the character count cannot say which.\n` +
        `Inspect those pages before extracting from them.\n`
    );
    process.exitCode = Math.max(process.exitCode || 0, 1);
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
    `\nExtraction from these pages is refused until each is declared. A page that is\n` +
      `genuinely empty, a page that is a scan, and a page the converter dropped all\n` +
      `look identical from a character count — and only the third is a defect.\n` +
      `Resolve each with --declare, which records the judgement rather than inferring it.\n`
  );
  process.exit(2);
}

main();
