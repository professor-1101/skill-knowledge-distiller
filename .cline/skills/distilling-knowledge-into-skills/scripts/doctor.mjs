#!/usr/bin/env node
// doctor.mjs — why is Cline not loading this skill?
//
// `skill-lint.mjs` answers "is this package correct". That is a different
// question from "why is my install not working", and until now the second one
// had no mechanical answer at all — which is how a skill with unparseable
// frontmatter sat installed and inert until somebody noticed by hand.
//
// So this looks at the machine rather than at a package: every documented
// discovery location, what is actually in each, which copy would win, and for
// each one the specific things that make Cline skip a directory silently.
//
//   node doctor.mjs [--root .] [--quiet]
//
// Reads only. Exit 0 nothing wrong, 1 something worth knowing, 2 a skill that
// cannot load.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib/jsonl.mjs";
import {
  SKILL_CONTRACT,
  splitFrontmatter,
  parseFrontmatter,
  yamlParserVerdict,
  estimateTokens,
} from "./skill-lint.mjs";

// getting-started/config: CLINE_DATA_DIR "replaces ~/.cline/data/". The skills
// root itself is ~/.cline/skills, but somebody who has relocated their data
// directory has almost certainly moved more than they remember, so it is
// reported rather than silently ignored.
const DATA_DIR_ENV = "CLINE_DATA_DIR";

const home = () => os.homedir();

/** Every place Cline is documented to look, in the order it looks. */
export function discoveryRoots(root) {
  const out = [];
  for (const rel of SKILL_CONTRACT.globalRoots) {
    out.push({ scope: "global", dir: path.join(home(), rel), rel: `~/${rel}` });
  }
  for (const rel of SKILL_CONTRACT.projectRoots) {
    out.push({ scope: "project", dir: path.join(root, rel), rel });
  }
  return out;
}

function listSkillDirs(dir) {
  if (!fs.existsSync(dir)) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return { unreadable: e.message, names: [] };
  }
  return {
    unreadable: null,
    names: entries
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort(),
  };
}

/**
 * The checks that decide whether Cline can load a directory at all.
 *
 * Every one of these produces the same visible symptom — the skill is simply
 * absent from the Skills tab — which is why they have to be enumerated rather
 * than guessed at one at a time.
 */
export function inspect(dir) {
  const findings = [];
  const fail = (m) => findings.push({ level: "error", message: m });
  const warn = (m) => findings.push({ level: "warn", message: m });

  let stat;
  try {
    stat = fs.statSync(dir);
  } catch (e) {
    fail(`cannot be read: ${e.message}`);
    return { findings, name: null };
  }
  if (!stat.isDirectory()) {
    fail(`is not a directory. A skill is a directory containing SKILL.md`);
    return { findings, name: null };
  }
  if (fs.lstatSync(dir).isSymbolicLink()) {
    warn(`is a symlink. Cline follows it here, but a broken or relative link is a skill that vanishes`);
  }

  // The file name is case-sensitive on Linux and macOS-with-case-sensitivity,
  // and `Skill.md` is a plausible typo that reads correctly to a human.
  const names = fs.readdirSync(dir);
  if (!names.includes("SKILL.md")) {
    const near = names.find((n) => n.toLowerCase() === "skill.md");
    fail(
      near
        ? `has '${near}', not 'SKILL.md'. The name is case-sensitive`
        : `has no SKILL.md, so nothing is discovered here`
    );
    return { findings, name: null };
  }

  const entry = path.join(dir, "SKILL.md");
  const buf = fs.readFileSync(entry);

  // A UTF-8 BOM sits in front of the `---`, so the delimiter is no longer the
  // first thing in the file and the frontmatter is never recognised. Editors
  // on Windows add it without asking and show nothing.
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    fail(`SKILL.md starts with a UTF-8 BOM, which pushes the --- off the first byte. Save as UTF-8 without BOM`);
  }
  const source = buf.toString("utf8").replace(/^﻿/, "");
  if (source.includes("\r\n")) {
    warn(`SKILL.md has CRLF line endings. Cline tolerates them; some frontmatter parsers do not`);
  }

  const { frontmatter, body } = splitFrontmatter(source.replace(/\r\n/g, "\n"));
  if (frontmatter === null) {
    fail(`SKILL.md has no --- delimited frontmatter, so it has no name or description to match on`);
    return { findings, name: null };
  }

  const { fields, problems } = parseFrontmatter(frontmatter);
  for (const p of problems) fail(`frontmatter ${p}`);

  const yaml = yamlParserVerdict(frontmatter);
  if (yaml.available && !yaml.ok) {
    fail(`frontmatter does not parse as YAML: ${yaml.error}`);
  }

  const dirName = path.basename(path.resolve(dir));
  if (!fields.name) fail(`frontmatter has no 'name'`);
  else if (fields.name !== dirName) {
    fail(`name is '${fields.name}' but the directory is '${dirName}'. They must match exactly`);
  }

  if (!fields.description) fail(`frontmatter has no 'description', which is what Cline matches a request against`);
  else if (fields.description.length > SKILL_CONTRACT.descriptionMax) {
    fail(`description is ${fields.description.length} characters, over the documented ${SKILL_CONTRACT.descriptionMax}`);
  }

  const tokens = estimateTokens(body);
  if (tokens > SKILL_CONTRACT.bodyTokenMax) {
    warn(`the body is roughly ${tokens} tokens, over the ${SKILL_CONTRACT.bodyTokenMax} guidance. It loads, but crowds the context`);
  }

  for (const m of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = m[1].split("#")[0].trim();
    if (!target || /^[a-z]+:/i.test(target)) continue;
    if (!fs.existsSync(path.join(dir, target))) {
      warn(`links ${target}, which is not there. The skill loads and the step fails`);
    }
  }

  return { findings, name: fields.name || dirName, yaml };
}

/** Anything about the machine that changes where Cline looks. */
function environment() {
  const notes = [];
  if (process.env[DATA_DIR_ENV]) {
    notes.push(
      `${DATA_DIR_ENV} is set to ${process.env[DATA_DIR_ENV]}, which relocates ~/.cline/data/. ` +
        `Skills still resolve from ~/.cline/skills, but confirm that is the install you are editing`
    );
  }
  // A discovered skill can simply be switched off, and a toggle looks exactly
  // like a discovery failure from the outside.
  const settings = path.join(home(), ".cline", "data", "settings", "global-settings.json");
  if (fs.existsSync(settings)) {
    try {
      const raw = fs.readFileSync(settings, "utf8");
      if (/"?skills?"?\s*:/i.test(raw) && /disabled|enabled/i.test(raw)) {
        notes.push(
          `${settings} records skill enable/disable state. If a skill is listed below and still ` +
            `absent in the panel, check its toggle in the Skills tab`
        );
      }
    } catch {
      notes.push(`${settings} exists but could not be read`);
    }
  }
  return notes;
}

export function diagnose(root) {
  const roots = discoveryRoots(root);
  const found = [];
  const rootReports = [];

  for (const r of roots) {
    const listing = listSkillDirs(r.dir);
    if (listing === null) {
      rootReports.push({ ...r, state: "absent", names: [] });
      continue;
    }
    if (listing.unreadable) {
      rootReports.push({ ...r, state: `unreadable: ${listing.unreadable}`, names: [] });
      continue;
    }
    rootReports.push({ ...r, state: "present", names: listing.names });
    for (const name of listing.names) {
      found.push({ ...r, dir: path.join(r.dir, name), dirName: name });
    }
  }

  const inspected = found.map((f) => ({ ...f, ...inspect(f.dir) }));

  // Global beats project for skills — the reverse of rules. Two copies of one
  // name means every edit to the project copy does nothing, and nothing says so.
  const byName = new Map();
  for (const s of inspected) {
    const key = s.name || s.dirName;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(s);
  }
  const shadowed = [...byName.entries()]
    .filter(([, copies]) => copies.length > 1)
    .map(([name, copies]) => ({ name, copies }));

  return { rootReports, inspected, shadowed, envNotes: environment() };
}

function main() {
  const args = parseArgs(process.argv.slice(2), { root: "." });
  const root = path.resolve(args.root);
  const { rootReports, inspected, shadowed, envNotes } = diagnose(root);

  process.stdout.write(`workspace         ${root}\n`);
  process.stdout.write(`home              ${home()}\n\n`);

  process.stdout.write(`Discovery locations, in the order Cline reads them\n`);
  for (const r of rootReports) {
    const what = r.state === "present"
      ? r.names.length ? r.names.join(", ") : "(empty)"
      : r.state;
    process.stdout.write(`  ${r.scope.padEnd(8)} ${r.rel.padEnd(24)} ${what}\n`);
  }

  if (!inspected.length) {
    process.stdout.write(
      `\nNo skill directory in any documented location.\n` +
        `  global   node install.mjs\n` +
        `  project  node install.mjs --project\n` +
        `Global skills apply to every workspace; project skills travel with the repo.\n`
    );
    process.exit(1);
  }

  let errors = 0;
  let warns = 0;
  process.stdout.write(`\nSkills found\n`);
  for (const s of inspected) {
    const bad = s.findings.filter((f) => f.level === "error");
    const soft = s.findings.filter((f) => f.level === "warn");
    errors += bad.length;
    warns += soft.length;
    const verdict = bad.length ? "WILL NOT LOAD" : soft.length ? "loads, with notes" : "loads";
    process.stdout.write(`\n  ${s.dirName}  [${s.scope}]  ${verdict}\n`);
    process.stdout.write(`    ${s.dir}\n`);
    for (const f of bad) process.stdout.write(`    ERROR  ${f.message}\n`);
    for (const f of soft) process.stdout.write(`    warn   ${f.message}\n`);
    if (s.yaml && !s.yaml.available) {
      process.stdout.write(`    note   frontmatter checked by pattern only; no Python with PyYAML here\n`);
    }
  }

  for (const s of shadowed) {
    warns++;
    const winner = s.copies.find((c) => c.scope === "global") || s.copies[0];
    process.stdout.write(
      `\n  SHADOWED  '${s.name}' exists in ${s.copies.length} locations.\n` +
        `    Global skills take precedence over project ones — the reverse of rules — so\n` +
        `    ${winner.dir}\n    is the copy that runs. Edits to the others do nothing.\n`
    );
  }

  for (const n of envNotes) process.stdout.write(`\n  NOTE  ${n}\n`);

  if (errors) {
    process.stdout.write(
      `\n${errors} problem(s) that stop a skill loading. Fix those, then fully quit and\n` +
        `reopen your editor — skills are read at startup, and reloading the window is\n` +
        `not always enough.\n`
    );
    process.exit(2);
  }
  process.stdout.write(
    `\nEverything here should load.${warns ? ` ${warns} note(s) above.` : ""}\n` +
      `Skills are read at startup, so if the Skills tab still does not list it, either\n` +
      `the editor has not been fully restarted since the install — reloading the window\n` +
      `is not always enough — or the skill is discovered and toggled off in that tab.\n`
  );
  process.exit(warns ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
