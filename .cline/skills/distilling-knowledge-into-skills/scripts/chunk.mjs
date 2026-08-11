#!/usr/bin/env node
// chunk.mjs — cut the converted book into extraction-sized, addressable spans.
//
// Three properties, and each was a defect before.
//
// **Stable identity.** Chunk ids used to be positional — `k0001`, `k0002` — so
// inserting anything upstream renumbered every chunk after it and silently
// orphaned every claim that referenced one. Ids are now derived from the spine
// index and an ordinal within that document, so a chunk keeps its name unless
// its own document changes.
//
// **Unit linkage.** The chunker used to write `unit: null` and nothing ever
// filled it, leaving the chain document → unit → claim broken exactly where
// extraction happens. A chunk now resolves to the unit whose TOC entry covers
// its start offset, and a chunk that resolves to none is an error rather than
// a null.
//
// **Tiling.** Chunks cover each document exactly once, with any overlap
// declared. Without it, coverage is measured against a denominator that omits
// whatever never became a chunk, and that region reports as covered.
//
//   node chunk.mjs --slug my-book [--target-chars 6000] [--overlap 0]
//   node chunk.mjs --check
//
// Exit 0 clean, 2 when an invariant fails.

import fs from "node:fs";
import path from "node:path";
import { readJsonl, writeJsonl, parseArgs } from "./lib/jsonl.mjs";
import { sha256 } from "./lib/evidence.mjs";
import { checkChunkTiling, checkChunkUnits, loadConfig } from "./lib/store.mjs";

const segFile = (dir, page) => path.join(dir, `page-${String(page).padStart(4, "0")}.txt`);

/**
 * The unit covering an offset inside a document.
 *
 * TOC entries with a fragment start at that anchor; entries without one start
 * at the top of the document. The last entry starting at or before the offset
 * owns it, which is what "this text is under that heading" means.
 */
function unitAt(units, page, offset) {
  const candidates = units
    .filter((u) => u.href === page.href)
    .map((u) => {
      if (!u.fragment) return { unit: u.unit, start: 0 };
      const a = (page.anchors || []).find((x) => x.id === u.fragment);
      // A TOC entry pointing at an anchor the document does not have cannot be
      // placed. Returning null keeps it out rather than defaulting it to zero,
      // which would silently claim text it does not cover.
      return a ? { unit: u.unit, start: a.offset } : null;
    })
    .filter(Boolean)
    .sort((x, y) => x.start - y.start);

  let owner = null;
  for (const c of candidates) {
    if (c.start <= offset) owner = c;
    else break;
  }
  return owner ? owner.unit : candidates.length ? candidates[0].unit : null;
}

function build(root, slug, targetChars, overlap) {
  const dir = path.join(root, "sources", "converted", slug);
  const pages = readJsonl(path.join(dir, "pages.jsonl"));
  if (!pages.length) {
    process.stderr.write(`BLOCKED: ${slug} has no pages.jsonl — run ingest.mjs first\n`);
    process.exit(2);
  }
  const unresolved = pages.filter((p) => p.extraction_error && !p.gap);
  if (unresolved.length) {
    process.stderr.write(
      `BLOCKED: ${unresolved.length} segment(s) in ${slug} were refused by the extractor and\n` +
        `have no declared gap. Chunking around them would bake a hole into the\n` +
        `denominator where nothing downstream can see it.\n`
    );
    process.exit(2);
  }

  const units = readJsonl(path.join(root, "corpus.jsonl")).filter((u) => u.book === slug);
  if (!units.length) {
    process.stderr.write(
      `BLOCKED: no units for '${slug}' in corpus.jsonl — run enumerate.mjs first.\n` +
        `Chunks must resolve to units, and there are none to resolve to.\n`
    );
    process.exit(2);
  }

  // One continuous character space across the book, so a locator resolves
  // without reconstructing per-document layout.
  let cursor = 0;
  const spans = pages.map((p) => {
    const text = fs.existsSync(segFile(dir, p.page)) ? fs.readFileSync(segFile(dir, p.page), "utf8") : "";
    const span = { page: p, start: cursor, end: cursor + text.length, text };
    cursor += text.length;
    return span;
  });

  const chunks = [];
  for (const span of spans) {
    if (!span.text.length) continue;
    const local = span.text;
    // Prefer a heading boundary, then a paragraph break: a chunk that ends
    // mid-sentence produces claims whose evidence span is a fragment, and a
    // fragment cannot be checked against the source by eye.
    const stops = (span.page.headings || []).map((h) => h.offset).filter((o) => o > 0).sort((a, b) => a - b);
    let start = 0;
    let ordinal = 0;

    while (start < local.length) {
      let end = Math.min(start + targetChars, local.length);
      if (end < local.length) {
        const window = start + Math.floor(targetChars * 0.6);
        const heading = stops.filter((o) => o > window && o <= end).pop();
        if (heading) {
          end = heading;
        } else {
          const br = local.lastIndexOf("\n", end);
          if (br > window) end = br + 1;
        }
      }

      const text = local.slice(start, end);
      const absStart = span.start + start;
      chunks.push({
        id: `${slug}/s${String(span.page.spine_index ?? span.page.page - 1).padStart(3, "0")}/k${String(ordinal).padStart(3, "0")}`,
        doc: slug,
        page: span.page.page,
        href: span.page.href,
        locator: `${span.page.href}@${start}-${end}`,
        char_start: absStart,
        char_end: span.start + end,
        chars: end - start,
        sha256: sha256(Buffer.from(text, "utf8")),
        unit: unitAt(units, span.page, start),
        overlap_declared: overlap > 0 && start > 0 ? true : undefined,
      });

      ordinal += 1;
      if (end >= local.length) break;
      start = overlap > 0 ? Math.max(end - overlap, start + 1) : end;
    }
  }

  writeJsonl(path.join(dir, "chunks.jsonl"), chunks);
  const orphaned = chunks.filter((c) => !c.unit).length;
  process.stdout.write(`document          ${slug}\n`);
  process.stdout.write(`characters        ${cursor}\n`);
  process.stdout.write(`chunks            ${chunks.length}  (target ${targetChars}, overlap ${overlap})\n`);
  process.stdout.write(`units linked      ${chunks.length - orphaned}/${chunks.length}\n`);
  return chunks.length;
}

function main() {
  const args = parseArgs(process.argv.slice(2), { root: "." });
  const config = loadConfig(args.root);
  const target = Number(args["target-chars"] ?? (config.chunk || {}).target_chars ?? 6000);
  const overlap = Number(args.overlap ?? (config.chunk || {}).overlap ?? 0);

  if (!args.check) {
    if (!args.slug) {
      process.stderr.write("usage: chunk.mjs --slug SLUG [--target-chars N] [--overlap N] | --check\n");
      process.exit(2);
    }
    build(args.root, args.slug, target, overlap);
  }

  const tiling = checkChunkTiling(args.root);
  const unlinked = checkChunkUnits(args.root);

  if (!tiling.length && !unlinked.length) {
    process.stdout.write("tiling            covers the source exactly once\n");
    process.stdout.write("linkage           every chunk resolves to a unit\n");
    return;
  }

  if (tiling.length) {
    process.stderr.write(`\nCHUNK COVERAGE — ${tiling.length} defect(s)\n\n`);
    for (const f of tiling.slice(0, 40)) process.stderr.write(`  ${f.kind}  ${f.doc}\n    ${f.detail}\n`);
    process.stderr.write(
      `\nCoverage cannot be measured against a chunk set that omits part of the\n` +
        `source: the missing region reports as covered rather than as missing.\n`
    );
  }
  if (unlinked.length) {
    process.stderr.write(`\nCHUNK LINKAGE — ${unlinked.length} defect(s)\n\n`);
    for (const f of unlinked.slice(0, 40)) process.stderr.write(`  ${f.doc}  ${f.detail}\n`);
  }
  process.exit(2);
}

main();
