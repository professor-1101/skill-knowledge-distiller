#!/usr/bin/env node
// ingest.mjs — turn an EPUB into a gated, addressable, digest-bearing store.
//
// A *segment* is one spine document: ordered, addressable, and carrying its own
// digest. It is the EPUB analogue of a page, and the store keeps the page
// vocabulary so every existing gate, locator and certificate line keeps
// working.
//
// Almost nothing here is declared by a human any more. `kind`, headings,
// media, titles and counts are all derived from the markup, because a field a
// person maintains is a field that drifts from the artifact it describes —
// which is how the previous project came to have chapters marked saturated
// while holding zero claims.
//
//   node ingest.mjs --source book.epub --slug my-book
//   node ingest.mjs --slug my-book --declare gap:12 --reason "figure carries the content"
//
// Exit 0 clean, 2 when a gate blocks, 3 when a required tool is missing.

import fs from "node:fs";
import path from "node:path";
import { readJsonl, writeJsonl, nowIso, parseArgs } from "./lib/jsonl.mjs";
import { sha256 } from "./lib/evidence.mjs";
import { checkConversionFidelity, loadConfig } from "./lib/store.mjs";
import { choose, getExtractor } from "./lib/extractors.mjs";
import { readToc, flattenToc, unreferencedResources } from "./lib/epub.mjs";

const docDir = (root, slug) => path.join(root, "sources", "converted", slug);

/**
 * A segment's kind, derived rather than declared.
 *
 * The distinction that matters is between a segment with no prose because it
 * carries a figure, and one with no prose because extraction lost it. The
 * first is a fact about the book; the second is a defect. Markup can tell them
 * apart, which is why the PDF-era human declaration flow is gone.
 */
function deriveKind(page) {
  if (page.error) return null;
  const hasText = Boolean((page.text || "").trim());
  const hasMedia = (page.media || []).length > 0;
  if (hasText && hasMedia) return "mixed";
  if (hasText) return "text";
  if (hasMedia) return "image";
  return "empty";
}

/** The nav title covering a segment, so a reader can name it without the TOC open. */
function titleFor(page, tocFlat) {
  const hit = tocFlat.find((t) => t.href === page.href);
  if (hit) return hit.title;
  const h = (page.headings || [])[0];
  return h ? h.title : null;
}

function convert(args, config) {
  const { root, slug, source } = args;
  if (!fs.existsSync(source)) {
    process.stderr.write(`BLOCKED: source '${source}' does not exist.\n`);
    process.exit(2);
  }

  const head = Buffer.alloc(4);
  const fd = fs.openSync(source, "r");
  fs.readSync(fd, head, 0, 4, 0);
  fs.closeSync(fd);
  if (head.toString("latin1") !== "PK") {
    process.stderr.write(
      `BLOCKED: '${source}' is not a ZIP container, so it is not an EPUB.\n` +
        `EPUB is the only supported format — there is no fallback. A PDF has no\n` +
        `reading order, headings or table of contents to recover, so every one of\n` +
        `those would have to be inferred, and an inference that reads well is the\n` +
        `failure this pipeline exists to prevent.\n`
    );
    process.exit(2);
  }

  // The original is recorded before anything reads it, and never modified.
  const originalDir = path.join(root, "sources", "original");
  fs.mkdirSync(originalDir, { recursive: true });
  const kept = path.join(originalDir, path.basename(source));
  if (path.resolve(kept) !== path.resolve(source)) fs.copyFileSync(source, kept);
  const originalHash = sha256(fs.readFileSync(kept));

  let primary;
  try {
    ({ primary } = choose(config, args.extractor));
  } catch (e) {
    process.stderr.write(`MISSING TOOL: ${e.message}\n`);
    process.exit(3);
  }

  let result;
  try {
    result = primary.run(kept);
  } catch (e) {
    process.stderr.write(
      `BLOCKED: ${primary.name} refused this book.\n\n  ${e.message}\n\n` +
        `Refusing is correct. Text recovered from a book the extractor does not\n` +
        `fully understand looks like text and is not.\n`
    );
    process.exit(2);
  }

  const dir = docDir(root, slug);
  fs.mkdirSync(dir, { recursive: true });

  const toc = result.book ? readToc(result.book) : { source: null, entries: [] };
  const tocFlat = flattenToc(toc.entries, 99);

  const rows = result.pages.map((p) => {
    const text = p.text;
    fs.writeFileSync(path.join(dir, `page-${String(p.page).padStart(4, "0")}.txt`), text ?? "", "utf8");
    const row = {
      page: p.page,
      locator_scheme: "epub-spine",
      href: p.href ?? null,
      spine_index: p.spine_index ?? p.page - 1,
      linear: p.linear !== false,
      kind: deriveKind(p),
      nav_title: titleFor(p, tocFlat),
      char_count: (text ?? "").length,
      text_sha256: sha256(Buffer.from(text ?? "", "utf8")),
      headings: (p.headings || []).map((h) => ({ level: h.level, title: h.title, offset: h.offset })),
      anchors: (p.anchors || []).map((a) => ({ id: a.id, offset: a.offset })),
      media: (p.media || []).map((m) => ({ kind: m.kind, src: m.src, alt: m.alt ?? null, offset: m.offset })),
      extractor: result.id,
    };
    if (p.error) row.extraction_error = p.error;
    return row;
  });

  writeJsonl(path.join(dir, "pages.jsonl"), rows);

  // The fingerprint covers every segment digest, so any change of extractor or
  // version produces a different value and the store can say so rather than
  // quietly accepting text the existing hashes were not built on.
  const manifestHash = sha256(
    Buffer.from(rows.map((r) => `${r.page}:${r.href}:${r.char_count}:${r.text_sha256}`).join("\n"), "utf8")
  );

  const profilePath = path.join(dir, "source.json");
  const previous = fs.existsSync(profilePath) ? JSON.parse(fs.readFileSync(profilePath, "utf8")) : null;
  const conformance = readConformance(root, result.id);
  const orphans = result.book ? unreferencedResources(result.book, result.pages) : [];

  fs.writeFileSync(
    profilePath,
    JSON.stringify(
      {
        slug,
        format: "epub",
        original: path.relative(root, kept),
        original_sha256: originalHash,
        extractor_id: result.id,
        conformance: conformance ?? "not measured — run extractor-check.mjs --record",
        manifest_sha256: manifestHash,
        segments: rows.length,
        metadata: result.book ? result.book.metadata : null,
        toc_source: toc.source,
        toc_entries: tocFlat.length,
        unreferenced_resources: orphans,
        ingested_at: nowIso(),
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  process.stdout.write(`ingested          ${slug}\n`);
  process.stdout.write(`extractor         ${result.id}\n`);
  process.stdout.write(`original sha256   ${originalHash.slice(0, 16)}\n`);
  process.stdout.write(`manifest sha256   ${manifestHash.slice(0, 16)}\n`);
  process.stdout.write(`segments          ${rows.length}\n`);
  process.stdout.write(`toc               ${toc.source || "none"} (${tocFlat.length} entries)\n`);
  process.stdout.write(
    conformance
      ? `conformance       ${conformance.pass}/${conformance.of} fixtures\n`
      : `conformance       NOT MEASURED — run: node extractor-check.mjs --record\n`
  );
  if (orphans.length) {
    process.stdout.write(
      `unreferenced      ${orphans.length} manifest resource(s) the spine never reaches\n`
    );
  }

  if (previous && previous.manifest_sha256 !== manifestHash) {
    process.stderr.write(
      `\nRE-INGEST CHANGED THE TEXT\n` +
        `  was  ${previous.extractor_id}  ${previous.manifest_sha256.slice(0, 16)}\n` +
        `  now  ${result.id}  ${manifestHash.slice(0, 16)}\n\n` +
        `Every excerpt_hash in the store was computed against the old text, so those\n` +
        `evidence chains no longer resolve. Re-extract the affected units, or restore\n` +
        `the previous extractor.\n`
    );
    process.exitCode = 2;
  }
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

/**
 * The one thing still declared by a human, and only one.
 *
 * A segment carrying a figure that holds the content has no prose to extract
 * and no defect to report. Only a person can say that the missing words matter
 * and why, so that judgement is recorded as data rather than inferred.
 */
function declare(args) {
  const { root, slug } = args;
  const [kind, pageStr] = String(args.declare).split(":");
  const page = Number(pageStr);
  if (kind !== "gap" || !Number.isFinite(page)) {
    process.stderr.write(
      "BLOCKED: --declare expects gap:<segment>. Every other segment property is\n" +
        "derived from the markup and is not yours to set.\n"
    );
    process.exit(2);
  }
  if (!args.reason) {
    process.stderr.write(
      "BLOCKED: declaring a gap requires --reason. A gap that does not say what is\n" +
        "missing is indistinguishable from a segment nobody looked at.\n"
    );
    process.exit(2);
  }

  const file = path.join(docDir(root, slug), "pages.jsonl");
  const pages = readJsonl(file);
  const row = pages.find((p) => p.page === page);
  if (!row) {
    process.stderr.write(`BLOCKED: ${slug} has no segment ${page}\n`);
    process.exit(2);
  }
  row.gap = String(args.reason);
  writeJsonl(file, pages);
  process.stdout.write(`declared          ${slug} segment ${page}: gap\n`);
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

  if (args.extractor && !getExtractor(args.extractor, config)) {
    process.stderr.write(`BLOCKED: unknown extractor '${args.extractor}'\n`);
    process.exit(2);
  }

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
    convert(args, config);
  } else {
    process.stderr.write(
      "usage: ingest.mjs --source BOOK.epub --slug SLUG [--extractor NAME]\n" +
        "       ingest.mjs --slug SLUG --declare gap:<segment> --reason '...'\n"
    );
    process.exit(2);
  }

  const findings = checkConversionFidelity(args.root);
  if (!findings.length) {
    process.stdout.write("fidelity          no findings\n");
    return;
  }

  process.stderr.write(`\nCONVERSION GATE — ${findings.length} finding(s)\n\n`);
  for (const f of findings.slice(0, 40)) {
    process.stderr.write(`  ${f.kind}  ${f.doc} segment ${f.page ?? "-"}\n    ${f.detail}\n`);
  }
  if (findings.length > 40) process.stderr.write(`  ... ${findings.length - 40} more\n`);
  process.exit(2);
}

main();
