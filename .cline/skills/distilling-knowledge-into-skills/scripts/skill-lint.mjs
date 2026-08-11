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
import { execFileSync } from "node:child_process";
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
  // getting-started/config: "Global rules, hooks, skills, agents, plugins, and
  // cron specs resolve directly under ~/.cline/". One path, not two — an
  // earlier version also listed ~/.cline/data/settings/skills, inferred from
  // the CLI reference's tree. That directory holds providers, global settings
  // and MCP config; no skill is read from it. The same page says global config
  // "applies globally across all Cline applications, including IDE, CLI, and
  // SDK", so this covers the editor extensions too.
  globalRoots: [path.join(".cline", "skills")],
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
 * Whether an unquoted YAML value is a legal plain scalar.
 *
 * This is the check whose absence let a skill ship that no YAML parser could
 * read. A plain scalar may not contain `: ` — a colon followed by space opens
 * a nested mapping, and a real parser stops with "mapping values are not
 * allowed here" while a naive line splitter takes the first colon and reports
 * everything as fine. Same for ` #`, which starts a comment, and for the
 * indicator characters that mean something structural in first position.
 *
 * Returns null when the value is safe, or the reason it is not.
 */
export function plainScalarProblem(value) {
  if (!value) return null;
  if (/:\s/.test(value)) {
    const at = value.search(/:\s/);
    return `contains ': ' near "${value.slice(Math.max(0, at - 30), at + 12)}". In an unquoted ` +
      `YAML value a colon followed by a space opens a nested mapping, so the whole file fails ` +
      `to parse and the skill never loads. Use a dash or a comma, or quote the value`;
  }
  if (/\s#/.test(value)) {
    // This one parses. It just quietly throws away everything after the hash,
    // which for a description means a skill that stops triggering and gives no
    // sign why. Checked against PyYAML: `d: a #b` yields `a`.
    return `contains ' #', which starts a YAML comment and silently truncates the value`;
  }
  const first = value[0];
  if ("-?[]{},&*!|>%@`".includes(first)) {
    return `starts with '${first}', a YAML indicator character. Quote the value or reword it`;
  }
  // A trailing colon breaks the parse the same way `: ` does. A trailing space
  // does not — YAML strips it — so it is not flagged. Every severity here was
  // set by running the case through a real parser rather than by reasoning
  // about the spec, which is how the over-strict version got written.
  if (value.endsWith(":")) {
    return `ends with a colon, which opens a mapping and fails the parse`;
  }
  return null;
}

/**
 * Ask a real YAML parser whether the frontmatter is valid.
 *
 * The check above is a heuristic, and a heuristic is exactly how a skill
 * shipped that no parser could read. So where a real one is available it gets
 * the deciding vote. Nothing requires it: a skill copied into ~/.cline/skills/
 * never gets an `npm install`, and Node has no YAML parser, so the heuristic
 * has to stand alone when Python is absent.
 *
 * Returns { available, ok, error }. `available: false` means the question was
 * not asked — reported, never treated as a pass.
 */
export function yamlParserVerdict(frontmatter) {
  const probe = `import sys,yaml
try:
    d = yaml.safe_load(sys.stdin.read())
except Exception as e:
    print("ERR " + str(e).split("\\n")[0]); sys.exit(0)
print("OK" if isinstance(d, dict) else "ERR frontmatter is not a mapping")`;
  for (const python of ["python3", "python"]) {
    try {
      const out = execFileSync(python, ["-c", probe], {
        input: frontmatter,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();
      if (out.startsWith("OK")) return { available: true, ok: true, error: null };
      return { available: true, ok: false, error: out.replace(/^ERR /, "") };
    } catch {
      // No interpreter, or no PyYAML. Try the next name, then give up quietly.
    }
  }
  return { available: false, ok: null, error: null };
}

/**
 * The frontmatter Cline reads is two scalar fields. This parses exactly that
 * shape and reports anything else rather than silently accepting it: a nested
 * structure here is a sign the author expected a field Cline does not read.
 *
 * Parsing leniently and validating strictly is deliberate. A tolerant parser
 * that never complains is how a broken file gets a clean report.
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
    const raw = m[2];
    let value = raw;
    const quoted =
      (raw.startsWith('"') && raw.endsWith('"') && raw.length > 1) ||
      (raw.startsWith("'") && raw.endsWith("'") && raw.length > 1);
    if (quoted) {
      value = raw.slice(1, -1);
    } else {
      const bad = plainScalarProblem(raw);
      if (bad) problems.push(`line ${i + 1}, '${m[1]}' ${bad}`);
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

  // A real parser gets the deciding vote where one exists. The heuristic
  // stands alone otherwise, and says so rather than implying it was confirmed.
  const yaml = yamlParserVerdict(frontmatter);
  if (yaml.available && !yaml.ok) {
    errors.push(
      `frontmatter does not parse as YAML: ${yaml.error}. Cline reads this file with a ` +
        `real parser, so the skill will be discovered and never load`
    );
  } else if (!yaml.available) {
    notes.push(
      `no Python with PyYAML here, so the frontmatter was checked by pattern only. ` +
        `Install one to have a real parser confirm it`
    );
  }

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
