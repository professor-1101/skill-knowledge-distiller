// harness.mjs — a test runner small enough to trust.
//
// Stock Node, no dependencies, because the whole skill is copied into
// ~/.cline/skills/ where nothing is installed. A test suite that needs an
// install is a test suite that does not run on the machine it matters on.
//
// Tests are grouped by category rather than by file, because the categories
// are the argument: a suite of only positive cases measures nothing, and
// naming the negative, integrity and determinism groups separately makes it
// visible when one of them is thin.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const groups = [];
let current = null;

export function describe(name, fn) {
  current = { name, tests: [] };
  groups.push(current);
  fn();
  current = null;
}

export function it(name, fn) {
  if (!current) throw new Error(`it(${JSON.stringify(name)}) outside describe()`);
  current.tests.push({ name, fn });
}

export function assert(cond, message = "assertion failed") {
  if (!cond) throw new Error(message);
}

export function equal(actual, expected, message = "") {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${message || "not equal"}\n    expected ${trunc(e)}\n    actual   ${trunc(a)}`);
  }
}

export function includes(haystack, needle, message = "") {
  const h = String(haystack);
  if (!h.includes(needle)) {
    throw new Error(`${message || "does not contain"} ${JSON.stringify(needle)}\n    in ${trunc(h)}`);
  }
}

/** A gate is only proven by what it refuses, so refusal gets a first-class assertion. */
export function refuses(fn, pattern, message = "") {
  let threw = null;
  try {
    fn();
  } catch (e) {
    threw = e;
  }
  if (!threw) throw new Error(`${message || "expected a refusal"} — nothing was thrown`);
  const m = String(threw.message);
  if (pattern && !(pattern instanceof RegExp ? pattern.test(m) : m.includes(pattern))) {
    throw new Error(`refused, but for the wrong reason: ${trunc(m)}`);
  }
  return threw;
}

function trunc(s) {
  return s.length > 300 ? s.slice(0, 300) + "…" : s;
}

/** A throwaway directory, removed however the test ends. */
export function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "distill-test-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function run(filter) {
  let pass = 0;
  const failures = [];
  const t0 = Date.now();

  for (const g of groups) {
    if (filter && !g.name.toLowerCase().includes(filter.toLowerCase())) continue;
    process.stdout.write(`\n${g.name}\n`);
    for (const t of g.tests) {
      try {
        await t.fn();
        pass++;
        process.stdout.write(`  pass  ${t.name}\n`);
      } catch (e) {
        failures.push({ group: g.name, name: t.name, error: e });
        process.stdout.write(`  FAIL  ${t.name}\n`);
      }
    }
  }

  const ms = Date.now() - t0;
  if (failures.length) {
    process.stdout.write(`\n${failures.length} FAILED of ${pass + failures.length}  (${ms}ms)\n\n`);
    for (const f of failures) {
      process.stdout.write(`  ${f.group} › ${f.name}\n    ${String(f.error.message).replace(/\n/g, "\n    ")}\n\n`);
    }
    process.exit(1);
  }
  process.stdout.write(`\n${pass} passed  (${ms}ms)\n`);
}
