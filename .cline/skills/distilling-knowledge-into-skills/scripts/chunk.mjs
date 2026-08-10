#!/usr/bin/env node
// chunk.mjs — cut a converted document into extraction-sized, addressable spans.
//
// Two jobs, and the second is the one that matters.
//
// The first is practical: a book exceeds any context window, so extraction
// happens over spans. The previous run learned the sizing rule the hard way —
// chapter grain put 110 claims in one unit and hid everything behind a single
// status flag, while too fine a grain buys bookkeeping and no recall. One
// probe round yielding ten to forty claims is the window.
//
// The second is the coverage guarantee. Chunks must **tile** the document:
// cover every character exactly once, with any overlap declared. Without that
// invariant, "the book is fully extracted" is measured against a denominator
// that silently omits whatever never became a chunk — and a region belonging
// to no chunk reports as covered rather than as missing.
//
//   node chunk.mjs --slug my-book [--root .] [--target-chars 6000] [--overlap 0]
//   node chunk.mjs --slug my-book --check
//
// Exit 0 clean, 2 when the tiling invariant fails.

import fs from "node:fs";
import path from "node:path";
import { readJsonl, writeJsonl, parseArgs } from "./lib/jsonl.mjs";
import { sha256 } from "./lib/evidence.mjs";
import { checkChunkTiling } from "./lib/store.mjs";

function pageText(dir, page) {
  const file = path.join(dir, `page-${String(page).padStart(4, "0")}.txt`);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function build(root, slug, targetChars, overlap) {
  const dir = path.join(root, "sources", "converted", slug);
  const pages = readJsonl(path.join(dir, "pages.jsonl"));
  if (!pages.length) {
    process.stderr.write(`BLOCKED: ${slug} has no pages.jsonl — run ingest.mjs first\n`);
    process.exit(2);
  }

  const unhandled = pages.filter((p) => !p.kind);
  if (unhandled.length) {
    process.stderr.write(
      `BLOCKED: ${unhandled.length} page(s) in ${slug} have no declared kind.\n` +
        `Chunking an undeclared page bakes a possible conversion loss into the\n` +
        `denominator, where nothing downstream can see it. Declare them first:\n` +
        `  node ingest.mjs --slug ${slug} --declare blank:<page>\n`
    );
    process.exit(2);
  }

  // One continuous character space across the document, so a chunk boundary is
  // a pair of absolute offsets and a locator resolves without reconstructing
  // page layout.
  let cursor = 0;
  const spans = pages.map((p) => {
    const text = pageText(dir, p.page);
    const span = { page: p.page, start: cursor, end: cursor + text.length, text };
    cursor += text.length;
    return span;
  });
  const totalChars = cursor;

  const chunks = [];
  let start = 0;
  let n = 0;
  while (start < totalChars) {
    let end = Math.min(start + targetChars, totalChars);

    // Prefer a paragraph boundary inside the last 20% of the window. A chunk
    // that ends mid-sentence produces claims whose evidence span is a fragment,
    // and a fragment cannot be verified against the source by eye.
    if (end < totalChars) {
      const windowStart = start + Math.floor(targetChars * 0.8);
      const slice = sliceAll(spans, windowStart, end);
      const br = slice.lastIndexOf("\n\n");
      if (br > 0) end = windowStart + br + 2;
    }

    const text = sliceAll(spans, start, end);
    const first = spans.find((s) => s.end > start) || spans[0];
    const last = [...spans].reverse().find((s) => s.start < end) || spans[spans.length - 1];

    n += 1;
    chunks.push({
      id: `${slug}/k${String(n).padStart(4, "0")}`,
      doc: slug,
      page_start: first.page,
      page_end: last.page,
      char_start: start,
      char_end: end,
      chars: end - start,
      sha256: sha256(Buffer.from(text, "utf8")),
      overlap_declared: overlap > 0 && start > 0 ? true : undefined,
      unit: null,
    });

    if (end >= totalChars) break;
    start = overlap > 0 ? Math.max(end - overlap, start + 1) : end;
  }

  writeJsonl(path.join(dir, "chunks.jsonl"), chunks);
  process.stdout.write(`document          ${slug}\n`);
  process.stdout.write(`characters        ${totalChars}\n`);
  process.stdout.write(`chunks            ${chunks.length}  (target ${targetChars}, overlap ${overlap})\n`);
  return chunks.length;
}

function sliceAll(spans, from, to) {
  let out = "";
  for (const s of spans) {
    if (s.end <= from || s.start >= to) continue;
    out += s.text.slice(Math.max(0, from - s.start), Math.min(s.text.length, to - s.start));
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    root: ".",
    "target-chars": "6000",
    overlap: "0",
  });

  if (!args.check) {
    if (!args.slug) {
      process.stderr.write("usage: chunk.mjs --slug SLUG [--target-chars N] [--overlap N] | --check\n");
      process.exit(2);
    }
    build(args.root, args.slug, Number(args["target-chars"]), Number(args.overlap));
  }

  const findings = checkChunkTiling(args.root);
  if (!findings.length) {
    process.stdout.write("tiling            covers the source exactly once\n");
    return;
  }

  process.stderr.write(`\nCHUNK COVERAGE — ${findings.length} defect(s)\n\n`);
  for (const f of findings.slice(0, 40)) {
    process.stderr.write(`  ${f.kind}  ${f.doc}\n    ${f.detail}\n`);
  }
  process.stderr.write(
    `\nCoverage cannot be measured against a chunk set that omits part of the\n` +
      `source: the missing region reports as covered rather than as missing.\n`
  );
  process.exit(2);
}

main();
