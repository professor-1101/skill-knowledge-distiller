#!/usr/bin/env node
// certify.mjs — the completeness certificate.
//
// Reconciles every denominator in the pipeline and prints the shortfalls in
// capitals. Those capitalised lines are the point of the document: a
// certificate that reports only successes is not measuring anything, and the
// number worth having is the one nobody wants to publish.
//
// The certificate is **withheld** when a hard invariant fails. Nothing is
// certified while a claim has no recorded fate, because refinement compresses
// roughly ten to one and an unaccounted claim is a silent loss rather than a
// decision. A withheld certificate is a result, not an error.
//
//   node certify.mjs [--root DIR] [--out FILE] [--generated-at ISO]
//
// Exit 0 when issued, 1 when withheld.

import fs from "node:fs";
import path from "node:path";
import { readJsonl, collectClaims, nowIso, parseArgs } from "./lib/jsonl.mjs";
import { checkChunkTiling, checkConversionFidelity, extractionProfiles } from "./lib/store.mjs";

const pct = (num, den) => (den ? `${((100.0 * num) / den).toFixed(1)}%` : "n/a");
const line = (label, value, note = "") =>
  `  ${String(label).padEnd(20)}${value}${note ? "   " + note : ""}`;

function main() {
  const args = parseArgs(process.argv.slice(2), { root: "." });
  const root = args.root;

  const corpus = readJsonl(path.join(root, "corpus.jsonl"));
  const claims = collectClaims(root);
  const probes = readJsonl(path.join(root, "probes.jsonl"));
  const rules = readJsonl(path.join(root, "rules.jsonl"));
  const dispositions = readJsonl(path.join(root, "dispositions.jsonl"));
  const frameworks = readJsonl(path.join(root, "frameworks.jsonl"));
  const gaps = readJsonl(path.join(root, "gaps.jsonl"));
  const resolutions = readJsonl(path.join(root, "resolutions.jsonl"));

  const books = new Set(corpus.map((u) => u.book).filter(Boolean));
  const units = corpus.map((u) => u.unit).filter(Boolean);
  const probedUnits = new Set(probes.map((p) => p.unit).filter(Boolean));
  const saturated = corpus.filter((u) => String(u.status || "").toLowerCase() === "saturated");
  const sourceFailed = corpus.filter((u) => String(u.status || "").toLowerCase() === "source-failed");

  const evidenced = claims.filter((c) => (c.evidence || {}).locator && (c.evidence || {}).excerpt_hash);
  const originSource = claims.filter((c) => c.origin === "source").length;
  const originModel = claims.filter((c) => c.origin === "model").length;

  const depth = new Map();
  for (const p of probes) depth.set(p.unit, (depth.get(p.unit) || 0) + 1);
  const depths = [...depth.values()].sort((a, b) => a - b);

  const claimIds = new Set(claims.map((c) => c.id));
  const disposed = new Set(dispositions.map((d) => d.claim));
  const undisposed = [...claimIds].filter((id) => !disposed.has(id));
  const accounted = [...disposed].filter((id) => claimIds.has(id)).length;

  const dispCounts = new Map();
  for (const d of dispositions) {
    if (!d.disposition) continue;
    dispCounts.set(d.disposition, (dispCounts.get(d.disposition) || 0) + 1);
  }

  const withUnless = rules.filter((r) => Array.isArray(r.unless) ? r.unless.length : Boolean(r.unless));
  const withCost = rules.filter((r) => String(r.cost || "").trim());
  const withAp = rules.filter((r) => (r.anti_patterns || []).length);
  const corroborated = rules.filter((r) => (r.corroboration || 0) >= 2);

  const grounded = [];
  const ungrounded = [];
  for (const r of rules) {
    const derived = r.derived_from || [];
    if (derived.length && derived.every((id) => claimIds.has(id))) grounded.push(r);
    else ungrounded.push(r);
  }

  const skillsDir = path.join(root, "skills");
  let skills = [];
  if (fs.existsSync(skillsDir) && fs.statSync(skillsDir).isDirectory()) {
    skills = fs
      .readdirSync(skillsDir)
      .filter((d) => fs.statSync(path.join(skillsDir, d)).isDirectory())
      .sort();
  }

  const contested = frameworks.reduce((n, f) => n + (f.contested || []).length, 0);
  const openGaps = gaps.filter((g) => String(g.status || "open").startsWith("open"));

  // Ingestion findings. Absent a converted-source tree these are empty, which
  // is why an existing store certifies unchanged.
  const tiling = checkChunkTiling(root);
  const fidelity = checkConversionFidelity(root);

  const L = [];
  L.push("# Completeness Certificate");
  L.push("");
  L.push(`Generated ${args["generated-at"] || nowIso()}`);
  L.push("");
  L.push("```");
  L.push("EXTRACTION");
  L.push(line("corpus", `${books.size} books, ${units.length} units enumerated`));
  L.push(line("traversal", `${probedUnits.size}/${units.length} units probed`, pct(probedUnits.size, units.length)));
  L.push(line("claims", `${claims.length} total`));
  L.push(line("evidenced", `${evidenced.length}/${claims.length}`, pct(evidenced.length, claims.length)));
  if (evidenced.length < claims.length) {
    L.push(line("UNEVIDENCED", `${claims.length - evidenced.length} claims`));
  }
  L.push(line("origin=source", `${originSource}   origin=model  ${originModel}`));
  if (depths.length) {
    const mean = depths.reduce((a, b) => a + b, 0) / depths.length;
    L.push(line("probe depth", `mean ${mean.toFixed(1)}  min ${depths[0]}  max ${depths[depths.length - 1]}`));
  } else {
    L.push(line("probe depth", "no probes logged"));
  }
  L.push(line("saturation reached", `${saturated.length}/${units.length}`, pct(saturated.length, units.length)));
  if (saturated.length < units.length) {
    L.push(line("NOT REACHED", `${units.length - saturated.length} units`));
  }
  L.push(line("source failures", String(sourceFailed.length)));
  if (fidelity.length) {
    const by = (k) => fidelity.filter((f) => f.kind === k).length;
    L.push(line("CONVERSION SUSPECT", `${fidelity.length} pages — a clean-looking wrong conversion reports as coverage`));
    if (by("extraction-disagreement")) {
      L.push(line("EXTRACTOR CONFLICT", `${by("extraction-disagreement")} pages where two extractors disagree`));
    }
    if (by("extraction-refused")) {
      L.push(line("EXTRACTION REFUSED", `${by("extraction-refused")} pages the extractor could not read, undeclared`));
    }
  }
  for (const prof of extractionProfiles(root)) {
    L.push(line("extractor", `${prof.slug}: ${prof.extractor_id}`));
    const c = prof.conformance;
    if (c && typeof c === "object") {
      L.push(line("  conformance", `${c.pass}/${c.of} fixtures`));
      if (c.pass < c.of) L.push(line("  UNQUALIFIED", `${c.of - c.pass} fixtures failed — text quality is not established`));
    } else {
      L.push(line("  CONFORMANCE", "NOT MEASURED — run extractor-check.mjs --record"));
    }
    L.push(line("  manifest", prof.manifest_sha256 ? prof.manifest_sha256.slice(0, 16) : "absent"));
  }
  if (tiling.length) {
    L.push(line("CHUNK COVERAGE", `${tiling.length} defect(s) — source text belonging to no chunk`));
  }
  L.push("");
  L.push("REFINEMENT");
  L.push(line("dispositions", `${accounted}/${claimIds.size} accounted for`, pct(accounted, claimIds.size)));
  if (undisposed.length) {
    L.push(line("UNDISPOSED", `${undisposed.length} claims — certificate withheld`));
  }
  if (dispCounts.size) {
    L.push(
      "    " +
        [...dispCounts.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
          .map(([k, v]) => `${k} ${v}`)
          .join(" · ")
    );
  }
  L.push(line("rules", String(rules.length)));
  L.push(line("with unless", `${withUnless.length}/${rules.length}`, pct(withUnless.length, rules.length)));
  if (withUnless.length < rules.length) {
    L.push(line("MISSING UNLESS", `${rules.length - withUnless.length} rules`));
  }
  L.push(line("with cost", `${withCost.length}/${rules.length}`, pct(withCost.length, rules.length)));
  if (withCost.length < rules.length) {
    L.push(line("MISSING COST", `${rules.length - withCost.length} rules`));
  }
  L.push(line("with anti-pattern", `${withAp.length}/${rules.length}`, pct(withAp.length, rules.length)));
  if (withAp.length < rules.length) {
    L.push(line("MISSING ANTI-PATTERN", `${rules.length - withAp.length} rules`));
  }
  L.push(line("corroborated >=2", `${corroborated.length}/${rules.length}`, pct(corroborated.length, rules.length)));
  L.push("");
  L.push("COMPILATION");
  L.push(line("skills", String(skills.length)));
  L.push(line("grounded", `${grounded.length}/${rules.length} resolve to evidence`, pct(grounded.length, rules.length)));
  if (ungrounded.length) {
    L.push(line("UNGROUNDED", `${ungrounded.length} rules — fabrication, reject`));
  }
  L.push(line("contested preserved", String(contested)));
  L.push(line("resolutions logged", String(resolutions.length)));
  L.push("");
  L.push(line("OPEN GAPS", String(openGaps.length)));
  L.push("```");

  const blocked = [];
  if (undisposed.length && claims.length) {
    blocked.push(`${undisposed.length} claims have no disposition (invariant: claims - dispositions = empty)`);
  }
  if (ungrounded.length) {
    blocked.push(`${ungrounded.length} rules do not resolve to claims`);
  }
  if (tiling.length) {
    blocked.push(
      `${tiling.length} chunk-coverage defect(s) — coverage cannot be measured against a chunk set that omits part of the source`
    );
  }

  if (blocked.length) {
    L.push("");
    L.push("## CERTIFICATE WITHHELD");
    L.push("");
    for (const b of blocked) L.push(`- ${b}`);
    L.push("");
    L.push("A failure is recorded loudly and never resolved by silently downgrading the requirement.");
  }

  const text = L.join("\n") + "\n";
  const out = args.out || path.join(root, "reports", "certificate.md");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text, "utf8");
  process.stdout.write(text);
  process.stderr.write(`written ${out}\n`);
  process.exit(blocked.length ? 1 : 0);
}

main();
