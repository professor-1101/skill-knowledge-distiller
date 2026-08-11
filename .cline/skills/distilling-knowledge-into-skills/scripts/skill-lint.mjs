#!/usr/bin/env node
// skill-lint.mjs — check a skill directory against Cline's documented contract.
//
// This runs against *any* skill directory, which is the point twice over: it
// lints the skills this methodology compiles (R31 says the package must load,
// and a package that fails discovery has produced nothing), and it lints this
// skill itself, so the methodology is held to the contract it enforces.
//
// Everything checked here is stated in Cline's own `customization/skills`
// reference. Where the reference is silent the check is a note, not an error —
// a lint that invents requirements teaches people to ignore it.
//
//   node skill-lint.mjs [--path <skill-dir>] [--quiet]
//
// Exit 0 conforming, 1 warnings, 2 a contract violation.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib/jsonl.mjs";

/**
 * The contract, as documented. Each field cites the sentence it comes from so
 * a future reader can check the lint against the reference rather than
 * against my memory of it.
 */
export const SKILL_CONTRACT = {
  // "Every skill is a directory containing a SKILL.md file with YAML frontmatter."
  entry: "SKILL.md",
  // "Required fields: name must exactly match the directory name; description
  //  tells Cline when to use this skill (max 1024 characters)"
  required: ["name", "description"],
  descriptionMax: 1024,
  // "Keep SKILL.md under 5k tokens."
  bodyTokenMax: 5000,
  // "Optionally add supporting files in docs/, templates/, or scripts/"
  knownDirs: ["docs", "templates", "scripts"],
  // "Use lowercase with hyphens (kebab-case)"
  namePattern: /^[a-z0-9]+(-[a-z0-9]+)*$/,
  // "Project skills: .cline/skills/ (recommended), .clinerules/skills/,
  //  .claude/skills/"
  //
  // The third is a compatibility path Cline reads for skills written against
  // another agent's layout. It is listed because Cline lists it: a lint that
  // reported "not a discovery root" for a directory Cline does discover would
  // be wrong, and being wrong confidently is the failure this whole repository
  // is built to avoid. Nothing here writes to it.
  projectRoots: [
    path.join(".cline", "skills"),
    path.join(".clinerules", "skills"),
    path.join(".claude", "skills"),
  ],
  globalRoots: [
    path.join(".cline", "skills"),
    path.join(".cline", "data", "settings", "skills"),
  ],
  // The reference's own examples of a description that will not trigger.
  weakDescriptions: [/^helps? with /i, /^useful for /i, /^[a-z ]{0,20}helper\.?$/i],
};

/**
 * Token estimate for the body budget.
 *
 * Cline states the limit in tokens and no tokenizer ships with this skill, so
 * this estimates and says so. Two estimators are taken and the larger wins:
 * 4 characters per token, and 1.3 tokens per whitespace-delimited word. Prose
 * favours the first, dense punctuation and code the second. Erring high is the
 * safe direction — a skill reported at 96% that is really at 90% costs nothing,
 * and the reverse silently exceeds the budget.
 */
export function estimateTokens(text) {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(Math.ceil(text.length / 4), Math.ceil(words * 1.3));
}

/** Split frontmatter from body without a YAML dependency. */
export function splitFrontmatter(source) {
  if (!source.startsWith("---\n")) return { frontmatter: null, body: source };
  const end = source.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: null, body: source };
  return {
    frontmatter: source.slice(4, end + 1),
    body: source.slice(source.indexOf("\n", end + 1) + 1),
  };
}

/**
 * The frontmatter Cline reads is two scalar fields. This parses exactly that
 * shape and reports anything else rather than silently accepting it: a nested
 * structure here is a sign the author expected a field Cline does not read.
 */
export function parseFrontmatter(text) {
  const fields = {};
  const problems = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const m = /^([A-Za-z0-9_-]+):\s?(.*)$/.exec(line);
    if (!m) {
      problems.push(`line ${i + 1} is not a 'key: value' pair: ${line.trim().slice(0, 60)}`);
      continue;
    }
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fields[m[1]] = value;
  }
  return { fields, problems };
}

/** Markdown links to bundled files, which Cline resolves with `read_file`. */
function linkedPaths(body) {
  const out = [];
  for (const m of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = m[1].split("#")[0].trim();
    if (!target || /^[a-z]+:/i.test(target)) continue;
    out.push(target);
  }
  return out;
}

export function lintSkill(dir) {
  const errors = [];
  const warnings = [];
  const notes = [];

  const entry = path.join(dir, SKILL_CONTRACT.entry);
  if (!fs.existsSync(entry)) {
    errors.push(
      `no ${SKILL_CONTRACT.entry} in ${dir}. A skill is a directory containing one; ` +
        `without it Cline discovers nothing`
    );
    return { errors, warnings, notes, measured: {} };
  }

  const source = fs.readFileSync(entry, "utf8");
  const { frontmatter, body } = splitFrontmatter(source);

  if (frontmatter === null) {
    errors.push(`${SKILL_CONTRACT.entry} has no YAML frontmatter delimited by --- lines`);
    return { errors, warnings, notes, measured: {} };
  }

  const { fields, problems } = parseFrontmatter(frontmatter);
  for (const p of problems) errors.push(`frontmatter: ${p}`);

  // --- required fields ------------------------------------------------------
  for (const key of SKILL_CONTRACT.required) {
    if (!fields[key]) errors.push(`frontmatter is missing '${key}', which is required`);
  }

  // Anything else is read by nothing. Worth saying, because an author who adds
  // `version:` or `tools:` believes it takes effect.
  const extra = Object.keys(fields).filter((k) => !SKILL_CONTRACT.required.includes(k));
  if (extra.length) {
    warnings.push(
      `frontmatter carries ${extra.join(", ")}, which the skills reference does not ` +
        `document. Cline reads name and description; anything else is inert`
    );
  }

  // --- name -----------------------------------------------------------------
  const dirName = path.basename(path.resolve(dir));
  if (fields.name && fields.name !== dirName) {
    errors.push(
      `name is '${fields.name}' but the directory is '${dirName}'. The reference ` +
        `requires an exact match; a mismatch is a skill that will not load`
    );
  }
  if (fields.name && !SKILL_CONTRACT.namePattern.test(fields.name)) {
    errors.push(`name '${fields.name}' is not kebab-case (lowercase words joined by hyphens)`);
  }

  // --- description ----------------------------------------------------------
  const description = fields.description || "";
  if (description.length > SKILL_CONTRACT.descriptionMax) {
    errors.push(
      `description is ${description.length} characters, over the documented ` +
        `${SKILL_CONTRACT.descriptionMax}`
    );
  }
  if (description && SKILL_CONTRACT.weakDescriptions.some((r) => r.test(description))) {
    warnings.push(
      `the description matches one of the reference's own examples of a description ` +
        `too vague to trigger reliably. It decides when the skill loads at all`
    );
  }
  if (description && description.length < 80) {
    warnings.push(
      `the description is ${description.length} characters. It is the only text Cline ` +
        `matches a request against, and a short one under-triggers`
    );
  }

  // --- body budget ----------------------------------------------------------
  const tokens = estimateTokens(body);
  if (tokens > SKILL_CONTRACT.bodyTokenMax) {
    errors.push(
      `the body is roughly ${tokens} tokens, over the documented ` +
        `${SKILL_CONTRACT.bodyTokenMax}. Move detail into docs/ and link it — ` +
        `referenced files load only when read`
    );
  } else if (tokens > SKILL_CONTRACT.bodyTokenMax * 0.95) {
    warnings.push(
      `the body is roughly ${tokens} tokens, within 5% of the ${SKILL_CONTRACT.bodyTokenMax} ` +
        `budget. This is an estimate, not a tokenizer, so treat the margin as spent`
    );
  }

  // --- bundled files --------------------------------------------------------
  for (const rel of linkedPaths(body)) {
    if (!fs.existsSync(path.join(dir, rel))) {
      errors.push(`${SKILL_CONTRACT.entry} links ${rel}, which does not exist. A dead link is a step nobody can follow`);
    }
  }

  const subdirs = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name);
  const unknown = subdirs.filter((d) => !SKILL_CONTRACT.knownDirs.includes(d));
  if (unknown.length) {
    notes.push(
      `${unknown.join(", ")} are outside the documented docs/ templates/ scripts/ layout. ` +
        `Cline reads bundled files by path, so this works — it is a convention note, not a fault`
    );
  }

  // --- discovery ------------------------------------------------------------
  const abs = path.resolve(dir);
  const parent = path.dirname(abs);
  const discoverable = [...SKILL_CONTRACT.projectRoots, ...SKILL_CONTRACT.globalRoots].some((r) =>
    parent.endsWith(r)
  );
  if (!discoverable) {
    notes.push(
      `${parent} is not one of the documented discovery roots ` +
        `(${SKILL_CONTRACT.projectRoots.join(", ")} in a project, ` +
        `~/.cline/skills globally). Fine for a source tree that gets installed; ` +
        `a skill left here is never found`
    );
  }

  // Global beats project for skills — the reverse of rules — so an old personal
  // copy silently wins and every edit to the project copy does nothing.
  if (fields.name) {
    for (const root of SKILL_CONTRACT.globalRoots) {
      const shadow = path.join(os.homedir(), root, fields.name);
      if (fs.existsSync(shadow) && path.resolve(shadow) !== abs) {
        warnings.push(
          `a global copy exists at ${shadow}. Global skills take precedence over ` +
            `project ones, so that copy is the one that runs`
        );
      }
    }
  }

  return {
    errors,
    warnings,
    notes,
    measured: {
      name: fields.name || "",
      descriptionChars: description.length,
      bodyTokensApprox: tokens,
      subdirs,
    },
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2), {});
  const dir = path.resolve(args.path || path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  const { errors, warnings, notes, measured } = lintSkill(dir);

  if (!args.quiet) {
    process.stdout.write(`skill             ${measured.name || path.basename(dir)}\n`);
    process.stdout.write(`at                ${dir}\n`);
    process.stdout.write(
      `description       ${measured.descriptionChars}/${SKILL_CONTRACT.descriptionMax} chars\n`
    );
    process.stdout.write(
      `body              ~${measured.bodyTokensApprox}/${SKILL_CONTRACT.bodyTokenMax} tokens (estimated)\n`
    );
  }
  for (const n of notes) process.stdout.write(`NOTE   ${n}\n`);
  for (const w of warnings) process.stdout.write(`WARN   ${w}\n`);
  for (const e of errors) process.stderr.write(`ERROR  ${e}\n`);

  if (errors.length) process.exit(2);
  if (warnings.length) process.exit(1);
  if (!args.quiet) process.stdout.write(`\nConforms to the documented skill contract.\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
