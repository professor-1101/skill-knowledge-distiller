#!/usr/bin/env node
// enumerate.mjs — build the denominator from the book's own table of contents.
//
// R5 requires the manifest be transcribed from the source rather than recalled,
// and until now nothing implemented it: every script read `corpus.jsonl` and
// none produced it, so the one artifact every coverage number is measured
// against was whatever a person or a model typed. That is the "authored by
// judgement" failure the previous project died of, sitting at the root of the
// reconciliation.
//
// For EPUB it is genuinely transcription. The nav document (or NCX) states the
// units and their order; this reads them and writes them down. Nothing is
// invented, and a book whose navigation is missing produces a gap rather than
// a manufactured structure.
//
//   node enumerate.mjs --slug my-book [--depth 2] [--root .]
//   node enumerate.mjs --slug my-book --check      # compare, write nothing
//
// Exit 0 clean, 1 when the stored manifest disagrees with the book, 2 blocked.

import fs from "node:fs";
import path from "node:path";
import { readJsonl, writeJsonl, appendJsonl, nowIso, parseArgs, dumps } from "./lib/jsonl.mjs";
import { loadConfig } from "./lib/store.mjs";
import { openEpub, readToc, flattenToc } from "./lib/epub.mjs";

/**
 * Unit identifiers must be stable and ordered.
 *
 * Derived from the spine position and the entry's ordinal inside its document,
 * never from the title: a title changes with a typo fix, and every claim
 * pointing at the old id would be orphaned by a copy-edit.
 */
function unitId(slug, spineIndex, ordinal) {
  return `${slug}/s${String(spineIndex).padStart(3, "0")}/u${String(ordinal).padStart(2, "0")}`;
}

function build(root, slug, depth) {
  const profilePath = path.join(root, "sources", "converted", slug, "source.json");
  if (!fs.existsSync(profilePath)) {
    process.stderr.write(`BLOCKED: '${slug}' has not been ingested — run ingest.mjs first\n`);
    process.exit(2);
  }
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  const original = path.join(root, profile.original);
  if (!fs.existsSync(original)) {
    process.stderr.write(`BLOCKED: the ingested book '${profile.original}' is gone; the TOC cannot be re-read\n`);
    process.exit(2);
  }

  const book = openEpub(fs.readFileSync(original));
  const toc = readToc(book);
  const pages = readJsonl(path.join(root, "sources", "converted", slug, "pages.jsonl"));
  const spineOrder = new Map(book.spine.map((s, i) => [s.path, i]));

  const gaps = [];
  const rows = [];

  if (!toc.entries.length) {
    // No navigation is a real condition and gets recorded as one. Inventing a
    // structure here would produce a denominator that is confidently wrong,
    // which is worse than having none.
    gaps.push({
      unit: null,
      gap:
        `'${slug}' carries no usable table of contents (no nav document and no NCX), ` +
        `so units cannot be transcribed from the source. Enumeration is refused rather ` +
        `than invented; supply an EPUB with navigation, or accept spine-grain units.`,
      found_by: "enumerator",
      status: "open",
    });
    // Spine grain is the source's own coarser answer, so it is offered rather
    // than fabricated — one unit per document, which the book does state.
    book.spine.forEach((item, i) => {
      rows.push({
        unit: unitId(slug, i, 0),
        book: slug,
        title: (pages[i] && pages[i].nav_title) || item.path,
        href: item.path,
        fragment: null,
        spine_index: i,
        depth: 0,
        grain: "spine",
        status: "pending",
      });
    });
  } else {
    const flat = flattenToc(toc.entries, depth);
    const perDoc = new Map();
    for (const e of flat) {
      if (!e.href) continue;
      const si = spineOrder.get(e.href);
      if (si === undefined) {
        gaps.push({
          unit: null,
          gap: `the table of contents points at '${e.href}' ("${e.title}"), which is not in the spine`,
          found_by: "enumerator",
          status: "open",
        });
        continue;
      }
      const ordinal = perDoc.get(e.href) ?? 0;
      perDoc.set(e.href, ordinal + 1);
      rows.push({
        unit: unitId(slug, si, ordinal),
        book: slug,
        title: e.title,
        href: e.href,
        fragment: e.fragment || null,
        spine_index: si,
        depth: e.depth,
        grain: "toc",
        status: "pending",
      });
    }

    // A spine document the TOC never mentions still holds text, and text with
    // no unit is text no coverage number can see.
    book.spine.forEach((item, i) => {
      if (perDoc.has(item.path)) return;
      const page = pages[i];
      const hasProse = page && page.kind && page.kind !== "empty";
      rows.push({
        unit: unitId(slug, i, 0),
        book: slug,
        title: (page && page.nav_title) || item.path,
        href: item.path,
        fragment: null,
        spine_index: i,
        depth: 0,
        grain: "spine-fill",
        status: "pending",
      });
      if (hasProse) {
        gaps.push({
          unit: unitId(slug, i, 0),
          gap:
            `'${item.path}' carries content but the table of contents never names it. ` +
            `A unit was added at spine grain so its text is counted; the source's own ` +
            `structure does not cover it.`,
          found_by: "enumerator",
          status: "open",
        });
      }
    });
  }

  rows.sort((a, b) => a.spine_index - b.spine_index || a.unit.localeCompare(b.unit));
  return { rows, gaps, tocSource: toc.source, depth };
}

function main() {
  const args = parseArgs(process.argv.slice(2), { root: "." });
  if (!args.slug) {
    process.stderr.write("usage: enumerate.mjs --slug SLUG [--depth 2] [--check]\n");
    process.exit(2);
  }
  const config = loadConfig(args.root);
  const depth = Number(args.depth ?? (config.enumerate || {}).depth ?? 2);

  const { rows, gaps, tocSource } = build(args.root, args.slug, depth);
  const corpusPath = path.join(args.root, "corpus.jsonl");
  const existing = readJsonl(corpusPath);
  const mine = new Set(rows.map((r) => r.unit));
  const others = existing.filter((r) => r.book !== args.slug);
  const previous = existing.filter((r) => r.book === args.slug);

  process.stdout.write(`book              ${args.slug}\n`);
  process.stdout.write(`toc               ${tocSource || "none"}\n`);
  process.stdout.write(`depth             ${depth}\n`);
  process.stdout.write(`units             ${rows.length}\n`);
  if (gaps.length) process.stdout.write(`gaps              ${gaps.length}\n`);

  if (args.check) {
    const before = previous.map((r) => r.unit).sort();
    const after = [...mine].sort();
    const added = after.filter((u) => !before.includes(u));
    const removed = before.filter((u) => !after.includes(u));
    if (!added.length && !removed.length) {
      process.stdout.write("manifest          matches the book\n");
      return;
    }
    process.stderr.write(
      `\nMANIFEST DRIFT — the stored denominator no longer matches the book\n` +
        added.map((u) => `  + ${u}\n`).join("") +
        removed.map((u) => `  - ${u}\n`).join("")
    );
    process.exit(1);
  }

  // Status is derived elsewhere and must survive re-enumeration: a unit that
  // has been extracted does not go back to pending because the TOC was re-read.
  const carried = new Map(previous.map((r) => [r.unit, r]));
  const merged = rows.map((r) => {
    const old = carried.get(r.unit);
    return old ? { ...r, status: old.status ?? "pending" } : r;
  });

  writeJsonl(corpusPath, [...others, ...merged]);
  if (gaps.length) {
    const stamp = args["generated-at"] || nowIso();
    appendJsonl(path.join(args.root, "gaps.jsonl"), gaps.map((g) => ({ ...g, found_at: stamp })));
  }
  process.stdout.write(`written           ${corpusPath}\n`);

  const dropped = [...carried.keys()].filter((u) => !mine.has(u));
  if (dropped.length) {
    process.stderr.write(
      `\n${dropped.length} unit(s) present before are absent now. Any claim pointing at\n` +
        `them is orphaned:\n` + dropped.slice(0, 10).map((u) => `  ${u}\n`).join("")
    );
    process.exitCode = 1;
  }
}

main();
