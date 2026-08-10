// prose.mjs — the no-guessing gate, enforced rather than requested.
//
// The previous run honoured "evidence or omission" by hand: 147 rule-field
// combinations were left as gap records rather than filled with something
// plausible. That discipline held because a person was watching. This file is
// what makes it hold when nobody is.
//
// Three failures, each of which shipped at least once in the previous project
// and each of which read perfectly well at the time:
//
//   1. Hedged assertions   — "probably indicates the parser is at fault"
//   2. Self-reference      — a `cost` that restates its own `because`
//   3. Bare labels         — a statement too short to say anything
//
// The governing asymmetry: a missing value is visible and cheap. A guessed
// value is invisible and propagates into downstream work where nobody
// re-checks it. So the default on uncertainty is a declared gap, never an
// inference.

/**
 * Markers of speculation. Present in a normative field, they mean the writer
 * could not commit — which is a gap, and gaps have their own representation.
 *
 * Deliberately not exhaustive. A blocklist cannot catch every hedge, and
 * pretending otherwise would be its own false confidence. It catches the
 * register reliably enough to make hedging inconvenient, which is the point.
 */
export const HEDGE_MARKERS = [
  "probably", "presumably", "perhaps", "arguably", "supposedly",
  "appears to", "seems to", "seems like", "looks like",
  "may indicate", "might indicate", "may suggest", "might suggest",
  "suggests that", "implies that", "one could argue", "it is likely",
  "likely means", "likely because", "possibly because", "i think",
  "we think", "not sure", "unclear whether", "some say", "generally speaking",
  "more or less", "sort of", "kind of", "roughly speaking",
];

/** The declared-unknown union: a value, or an explicit gap that names its cure. */
export function isDeclaredUnknown(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.status === "unknown"
  );
}

/**
 * A declared unknown must say what would settle it. An unknown with an empty
 * `gap` is indistinguishable from an unfilled field, and the whole reason for
 * the union is that those two are different things.
 */
export function checkDeclaredUnknown(value, field) {
  const errors = [];
  if (!isDeclaredUnknown(value)) return errors;
  const gap = typeof value.gap === "string" ? value.gap.trim() : "";
  if (!gap) {
    errors.push(
      `${field} is declared unknown but carries no 'gap' — an unknown must ` +
        `state what evidence would resolve it, or it is just an empty field ` +
        `wearing a label`
    );
  } else if (gap.length < 10) {
    errors.push(
      `${field}.gap is too short to name a cure ("${gap}") — say what would settle it`
    );
  }
  return errors;
}

/** Normalise for comparison: case, punctuation and whitespace carry no meaning here. */
export function normalise(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Hedge markers found in a field. Empty array means the field commits. */
export function findHedges(text) {
  const hay = " " + normalise(text) + " ";
  const hits = [];
  for (const marker of HEDGE_MARKERS) {
    if (hay.includes(" " + normalise(marker) + " ")) hits.push(marker);
  }
  return hits;
}

/**
 * Two fields that say the same thing. The real incident: R5 derived `cost`
 * from the same claim R3 derived `because` from, so cost could only ever
 * restate the mechanism. It filled the field, ranked nothing, and passed every
 * gate that existed at the time.
 */
export function isSelfReference(a, b) {
  const na = normalise(a);
  const nb = normalise(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Containment counts too: a cost that is the `because` plus three words is
  // still the `because`.
  if (na.length > 24 && nb.length > 24 && (na.includes(nb) || nb.includes(na))) return true;
  return false;
}

/**
 * A word list is not a sentence. R7's computed discriminator produced
 * "initially, lengths, side, specification versus classes, defined, invalid" —
 * which reads like an answer and settles nothing. A field that is mostly
 * comma-separated fragments with no verb is that failure recurring.
 */
export function looksLikeWordList(text) {
  const s = String(text || "").trim();
  if (!s) return false;
  const commas = (s.match(/,/g) || []).length;
  if (commas < 2) return false;

  const segments = s.split(",").map((x) => x.trim()).filter(Boolean);

  // A sentence that happens to enumerate is not a word list. "The standard
  // fault categories are input/output, logic, computation, interface, and
  // data." is a claim; "initially, lengths, side, defined, invalid" is not.
  // Two cheap discriminators separate them, and both must fail before this
  // fires — a false positive here rejects good material, which is worse than
  // letting one word list through to human review.
  const firstWords = segments[0].split(/\s+/).filter(Boolean);
  if (firstWords.length >= 4) return false;
  if (FINITE_VERB_RE.test(s)) return false;

  const shortSegments = segments.filter((x) => x.split(/\s+/).length <= 2).length;
  return shortSegments >= Math.ceil(segments.length * 0.6);
}

// Any finite verb makes the string a sentence rather than a list. The set is
// small and common on purpose: it only has to catch the presence of a
// predicate, not parse one.
const FINITE_VERB_RE =
  /\b(is|are|was|were|be|been|being|has|have|had|do|does|did|can|cannot|may|might|must|should|shall|will|would|becomes?|produces?|requires?|causes?|means?|makes?|gives?|takes?|holds?|applies|applies to|yields?|returns?|shows?|leaves?|keeps?|costs?|prevents?|allows?|forces?|splits?|merges?)\b/i;

/**
 * Full prose check for one normative field.
 *
 * `minLength` is the specificity floor. Below it the field is a label rather
 * than a statement, and a label passes every downstream check while carrying
 * no decidable content.
 */
export function checkField(value, field, { minLength = 0, notSameAs = null } = {}) {
  const errors = [];

  if (isDeclaredUnknown(value)) return checkDeclaredUnknown(value, field);

  if (typeof value !== "string" || !value.trim()) {
    errors.push(
      `${field} is empty — supply a value, or declare it unknown as ` +
        `{"status": "unknown", "gap": "<what would settle it>"}`
    );
    return errors;
  }

  const text = value.trim();

  if (minLength && text.length < minLength) {
    errors.push(
      `${field} is below the specificity floor (${text.length} < ${minLength} chars) — ` +
        `this is a label, not a statement`
    );
  }

  const hedges = findHedges(text);
  if (hedges.length) {
    errors.push(
      `${field} hedges (${hedges.map((h) => `"${h}"`).join(", ")}) — a value the ` +
        `evidence does not support is a gap, not a guess. Declare it unknown instead`
    );
  }

  if (looksLikeWordList(text)) {
    errors.push(
      `${field} reads as a word list rather than a statement — a mechanically ` +
        `assembled field that looks filled is more dangerous than an empty one, ` +
        `because nothing downstream will question it`
    );
  }

  if (notSameAs) {
    for (const [otherField, otherValue] of Object.entries(notSameAs)) {
      if (isSelfReference(text, otherValue)) {
        errors.push(
          `${field} restates ${otherField} — it was derived from the same source ` +
            `and adds nothing. Find a separate answer or declare it unknown`
        );
      }
    }
  }

  return errors;
}
