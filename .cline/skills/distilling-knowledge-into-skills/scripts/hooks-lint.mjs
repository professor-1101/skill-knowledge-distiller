#!/usr/bin/env node
// hooks-lint.mjs — check the Cline hooks against the documented contract,
// statically.
//
// The hook tier cannot be proven by running it: that needs a live Cline, and
// the environment this was built in has none. What *can* be done is check the
// generated files against the contract as documented — location, name,
// executability, the shape of what they read and write, and the exit codes
// they use. That is a real check with a stated limit, which is better than an
// untested tier described as "probably fine".
//
// It exists because the first attempt at this tier was wrong on four counts at
// once: SDK stage names used as file names, the wrong directory, no stdin
// handling, and no JSON response. Every one of those is statically visible.
//
//   node hooks-lint.mjs [--root .] [--quiet]
//
// Exit 0 conforming, 1 warnings, 2 a contract violation.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "./lib/jsonl.mjs";

/**
 * The contract, as documented by Cline.
 *
 * Two hook systems exist and conflating them is the trap this file guards.
 * The SDK system is TypeScript handlers inside an `AgentPlugin.hooks` object,
 * keyed by *stage* (`tool_call_before`, `session_start`, …), and it needs a
 * plugin — which the VS Code and JetBrains extensions do not support. The
 * file-based system below needs no plugin, which is why it is the one used.
 */
export const CONTRACT = {
  projectDir: path.join(".clinerules", "hooks"),
  globalDir: path.join("Documents", "Cline", "Rules", "Hooks"),
  // Named after the hook *type*, exactly, with no extension.
  types: [
    "PreToolUse", "PostToolUse", "UserPromptSubmit",
    "TaskStart", "TaskResume", "TaskCancel", "TaskComplete",
  ],
  // Only PreToolUse can stop anything. An exit 2 anywhere else is a
  // misunderstanding that will look like it works until it matters.
  blocking: ["PreToolUse"],
  responseFields: ["cancel", "errorMessage", "contextModification"],
  // Stage names from the *other* system. Their presence as file names is the
  // specific mistake this lint was written after making.
  sdkStages: [
    "input", "runtime_event", "session_start", "run_start", "iteration_start",
    "turn_start", "before_agent_start", "tool_call_before", "tool_call_after",
    "turn_end", "stop_error", "iteration_end", "run_end", "session_shutdown", "error",
  ],
};

/**
 * Follow a generated shim to the module that actually implements it.
 * The shim is deliberately thin, so linting only the shim would check nothing.
 */
function resolveImplementation(root, hookFile, body) {
  const m = /path\.resolve\(__dirname,\s*"([^"]*)"\s*,\s*"scripts"\s*,\s*"([^"]+)"\)/.exec(body);
  if (!m) return null;
  const target = path.resolve(path.dirname(hookFile), m[1], "scripts", m[2]);
  return fs.existsSync(target) ? { path: target, source: fs.readFileSync(target, "utf8") } : { path: target, source: null };
}

/** Parse the hook in whatever language its shebang declares. */
function checkSyntax(file, shebang) {
  const tryRun = (cmd, args, lang) => {
    try {
      execFileSync(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
      return null;
    } catch (e) {
      const msg = String(e.stderr || e.message).split("\n").filter(Boolean)[0] || "unknown";
      return { lang, message: msg.slice(0, 160) };
    }
  };
  if (/\bnode\b/.test(shebang)) return tryRun("node", ["--check", file], "JavaScript");
  if (/\b(sh|bash|dash)\b/.test(shebang)) return tryRun("sh", ["-n", file], "shell");
  if (/\bpython3?\b/.test(shebang)) return tryRun("python3", ["-m", "py_compile", file], "Python");
  return null;
}

export function lintHooks(root) {
  const errors = [];
  const warnings = [];
  const notes = [];

  const dir = path.join(root, CONTRACT.projectDir);
  const legacy = path.join(root, ".cline", "hooks");

  if (fs.existsSync(legacy)) {
    errors.push(
      `.cline/hooks/ exists. Cline discovers file-based hooks in ${CONTRACT.projectDir}/ ` +
        `and ~/${CONTRACT.globalDir}/, so anything here is never read — a gate that ` +
        `is never invoked is worse than no gate, because it looks installed`
    );
  }

  if (!fs.existsSync(dir)) {
    notes.push(`no ${CONTRACT.projectDir}/ — the Cline tier is not installed (the git tier is separate)`);
    return { errors, warnings, notes, checked: 0 };
  }

  const entries = fs.readdirSync(dir).filter((f) => !f.startsWith("."));
  let checked = 0;

  for (const name of entries) {
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) continue;
    checked++;

    // --- name -------------------------------------------------------------
    if (CONTRACT.sdkStages.includes(name)) {
      errors.push(
        `'${name}' is an SDK plugin *stage* name, not a file-based hook type. ` +
          `Those are two different systems: stages live in an AgentPlugin.hooks ` +
          `object and need a plugin. Rename to one of ${CONTRACT.types.join(", ")}`
      );
      continue;
    }
    if (!CONTRACT.types.includes(name)) {
      if (path.extname(name)) {
        errors.push(`'${name}' has an extension. The file name must be exactly the hook type, with none`);
      } else {
        errors.push(`'${name}' is not a Cline hook type. Known types: ${CONTRACT.types.join(", ")}`);
      }
      continue;
    }

    // --- executable -------------------------------------------------------
    if (process.platform !== "win32" && !(stat.mode & 0o111)) {
      errors.push(`'${name}' is not executable, so Cline will discover it and never run it`);
    }

    const body = fs.readFileSync(file, "utf8");

    // --- shebang ----------------------------------------------------------
    if (!body.startsWith("#!")) {
      errors.push(`'${name}' has no shebang; an executable hook needs one to be runnable directly`);
    }

    // --- it has to parse ---------------------------------------------------
    // A hook that is discovered, executable and syntactically invalid fails at
    // the moment it matters and looks installed until then. This check exists
    // because the first generated set used a `#` comment marker in a
    // JavaScript file: correct in shell, a syntax error here.
    const shebang = body.split("\n", 1)[0];
    const syntax = checkSyntax(file, shebang);
    if (syntax) {
      errors.push(`'${name}' does not parse as ${syntax.lang}: ${syntax.message}`);
      continue;
    }

    // --- the contract, in whichever file actually implements it -----------
    const impl = resolveImplementation(root, file, body);
    if (impl && impl.source === null) {
      errors.push(`'${name}' delegates to ${path.relative(root, impl.path)}, which does not exist`);
      continue;
    }
    const source = impl ? impl.source : body;
    const where = impl ? path.relative(root, impl.path) : name;

    if (!/readFileSync\(0|process\.stdin|\bcat\b/.test(source)) {
      errors.push(
        `'${name}' never reads stdin (${where}). Every hook receives a JSON object there — ` +
          `a hook that ignores it is deciding without the input it was given`
      );
    }

    const emits = CONTRACT.responseFields.filter((f) => source.includes(f));
    if (!emits.includes("cancel")) {
      errors.push(
        `'${name}' never emits a 'cancel' field (${where}). The response is a JSON object on ` +
          `stdout, and 'cancel' is what says whether to proceed`
      );
    }

    // --- exit codes -------------------------------------------------------
    const usesTwo = /\b(exit|code)\s*[=(]?\s*2\b|return 2\b|process\.exit\(2\)/.test(source) ||
      new RegExp(`return 2`).test(source);
    const isBlocking = CONTRACT.blocking.includes(name);
    if (usesTwo && !isBlocking && impl && !impl.source.includes(`${name}(input)`)) {
      warnings.push(
        `'${name}' appears to use exit code 2, which only blocks for ${CONTRACT.blocking.join(", ")}. ` +
          `Elsewhere it reads as enforcement and is not`
      );
    }
    if (isBlocking && !usesTwo) {
      warnings.push(
        `'${name}' never uses exit code 2, which is the documented way to block a tool call. ` +
          `The JSON 'cancel' field alone may be enough, but relying on one channel is a bet`
      );
    }
  }

  // --- coverage -----------------------------------------------------------
  const present = entries.filter((f) => CONTRACT.types.includes(f));
  if (!present.includes("PreToolUse")) {
    warnings.push("no PreToolUse hook — nothing refuses a write into the claim store at the Cline tier");
  }
  const globalDir = path.join(os.homedir(), CONTRACT.globalDir);
  if (fs.existsSync(globalDir)) {
    const shadowed = fs.readdirSync(globalDir).filter((f) => present.includes(f));
    if (shadowed.length) {
      notes.push(
        `${shadowed.join(", ")} also exist in ~/${CONTRACT.globalDir}/. Which copy wins is ` +
          `worth confirming before relying on either`
      );
    }
  }

  return { errors, warnings, notes, checked };
}

function main() {
  const args = parseArgs(process.argv.slice(2), { root: "." });
  const { errors, warnings, notes, checked } = lintHooks(args.root);

  if (!args.quiet) {
    process.stdout.write(`contract          Cline file-based hooks\n`);
    process.stdout.write(`location          ${CONTRACT.projectDir}/\n`);
    process.stdout.write(`hooks checked     ${checked}\n`);
  }
  for (const n of notes) process.stdout.write(`NOTE   ${n}\n`);
  for (const w of warnings) process.stdout.write(`WARN   ${w}\n`);
  for (const e of errors) process.stderr.write(`ERROR  ${e}\n`);

  if (errors.length) {
    process.stderr.write(
      `\n${errors.length} contract violation(s). This is static analysis: it proves the files\n` +
        `match the documented contract, not that a running Cline invokes them. The git\n` +
        `tier is what the guarantee rests on.\n`
    );
    process.exit(2);
  }
  if (warnings.length) process.exit(1);
  if (!args.quiet) {
    process.stdout.write(
      `\nConforms to the documented contract. Statically — a live Cline has not been\n` +
        `observed running these, and this check does not claim otherwise.\n`
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
