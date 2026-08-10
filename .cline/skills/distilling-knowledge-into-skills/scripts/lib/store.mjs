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
 * Conversion fidelity. The risk named by the ingestion constraint is not a
 * failed conversion — a failure is loud. It is a conversion that succeeds and
 * is wrong, because that reports as coverage.
 *
 * Two signals a script can see without understanding the content:
 * a page yielding almost nothing while its neighbours yield plenty, and an
 * image page that was never declared as one.
 */
export function checkConversionFidelity(root, { floorRatio = 0.05 } = {}) {
  const findings = [];
  const base = path.join(root, "sources", "converted");
  if (!fs.existsSync(base)) return findings;

  for (const doc of fs.readdirSync(base).sort()) {
    const pages = readJsonl(path.join(base, doc, "pages.jsonl"));
    if (!pages.length) continue;

    const textPages = pages.filter((p) => p.kind === "text");
    const counts = textPages.map((p) => Number(p.char_count) || 0).filter((n) => n > 0);
    if (counts.length >= 4) {
      const sorted = [...counts].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const floor = median * floorRatio;
      for (const p of textPages) {
        const n = Number(p.char_count) || 0;
        if (n < floor) {
          findings.push({
            doc,
            page: p.page,
            kind: "conversion-suspect",
            detail:
              `page ${p.page} yielded ${n} characters against a median of ${median} — ` +
              `a text page returning almost nothing is a conversion failure, not an ` +
              `empty page. Extraction from it is refused until it is declared blank ` +
              `or re-converted with a different extractor`,
          });
        }
      }
    }

    for (const p of pages) {
      if (!p.kind) {
        findings.push({
          doc,
          page: p.page,
          kind: "undeclared-page",
          detail: `page ${p.page} has no 'kind' — text, image and mixed pages carry different guarantees and must be distinguished`,
        });
      }
      if ((p.kind === "image" || p.kind === "mixed") && !p.ocr_engine && !p.gap) {
        findings.push({
          doc,
          page: p.page,
          kind: "image-not-handled",
          detail:
            `page ${p.page} carries image content with neither an OCR record nor a ` +
            `gap — a skipped page reports as covered, which is the failure this ` +
            `check exists to catch`,
        });
      }
      if (p.ocr_engine && !("ocr_confidence" in p)) {
        findings.push({
          doc,
          page: p.page,
          kind: "ocr-unscored",
          detail: `page ${p.page} was OCR'd without recording a confidence — OCR is a transcription guess and its tier has to be visible`,
        });
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
