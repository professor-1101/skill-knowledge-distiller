// store.mjs — invariants that hold over the whole store rather than one row.
//
// A per-row validator cannot see the failures that matter most here. A claim
// can be perfectly formed and still belong to a unit that does not exist; a
// chunk set can be individually valid and still leave a thousand characters of
// the source belonging to nothing. Those are set properties, and this is where
// they are checked.

import fs from "node:fs";
import path from "node:path";
import { readJsonl, collectClaims } from "./jsonl.mjs";
import { sha256 } from "./evidence.mjs";

/**
 * The hard invariant: claims − dispositions = ∅.
 *
 * Refinement compresses roughly ten to one. Without a recorded fate per claim,
 * that compression is an accident rather than a decision, and nobody can tell
 * afterwards which it was.
 */
export function checkDispositionCoverage(root) {
  const claims = collectClaims(root);
  const dispositions = readJsonl(path.join(root, "dispositions.jsonl"));
  const claimIds = new Set(claims.map((c) => c.id));
  const disposed = new Set(dispositions.map((d) => d.claim));
  const undisposed = [...claimIds].filter((id) => !disposed.has(id));
  const orphaned = [...disposed].filter((id) => id && !claimIds.has(id));
  return { total: claimIds.size, undisposed, orphaned };
}

/**
 * Chunks must tile their document's converted text exactly once: no unclaimed
 * spans, no undeclared overlap.
 *
 * This is the gate the previous project had no equivalent of, because it
 * consumed exports that were already text. It matters because "the book is
 * fully extracted" is a claim about coverage, and coverage measured against a
 * chunk set that silently omits a region is measuring the wrong denominator.
 * A page that never became a chunk reports as covered.
 */
export function checkChunkTiling(root) {
  const findings = [];
  const chunksDir = path.join(root, "sources", "converted");
  if (!fs.existsSync(chunksDir)) return findings;

  for (const doc of fs.readdirSync(chunksDir).sort()) {
    const chunkFile = path.join(chunksDir, doc, "chunks.jsonl");
    const pageFile = path.join(chunksDir, doc, "pages.jsonl");
    if (!fs.existsSync(chunkFile)) continue;

    const chunks = readJsonl(chunkFile)
      .filter((c) => Number.isFinite(c.char_start) && Number.isFinite(c.char_end))
      .sort((a, b) => a.char_start - b.char_start);
    if (!chunks.length) {
      findings.push({ doc, kind: "no-chunks", detail: "chunks.jsonl holds no positioned chunks" });
      continue;
    }

    const pages = readJsonl(pageFile);
    const totalChars = pages.reduce((n, p) => n + (Number(p.char_count) || 0), 0);

    if (chunks[0].char_start !== 0) {
      findings.push({
        doc,
        kind: "unclaimed-head",
        detail: `the first ${chunks[0].char_start} characters belong to no chunk`,
      });
    }

    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1];
      const cur = chunks[i];
      if (cur.char_start > prev.char_end) {
        findings.push({
          doc,
          kind: "gap",
          detail: `${cur.char_start - prev.char_end} characters between ${prev.id} and ${cur.id} belong to no chunk`,
        });
      } else if (cur.char_start < prev.char_end && !cur.overlap_declared) {
        findings.push({
          doc,
          kind: "undeclared-overlap",
          detail: `${prev.char_end - cur.char_start} characters shared by ${prev.id} and ${cur.id} without overlap_declared`,
        });
      }
    }

    const last = chunks[chunks.length - 1];
    if (totalChars && last.char_end < totalChars) {
      findings.push({
        doc,
        kind: "unclaimed-tail",
        detail: `the last ${totalChars - last.char_end} characters belong to no chunk`,
      });
    }
  }

  return findings;
}

/**
 * Conversion fidelity, for a format where it can be checked rather than guessed.
 *
 * The PDF-era version compared each page against the document median and
 * flagged anything far below it. That heuristic existed because a PDF gives no
 * way to tell a blank page from a dropped one — and it would misfire constantly
 * on an EPUB, where a title page of 90 characters legitimately sits beside a
 * chapter of 40,000.
 *
 * It is gone. For EPUB the extractor reconciles its output against the source
 * markup at ingest, so a lost text node is already a refusal. What remains here
 * are the conditions markup can state and extraction cannot resolve alone.
 */
export function checkConversionFidelity(root) {
  const findings = [];
  const base = path.join(root, "sources", "converted");
  if (!fs.existsSync(base)) return findings;

  for (const doc of fs.readdirSync(base).sort()) {
    const pages = readJsonl(path.join(base, doc, "pages.jsonl"));
    if (!pages.length) continue;

    for (const p of pages) {
      if (p.extraction_error && !p.gap) {
        findings.push({
          doc,
          page: p.page,
          kind: "extraction-refused",
          detail:
            `segment ${p.page}: the extractor refused (${p.extraction_error}) and nothing ` +
            `has been declared for it. A refusal is the honest outcome, but an ` +
            `undeclared one is still a segment nobody accounted for`,
        });
      }
      if (!p.kind && !p.extraction_error) {
        findings.push({
          doc,
          page: p.page,
          kind: "underived-kind",
          detail:
            `segment ${p.page} has no 'kind'. It is derived from the markup, so an ` +
            `absent value means the row was written by something other than ingest`,
        });
      }
      // A segment with neither prose nor media carries nothing. That is
      // usually a real front-matter page, but it is never something to assume:
      // it contributes zero to coverage while counting as a segment.
      if (p.kind === "empty" && !p.gap) {
        findings.push({
          doc,
          page: p.page,
          kind: "empty-segment",
          detail:
            `segment ${p.page} (${p.href || "?"}) holds neither prose nor media. ` +
            `Declare it with --declare gap if that is what the book contains, so it ` +
            `is a recorded fact rather than an unexplained hole`,
        });
      }
      // An image-only segment is a fact about the book, not a defect — but the
      // words in that figure are not in the store, and that has to be visible.
      if (p.kind === "image" && !p.gap) {
        findings.push({
          doc,
          page: p.page,
          kind: "image-only-segment",
          detail:
            `segment ${p.page} carries ${(p.media || []).length} figure(s) and no prose. ` +
            `Whatever those figures say is not in the store; record a gap so the ` +
            `absence is measured rather than assumed empty`,
        });
      }
    }
  }

  return findings;
}

/**
 * Every chunk must belong to a unit.
 *
 * The chain document → unit → claim is what the certificate reconciles against.
 * A chunk with no unit is a span of the book that extraction can read and
 * coverage cannot see, and it used to be the default: the chunker wrote `null`
 * and nothing ever filled it.
 */
export function checkChunkUnits(root) {
  const findings = [];
  const base = path.join(root, "sources", "converted");
  if (!fs.existsSync(base)) return findings;
  const units = new Set(readJsonl(path.join(root, "corpus.jsonl")).map((u) => u.unit).filter(Boolean));

  for (const doc of fs.readdirSync(base).sort()) {
    const file = path.join(base, doc, "chunks.jsonl");
    if (!fs.existsSync(file)) continue;
    for (const c of readJsonl(file)) {
      if (!c.unit && !c.gap) {
        findings.push({
          doc,
          chunk: c.id,
          detail: `chunk ${c.id} belongs to no unit — coverage cannot see the text it holds`,
        });
      } else if (c.unit && units.size && !units.has(c.unit)) {
        findings.push({
          doc,
          chunk: c.id,
          detail: `chunk ${c.id} names unit '${c.unit}', which the manifest does not contain`,
        });
      }
    }
  }
  return findings;
}

/**
 * Recompute every recorded digest and compare.
 *
 * Provenance that is written once and never re-checked is recorded, not
 * verified. Edit a segment file and every chunk offset and downstream
 * excerpt_hash silently stops matching, with every other gate still green.
 */
export function verifyDigests(root) {
  const findings = [];
  const base = path.join(root, "sources", "converted");
  if (!fs.existsSync(base)) return findings;

  for (const doc of fs.readdirSync(base).sort()) {
    const dir = path.join(base, doc);
    const pages = readJsonl(path.join(dir, "pages.jsonl"));

    for (const p of pages) {
      const file = path.join(dir, `page-${String(p.page).padStart(4, "0")}.txt`);
      if (!fs.existsSync(file)) {
        findings.push({ doc, page: p.page, kind: "segment-missing", detail: `${path.basename(file)} is gone` });
        continue;
      }
      const text = fs.readFileSync(file, "utf8");
      if (p.text_sha256 && sha256(Buffer.from(text, "utf8")) !== p.text_sha256) {
        findings.push({
          doc,
          page: p.page,
          kind: "segment-digest",
          detail: `${path.basename(file)} no longer matches its recorded digest — it has been edited since ingest`,
        });
      }
      if (Number.isFinite(p.char_count) && text.length !== p.char_count) {
        findings.push({
          doc,
          page: p.page,
          kind: "segment-length",
          detail:
            `${path.basename(file)} is ${text.length} characters, recorded as ${p.char_count}. ` +
            `Chunk offsets are measured against the recorded value, so tiling is now fiction`,
        });
      }
    }

    const profilePath = path.join(dir, "source.json");
    if (fs.existsSync(profilePath)) {
      let profile = null;
      try {
        profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
      } catch (e) {
        findings.push({ doc, kind: "profile-unreadable", detail: `source.json is not valid JSON (${e.message})` });
      }
      if (profile) {
        const recomputed = sha256(
          Buffer.from(
            pages.map((r) => `${r.page}:${r.href}:${r.char_count}:${r.text_sha256}`).join("\n"),
            "utf8"
          )
        );
        if (profile.manifest_sha256 && profile.manifest_sha256 !== recomputed) {
          findings.push({
            doc,
            kind: "manifest-digest",
            detail: "pages.jsonl no longer matches the manifest fingerprint recorded at ingest",
          });
        }
        const original = profile.original ? path.join(root, profile.original) : null;
        if (original && fs.existsSync(original)) {
          if (profile.original_sha256 && sha256(fs.readFileSync(original)) !== profile.original_sha256) {
            findings.push({
              doc,
              kind: "original-digest",
              detail: `${profile.original} is not the file that was ingested — the root of every evidence chain has changed`,
            });
          }
        } else if (original) {
          findings.push({ doc, kind: "original-missing", detail: `${profile.original} is gone; nothing can be verified against it` });
        }
      }
    }

    const chunkFile = path.join(dir, "chunks.jsonl");
    if (fs.existsSync(chunkFile)) {
      const text = pages
        .map((p) => {
          const f = path.join(dir, `page-${String(p.page).padStart(4, "0")}.txt`);
          return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
        })
        .join("");
      for (const c of readJsonl(chunkFile)) {
        if (!c.sha256 || !Number.isFinite(c.char_start)) continue;
        const span = text.slice(c.char_start, c.char_end);
        if (sha256(Buffer.from(span, "utf8")) !== c.sha256) {
          findings.push({
            doc,
            chunk: c.id,
            kind: "chunk-digest",
            detail: `chunk ${c.id} no longer hashes to what was recorded — its span has moved or its text has changed`,
          });
        }
      }
    }
  }

  return findings;
}

/** Claims pointing at units the manifest does not contain. */
export function checkUnitReferences(root) {
  const claims = collectClaims(root);
  const corpus = readJsonl(path.join(root, "corpus.jsonl"));
  const units = new Set(corpus.map((u) => u.unit).filter(Boolean));
  if (!units.size) return [];
  const bad = new Map();
  for (const c of claims) {
    if (c.unit && !units.has(c.unit)) {
      if (!bad.has(c.unit)) bad.set(c.unit, []);
      bad.get(c.unit).push(c.id);
    }
  }
  return [...bad.entries()].map(([unit, ids]) => ({
    unit,
    claims: ids.length,
    detail: `${ids.length} claim(s) point at unit '${unit}', which the manifest does not contain — the denominator and the store disagree`,
  }));
}

/** Load `.distill.json` if present. Absent means built-in defaults apply. */
export function loadConfig(root) {
  const file = path.join(root, ".distill.json");
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`.distill.json is not valid JSON (${e.message}) — an invalid configuration stops the work rather than being worked around`);
  }
}

/**
 * The extraction profile of every ingested document.
 *
 * The certificate prints these because "how complete is this store" cannot be
 * answered without "which tool produced the text, and is that tool any good".
 * An unqualified extractor is not a failure — it is a stated limit on what the
 * coverage numbers below it are worth.
 */
export function extractionProfiles(root) {
  const base = path.join(root, "sources", "converted");
  if (!fs.existsSync(base)) return [];
  const out = [];
  for (const doc of fs.readdirSync(base).sort()) {
    const f = path.join(base, doc, "source.json");
    if (!fs.existsSync(f)) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(f, "utf8")));
    } catch {
      out.push({ slug: doc, extractor_id: "unreadable source.json", conformance: null });
    }
  }
  return out;
}
