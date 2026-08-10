// schema.mjs — write-time conformance for claims and rules.
//
// Two profiles, and the distinction is load-bearing:
//
//   compat  exactly the checks the previous Python pipeline enforced. An
//           existing store must pass this unchanged, which is what makes the
//           migration a migration rather than a rewrite.
//   strict  compat plus the no-guessing gates in prose.mjs. This is the bar
//           for new material.
//
// Running an existing store under `strict` is a useful measurement, not a
// failure: the delta between the two profiles is a list of fields that were
// filled when they should have been gap records. That list is a finding.

import { checkEvidence, PROMPT_VERSION_RE, ISO_RE } from "./evidence.mjs";
import { checkField, isDeclaredUnknown, checkDeclaredUnknown, isSelfReference } from "./prose.mjs";

export const CLAIM_REQUIRED = [
  "id", "unit", "type", "statement", "condition", "consequence",
  "defines", "mentions", "evidence", "origin", "confidence",
  "prompt_version", "extracted_at",
];

export const CLAIM_TYPES = new Set([
  "principle", "rule", "pattern", "anti-pattern", "tradeoff", "example", "definition",
]);

// The default identifier shape is the one already in the store:
// `<source-slug>/chNN/sNN/cNN`. It is a default rather than a constant because
// "chapter" and "section" are book vocabulary, and the methodology is meant to
// outlive that. A project with different structure overrides both patterns in
// `.distill.json`; nothing else in the pipeline reads the shape.
export const DEFAULT_ID_RE = /^[a-z0-9-]+\/ch\d{2}\/s\d{2}\/c\d{2}$/;
export const DEFAULT_UNIT_RE = /^[a-z0-9-]+\/ch\d{2}\/s\d{2}$/;

// A condition that applies always is not a condition. A `rule` claim carrying
// one is a platitude: true, sourced, and it changes no decision.
const NON_CONDITIONS = new Set(["always", "n/a", "-", "", "any", "all cases", "in general"]);

const STATEMENT_FLOOR = 20;

export function validateClaim(claim, where, opts = {}) {
  const {
    profile = "strict",
    idRe = DEFAULT_ID_RE,
    unitRe = DEFAULT_UNIT_RE,
  } = opts;
  const strict = profile === "strict";
  const errors = [];
  const push = (m) => errors.push(m);

  for (const field of CLAIM_REQUIRED) {
    if (!(field in claim)) push(`missing required field '${field}'`);
  }
  if (errors.length) return errors;

  if (!idRe.test(claim.id)) {
    push(`id '${claim.id}' does not match the configured identifier shape`);
  }
  if (!unitRe.test(claim.unit || "")) {
    push(`unit '${claim.unit}' does not match the configured unit shape`);
  } else if (!String(claim.id).startsWith(claim.unit + "/c")) {
    push(`id '${claim.id}' is not inside its own unit '${claim.unit}'`);
  }

  if (!CLAIM_TYPES.has(claim.type)) {
    push(`type '${claim.type}' not in ${[...CLAIM_TYPES].sort().join(", ")}`);
  }

  // condition and consequence are what make this a claim rather than a summary
  // sentence. A summarising pass cannot populate them honestly, which is
  // exactly why they are required at write time and not reviewed later.
  if (typeof claim.condition !== "string" || !claim.condition.trim()) {
    if (!isDeclaredUnknown(claim.condition)) {
      push("condition is empty — this is the difference between a claim and a summary sentence");
    } else {
      push("condition may not be unknown — a claim with no condition states nothing decidable");
    }
  }
  if (typeof claim.consequence !== "string" || !claim.consequence.trim()) {
    if (!isDeclaredUnknown(claim.consequence)) push("consequence is empty");
    else push("consequence may not be unknown — without it the claim decides nothing");
  }

  if (String(claim.statement || "").length < STATEMENT_FLOOR) {
    push(`statement below specificity floor (${STATEMENT_FLOOR} chars) — looks like a bare label`);
  }

  errors.push(...checkEvidence(claim));

  if (!PROMPT_VERSION_RE.test(String(claim.prompt_version ?? ""))) {
    push(
      `prompt_version '${claim.prompt_version}' must be '<stage>@<hash>' — the ` +
        `hash is what invalidates claims when a prompt changes, so a malformed ` +
        `one makes the store silently unresumable`
    );
  }

  if (!ISO_RE.test(String(claim.extracted_at ?? ""))) {
    push("extracted_at must be an ISO-8601 timestamp");
  }

  if (!["source", "model"].includes(claim.origin)) {
    push("origin must be 'source' or 'model' — the tiers stay structurally separate");
  }

  const conf = Number(claim.confidence);
  if (!Number.isFinite(conf)) push("confidence not numeric");
  else if (conf < 0 || conf > 1) push("confidence out of [0,1]");

  if (
    claim.type === "rule" &&
    typeof claim.condition === "string" &&
    NON_CONDITIONS.has(claim.condition.trim().toLowerCase())
  ) {
    push(
      "type=rule with a non-conditional condition — this is a platitude: it will " +
        "pass every gate and change no decision. Reject it, or retype as a principle"
    );
  }

  if (strict) {
    for (const f of ["statement", "condition", "consequence"]) {
      errors.push(...checkField(claim[f], f, { minLength: f === "statement" ? STATEMENT_FLOOR : 0 }));
    }
    if (isSelfReference(claim.statement, claim.consequence)) {
      push("consequence restates statement — say what changes, not what was said");
    }
  }

  return dedupe(errors).map((m) => ({ where, message: m }));
}

export const RULE_REQUIRED = ["id", "cluster", "name", "when", "then", "because", "derived_from"];

/**
 * Rule conformance. The fields that may legitimately be unfilled — `unless`,
 * `cost`, `anti_patterns` — are exactly the ones the previous run filled badly
 * when it tried to fill them mechanically. So under `strict` they are checked
 * for the specific ways that went wrong, and an honest gap always passes.
 */
export function validateRule(rule, where, opts = {}) {
  const { profile = "strict" } = opts;
  const strict = profile === "strict";
  const errors = [];
  const push = (m) => errors.push(m);

  for (const f of RULE_REQUIRED) {
    if (!(f in rule)) push(`missing required field '${f}'`);
  }
  if (errors.length) return errors.map((m) => ({ where, message: m }));

  if (!Array.isArray(rule.derived_from) || !rule.derived_from.length) {
    push("derived_from is empty — a rule that resolves to nothing is fabrication");
  }

  if (strict) {
    // Truncation is invisible in output and reads as a rule. The previous run
    // shipped 45 names cut at exactly 110 characters, several mid-word.
    if (typeof rule.name === "string" && rule.name.length >= 110 && !/[.!?]$/.test(rule.name.trim())) {
      push(
        `name is ${rule.name.length} chars and ends mid-clause — a mechanically ` +
          `truncated name reads as a rule and is not one. Write a short imperative`
      );
    }

    errors.push(...checkField(rule.when, "when", { minLength: 10 }));
    errors.push(...checkField(rule.then, "then", { minLength: 10 }));
    errors.push(
      ...checkField(rule.because, "because", {
        minLength: 10,
        notSameAs: { then: rule.then, name: rule.name },
      })
    );

    // `cost` and `unless` are optional-but-declared: absent is a gap the
    // certificate counts, present-and-wrong is the failure that shipped twice.
    if ("cost" in rule && rule.cost !== "" && rule.cost !== null) {
      errors.push(
        ...checkField(rule.cost, "cost", { notSameAs: { because: rule.because } })
      );
    }
    if (Array.isArray(rule.unless)) {
      rule.unless.forEach((u, i) => {
        if (isDeclaredUnknown(u)) {
          errors.push(...checkDeclaredUnknown(u, `unless[${i}]`));
          return;
        }
        // A boundary clause may be bare text, but the preferred shape carries
        // its own provenance: {clause, from}. R4 draws exceptions from claims
        // in other units and other books, so which claim bounded this rule is
        // exactly the thing a reader will want and cannot reconstruct.
        const text = u && typeof u === "object" && !Array.isArray(u) ? u.clause : u;
        if (u && typeof u === "object" && !Array.isArray(u) && !("from" in u)) {
          errors.push(
            `unless[${i}] carries no 'from' — a boundary without the claim that ` +
              `established it cannot be audited back to the source`
          );
        }
        errors.push(...checkField(text, `unless[${i}]`, { notSameAs: { when: rule.when } }));
        const n = String(text ?? "").trim().toLowerCase();
        if (NON_CONDITIONS.has(n)) {
          errors.push(
            `unless[${i}] is "${text}" — a boundary that applies always is not a boundary, ` +
              `and it tells a reader nothing about when to stop applying the rule`
          );
        }
      });
    } else if ("unless" in rule && rule.unless !== null && !isDeclaredUnknown(rule.unless)) {
      push("unless must be an array of boundary clauses, or a declared unknown");
    }
  }

  return dedupe(errors.map((e) => (typeof e === "string" ? e : e.message ?? e))).map((m) => ({
    where,
    message: m,
  }));
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = typeof item === "string" ? item : item.message;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}
