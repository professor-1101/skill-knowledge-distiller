// evidence.mjs — the provenance chain, and the checks that keep it real.
//
// The chain, end to end:
//
//   claim → evidence.excerpt_hash → chunk → page → converted document
//         → original file sha256
//
// Every link is verifiable offline by anyone holding the original file. That
// is the whole point of NFR-03 (bidirectional traceability), and it is the
// property the first generation of the previous claim store lost: every claim
// carried `excerpt_hash: "md-derived-01"`, a placeholder that looks populated
// and proves nothing. The store was discarded rather than repaired, because a
// chain you cannot verify is indistinguishable from a fabricated one.

import crypto from "node:crypto";

/** A real digest, with or without the `sha256:` prefix. Nothing else passes. */
export const HASH_RE = /^(sha256:)?[0-9a-f]{64}$/;

/** `<stage>@<hash>`. ADR 3.6 uses this to invalidate work when a prompt changes. */
export const PROMPT_VERSION_RE = /^[a-z-]+@[0-9a-f]{7,64}$/;

export const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/**
 * Placeholders that have actually been observed standing in for a digest.
 * Kept as a named list because the generic "not a sha256" message does not
 * tell an author what went wrong, and this one does.
 */
export const KNOWN_PLACEHOLDERS = [
  "md-derived", "derived", "todo", "tbd", "placeholder", "n/a", "none",
  "pending", "xxx", "hash", "sha256:", "0000",
];

export function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** The digest of an exact span, which is what an excerpt_hash must be. */
export function hashSpan(text, start, end) {
  return sha256(Buffer.from(String(text).slice(start, end), "utf8"));
}

export function isRealDigest(value) {
  return HASH_RE.test(String(value || "").trim());
}

/**
 * Why a value is not a digest, phrased so the author can act on it. A bare
 * "invalid hash" sends people looking for a typo when the real problem is that
 * nothing was ever read.
 */
export function explainBadDigest(value) {
  const v = String(value || "").trim();
  if (!v) return "is empty — nothing was hashed, so nothing was read";
  const low = v.toLowerCase();
  for (const p of KNOWN_PLACEHOLDERS) {
    if (low.startsWith(p) || low === p) {
      return (
        `is the placeholder '${v}' — a placeholder proves nothing was read, ` +
        `and it breaks the evidence chain invisibly because it looks populated`
      );
    }
  }
  if (/^[0-9a-f]+$/.test(low)) {
    return `is ${low.length} hex chars, not 64 — a sha256 digest is 64`;
  }
  return `'${v}' is not a sha256 digest — hash the exact span that was read`;
}

/**
 * Check one claim's evidence block.
 *
 * `support: inferred` is legitimate — a book states things it does not spell
 * out — but it cannot coexist with `origin: model`, because that pairing
 * claims the source backs something the source never said.
 */
export function checkEvidence(claim) {
  const errors = [];
  const ev = claim.evidence;

  if (!ev || typeof ev !== "object" || Array.isArray(ev)) {
    errors.push("evidence block missing — nothing enters the store unsourced");
    return errors;
  }

  for (const f of ["source", "locator", "support", "excerpt_hash"]) {
    if (!(f in ev) || !String(ev[f] ?? "").trim()) {
      errors.push(`evidence.${f} missing or empty`);
    }
  }

  if (!["direct", "inferred"].includes(ev.support)) {
    errors.push("evidence.support must be 'direct' or 'inferred'");
  }

  if ("excerpt_hash" in ev && !isRealDigest(ev.excerpt_hash)) {
    errors.push(`evidence.excerpt_hash ${explainBadDigest(ev.excerpt_hash)}`);
  }

  if (claim.origin === "model" && ev.support === "direct") {
    errors.push(
      "origin=model with evidence.support=direct is a contradiction — model-origin " +
        "material has no direct source support, and blending the tiers makes the " +
        "store unfalsifiable against the corpus"
    );
  }

  return errors;
}

/**
 * Resolve a rule's derivation to claims that exist. An unresolvable chain
 * means the rule came from somewhere other than the corpus, which is
 * fabrication — repaired at its origin or dropped, never patched at the skill.
 */
export function resolveRule(rule, claimIds) {
  const derived = rule.derived_from || [];
  if (!derived.length) {
    return { ok: false, reason: "derived_from is empty — the rule resolves to nothing" };
  }
  const missing = derived.filter((id) => !claimIds.has(id));
  if (missing.length) {
    return {
      ok: false,
      reason: `derived_from names ${missing.length} claim(s) not in the store: ${missing
        .slice(0, 3)
        .join(", ")}${missing.length > 3 ? " …" : ""}`,
    };
  }
  return { ok: true };
}
