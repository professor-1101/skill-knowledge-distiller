// confidence.mjs — the rubric, applied mechanically.
//
// R23 says compute confidence, never judge it, and nothing computed it. A
// hand-assigned score is unreproducible and cannot be recomputed when new
// corroboration arrives, so it decays into a number nobody can defend.
//
// `origin: model` caps below any source-derived score regardless of support,
// because repetition of a model inference is not corroboration of a fact.

export const RUBRIC_VERSION = "formula-v1";

export function computeConfidence({ origin, support, corroboration = 1, crossSource = false }) {
  let base;
  if (origin === "model") base = 0.5;
  else if (support === "direct") base = 0.9;
  else if (support === "inferred") base = 0.65;
  else base = 0.5;

  let bonus = 0;
  if (origin !== "model") {
    const n = Number(corroboration) || 1;
    if (n >= 3) bonus += 0.1;
    else if (n === 2) bonus += 0.05;
    // Corroboration by a *different* source is the only kind that means
    // anything: a second extraction pass over the same book is the same
    // evidence read twice.
    if (crossSource) bonus += 0.05;
  }
  return Math.min(1, Math.max(0, Number((base + bonus).toFixed(4))));
}

/** What a claim's confidence should be, given its own fields. */
export function expectedForClaim(claim) {
  return computeConfidence({
    origin: claim.origin,
    support: (claim.evidence || {}).support,
    corroboration: claim.corroboration ?? 1,
    crossSource: Boolean(claim.cross_source),
  });
}

/** What a rule's confidence should be, given the claims it derives from. */
export function expectedForRule(rule, claimsById) {
  const derived = (rule.derived_from || []).map((id) => claimsById.get(id)).filter(Boolean);
  if (!derived.length) return null;
  const sources = new Set(derived.map((c) => (c.evidence || {}).source).filter(Boolean));
  const anyModel = derived.some((c) => c.origin === "model");
  const allDirect = derived.every((c) => (c.evidence || {}).support === "direct");
  return computeConfidence({
    origin: anyModel ? "model" : "source",
    support: allDirect ? "direct" : "inferred",
    corroboration: derived.length,
    crossSource: sources.size > 1,
  });
}

export const TOLERANCE = 0.0001;
