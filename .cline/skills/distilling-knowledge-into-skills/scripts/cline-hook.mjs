// cline-hook.mjs — the Cline file-based hook handlers.
//
// Cline has two hook systems and they are easy to conflate. The SDK one lives
// inside an `AgentPlugin.hooks` object as TypeScript handlers, with *stage*
// names like `tool_call_before`; it needs a plugin, which rules it out for the
// VS Code and JetBrains extensions. The file-based one discovers executables
// named after the *hook type* in a hooks directory, and needs no plugin.
//
// This is the second. The contract:
//
//   location    .clinerules/hooks/ (project) or ~/Documents/Cline/Rules/Hooks/
//   name        exactly the hook type, no extension, executable
//   stdin       one JSON object: clineVersion, hookName, timestamp, taskId,
//               workspaceRoots, userId, plus per-hook fields
//   stdout      one JSON object: { cancel, errorMessage, contextModification }
//   exit 2      PreToolUse only — blocks the tool call, stderr goes to the model
//
// Everything here delegates to the same `check-store.mjs` and `activate.mjs`
// the git tier runs, so the two can never disagree about the rules.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SKILL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Artifacts only the governed pipeline may produce. */
const GUARDED = [
  "claims/", "sources/converted/",
  "rules.jsonl", "frameworks.jsonl", "dispositions.jsonl", "anti-patterns.jsonl",
  "resolutions.jsonl", "probes.jsonl", "corpus.jsonl", "checkpoints.jsonl",
];

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * A hook that cannot parse its input must not block.
 *
 * Fail-open on our own bugs is deliberate: a gate that refuses because it
 * crashed halts the pipeline for a reason that has nothing to do with the
 * work. The git tier still catches whatever this misses, so a silent pass here
 * is recoverable and a spurious block is not.
 */
function parseInput(raw) {
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function respond({ cancel = false, errorMessage, contextModification } = {}) {
  const out = { cancel };
  if (errorMessage) out.errorMessage = errorMessage;
  if (contextModification) out.contextModification = contextModification;
  process.stdout.write(JSON.stringify(out));
}

function workspaceRoot(input) {
  const roots = input.workspaceRoots;
  if (Array.isArray(roots) && roots.length) {
    return typeof roots[0] === "string" ? roots[0] : roots[0].path || process.cwd();
  }
  return process.cwd();
}

/** Every path a tool call is about to touch, across the shapes Cline uses. */
function targetPaths(input) {
  const t = input.toolInput || input.parameters || input.input || {};
  const out = [];
  for (const k of ["path", "file_path", "filePath", "target", "destination"]) {
    if (typeof t[k] === "string") out.push(t[k]);
  }
  if (Array.isArray(t.paths)) out.push(...t.paths.filter((p) => typeof p === "string"));
  if (Array.isArray(t.files)) out.push(...t.files.filter((p) => typeof p === "string"));
  return out;
}

function isGuarded(root, p) {
  const rel = path.relative(path.resolve(root), path.resolve(root, p)).split(path.sep).join("/");
  if (rel.startsWith("..")) return false;
  return GUARDED.some((g) => (g.endsWith("/") ? rel.startsWith(g) : rel === g));
}

function runScript(name, args, cwd) {
  try {
    const out = execFileSync("node", [path.join(SKILL_DIR, "scripts", name), ...args], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || "") + (e.stderr || "") };
  }
}

const HANDLERS = {
  /**
   * Announce the methodology and record which SKILL.md was loaded.
   *
   * `contextModification` is how a file-based hook injects text into the
   * conversation, which is exactly what the activation ruleset is for.
   */
  TaskStart(input) {
    const root = workspaceRoot(input);
    const r = runScript("activate.mjs", ["--root", root], root);
    respond({ contextModification: r.code === 0 ? r.out.trim() : undefined });
  },

  /**
   * Refuse a write into the claim store while the methodology is not active,
   * or while the loaded procedure is not the current one.
   *
   * Only this hook can block, so only this one exits 2.
   */
  PreToolUse(input) {
    const root = workspaceRoot(input);
    const paths = targetPaths(input).filter((p) => isGuarded(root, p));
    if (!paths.length) {
      respond({ cancel: false });
      return 0;
    }
    const r = runScript("activate.mjs", ["--root", root, "--gate"], root);
    if (r.code === 0) {
      respond({ cancel: false });
      return 0;
    }
    const reason = r.out.trim() || "the knowledge-distillation methodology is not active";
    respond({ cancel: true, errorMessage: reason });
    // Exit 2 blocks the call and hands stderr to the model. Both channels are
    // used: the JSON is the documented contract, the exit code is the
    // belt-and-braces for a runtime that only reads one of them.
    process.stderr.write(reason + "\n");
    return 2;
  },

  /** Validate what was just written and hand the rejections back. */
  PostToolUse(input) {
    const root = workspaceRoot(input);
    const paths = targetPaths(input).filter((p) => isGuarded(root, p));
    if (!paths.length) {
      respond({ cancel: false });
      return 0;
    }
    const r = runScript("check-store.mjs", ["--root", root, "--profile", "strict", "--quiet"], root);
    // Only exit code 2 means something needs attention; 1 is warnings, which a
    // store part-way through the pipeline legitimately carries.
    respond({
      cancel: false,
      contextModification: r.code >= 2 ? `CLAIM STORE REJECTED THE WRITE\n\n${r.out.trim()}` : undefined,
    });
    return 0;
  },
};

export const HOOK_TYPES = Object.keys(HANDLERS);

export function run(hookName) {
  const handler = HANDLERS[hookName];
  if (!handler) {
    respond({ cancel: false });
    return;
  }
  let code = 0;
  try {
    code = handler(parseInput(readStdin())) || 0;
  } catch (e) {
    // See parseInput: our own failure must not stop the user's work.
    respond({ cancel: false });
    process.stderr.write(`distill hook ${hookName} failed: ${e.message}\n`);
    code = 0;
  }
  process.exit(code);
}
