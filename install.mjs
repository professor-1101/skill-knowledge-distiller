#!/usr/bin/env node
// install.mjs — put the skill where Cline will find it, and take it away again.
//
// Stock Node, no dependencies, because a skill directory copied into
// ~/.cline/skills/ never gets an `npm install` and an installer that needs one
// cannot bootstrap the thing it installs.
//
//   node install.mjs              install or update for every project
//   node install.mjs --path DIR   install into DIR/distilling-knowledge-into-skills
//   node install.mjs --project    install into ./.cline/skills so a team shares it via git
//   node install.mjs --check      what is installed and what you changed; writes nothing
//   node install.mjs --force      update anyway, discarding local edits
//   node install.mjs --uninstall  remove this skill and nothing else
//
// An update **refuses when the installed copy has been edited**, naming the
// files, and writes nothing when it refuses. Silently overwriting somebody's
// changes is the behaviour that gets an installer deleted.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const NAME = "distilling-knowledge-into-skills";
const VERSION = "1.0.0";
const MANIFEST = ".install-manifest.json";

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(here, ".cline", "skills", NAME);

// What ships. Anything not listed is development scaffolding and stays here:
// an installed copy carries what the skill needs to run and to be re-verified,
// and nothing else.
const CONTENTS = ["SKILL.md", "docs", "scripts", "templates", "evals", "tests"];

// Cline's own documentation names two global locations, and both are official.
// Writing the first and reporting the second beats guessing which one this
// machine reads.
const GLOBAL_CANDIDATES = [
  path.join(os.homedir(), ".cline", "skills"),
  path.join(os.homedir(), ".cline", "data", "settings", "skills"),
];

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name === MANIFEST) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

function sourceFiles() {
  const files = [];
  for (const entry of CONTENTS) {
    const full = path.join(SOURCE, entry);
    if (!fs.existsSync(full)) continue;
    if (fs.statSync(full).isDirectory()) {
      for (const rel of walk(full, SOURCE)) files.push(rel);
    } else {
      files.push(entry);
    }
  }
  return files.sort();
}

function digestsOf(root, files) {
  const out = {};
  for (const rel of files) {
    const full = path.join(root, rel);
    if (fs.existsSync(full)) out[rel] = sha256(fs.readFileSync(full));
  }
  return out;
}

function readManifest(target) {
  const f = path.join(target, MANIFEST);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}

/**
 * What the user changed since the last install.
 *
 * Compared against the manifest rather than against the source, so an edit is
 * distinguished from a version difference. Without that, every update would
 * look like a conflict.
 */
function localEdits(target, manifest) {
  if (!manifest || !manifest.files) return [];
  const changed = [];
  for (const [rel, digest] of Object.entries(manifest.files)) {
    const full = path.join(target, rel);
    if (!fs.existsSync(full)) changed.push(`${rel} (deleted)`);
    else if (sha256(fs.readFileSync(full)) !== digest) changed.push(rel);
  }
  return changed;
}

/**
 * Where the skill goes.
 *
 * `--path` is read as the skills directory unless it already ends in the skill
 * name, in which case it is the skill directory itself. Both readings land in
 * the same place, and the alternative — honouring a `--path` whose basename is
 * something else — installs a skill Cline will never load, because the
 * reference requires `name` to match the directory exactly. `skill-lint.mjs`
 * catches that; better not to create it.
 */
function resolveTarget(args) {
  if (args.path) {
    const p = path.resolve(args.path);
    return path.basename(p) === NAME ? p : path.join(p, NAME);
  }
  if (args.project) return path.resolve(args.root || ".", ".cline", "skills", NAME);
  return path.join(GLOBAL_CANDIDATES[0], NAME);
}

function copyInto(target, files) {
  for (const rel of files) {
    const from = path.join(SOURCE, rel);
    const to = path.join(target, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    // Hook shims and CLI entry points are executable at the source and must
    // stay so: a hook Cline discovers and cannot execute is worse than absent.
    const mode = fs.statSync(from).mode;
    if (mode & 0o111) fs.chmodSync(to, 0o755);
  }
}

function check(target) {
  const manifest = readManifest(target);
  if (!fs.existsSync(target)) {
    process.stdout.write(`not installed at ${target}\n`);
    return 0;
  }
  if (!manifest) {
    process.stdout.write(
      `installed at ${target}, but with no manifest.\n` +
        `Nothing can be compared, so an update here will install and start tracking\n` +
        `rather than accuse you of edits it cannot know about.\n`
    );
    return 0;
  }
  process.stdout.write(`installed         ${manifest.name} ${manifest.version}\n`);
  process.stdout.write(`at                ${target}\n`);
  process.stdout.write(`on                ${manifest.installed_at}\n`);
  process.stdout.write(`this copy is      ${VERSION}\n`);

  const edits = localEdits(target, manifest);
  if (!edits.length) {
    process.stdout.write(`local edits       none\n`);
    return 0;
  }
  process.stdout.write(`local edits       ${edits.length}\n`);
  for (const f of edits.slice(0, 20)) process.stdout.write(`  ${f}\n`);
  if (edits.length > 20) process.stdout.write(`  ... ${edits.length - 20} more\n`);
  process.stdout.write(`\nAn update would refuse. Pass --force to discard these.\n`);
  return 1;
}

function install(target, args) {
  const files = sourceFiles();
  if (!files.length) {
    process.stderr.write(`BLOCKED: nothing to install — ${SOURCE} has no skill in it\n`);
    return 2;
  }

  const manifest = readManifest(target);
  if (manifest && !args.force) {
    const edits = localEdits(target, manifest);
    if (edits.length) {
      process.stderr.write(
        `REFUSED: the installed copy at\n  ${target}\nhas ${edits.length} edited file(s):\n` +
          edits.slice(0, 20).map((f) => `  ${f}\n`).join("") +
          (edits.length > 20 ? `  ... ${edits.length - 20} more\n` : "") +
          `\nNothing was written. Copy your changes somewhere safe, or pass --force to\n` +
          `discard them. Overwriting them silently is not something an installer\n` +
          `should decide on your behalf.\n`
      );
      return 2;
    }
  }

  // Files the previous install wrote and this one does not: left behind, they
  // are a stale doc or script that still loads and no longer matches anything.
  const stale = manifest && manifest.files
    ? Object.keys(manifest.files).filter((rel) => !files.includes(rel))
    : [];

  fs.mkdirSync(target, { recursive: true });
  copyInto(target, files);
  for (const rel of stale) {
    const full = path.join(target, rel);
    if (fs.existsSync(full)) fs.rmSync(full);
  }

  fs.writeFileSync(
    path.join(target, MANIFEST),
    JSON.stringify(
      { name: NAME, version: VERSION, installed_at: new Date().toISOString(), files: digestsOf(target, files) },
      null,
      2
    ) + "\n",
    "utf8"
  );

  process.stdout.write(`installed         ${NAME} ${VERSION}\n`);
  process.stdout.write(`to                ${target}\n`);
  process.stdout.write(`files             ${files.length}${stale.length ? `  (${stale.length} stale removed)` : ""}\n`);

  if (!args.project && !args.path) {
    const other = GLOBAL_CANDIDATES[1];
    process.stdout.write(
      `\nCline documents two global locations and both are official. This wrote the\n` +
        `first; if your install reads the second, copy it to:\n  ${other}\n`
    );
  }
  // Global beats project for skills — the reverse of rules. Someone keeping an
  // old personal copy silently overrides the team's, and every edit they make
  // to the project copy does nothing.
  const shadowing = args.project
    ? GLOBAL_CANDIDATES.map((d) => path.join(d, NAME)).filter((d) => fs.existsSync(d))
    : [];
  if (shadowing.length) {
    process.stdout.write(
      `\nWARNING: a global copy exists at\n  ${shadowing[0]}\n` +
        `Global skills take precedence over project ones — the reverse of rules — so\n` +
        `the copy just installed will not be the one that runs.\n`
    );
  }
  process.stdout.write(`\nStart a new session: skills are read at startup.\n`);
  return 0;
}

function uninstall(target) {
  if (!fs.existsSync(target)) {
    process.stdout.write(`nothing installed at ${target}\n`);
    return 0;
  }
  const manifest = readManifest(target);
  const edits = manifest ? localEdits(target, manifest) : [];
  if (edits.length) {
    process.stdout.write(
      `note: removing ${edits.length} edited file(s) along with the rest — ` +
        `they are inside the skill directory:\n` +
        edits.slice(0, 10).map((f) => `  ${f}\n`).join("")
    );
  }
  fs.rmSync(target, { recursive: true, force: true });
  process.stdout.write(`removed           ${target}\n`);
  process.stdout.write(`\nOnly this skill. Anything else in that directory is untouched.\n`);
  return 0;
}

function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else out[key] = true;
  }
  return out;
}

function main() {
  const args = parse(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n")
      .filter((l) => l.startsWith("//")).map((l) => l.replace(/^\/\/ ?/, "")).join("\n") + "\n");
    return;
  }
  const target = resolveTarget(args);
  let code;
  if (args.check) code = check(target);
  else if (args.uninstall) code = uninstall(target);
  else code = install(target, args);
  process.exit(code);
}

main();
