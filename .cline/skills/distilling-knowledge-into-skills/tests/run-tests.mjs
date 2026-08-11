#!/usr/bin/env node
// run-tests.mjs — the whole suite, by category.
//
//   node tests/run-tests.mjs              every test
//   node tests/run-tests.mjs negative     only groups whose name matches
//
// Exit 0 all passed, 1 otherwise. Stock Node, no dependencies: a suite that
// needs an install does not run on the machine where it matters.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(here).filter((f) => f.endsWith(".test.mjs")).sort();

for (const f of files) await import(path.join(here, f));

await run(process.argv[2]);
