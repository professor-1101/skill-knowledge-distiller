// pipeline.test.mjs — the store, end to end and under attack.
//
// Five categories against a real store built from a fixture book: that the
// pipeline runs, that tampering is caught, that derivation is reproducible,
// that nothing is hand-maintained, and that work resumes without corruption.
//
// Every case drives the actual scripts as a user would, because a test that
// calls internals proves the internals work and not the thing shipped.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it, assert, equal, includes } from "./harness.mjs";
import { plain, nestedToc, imagesAndSizes, buildZip, entry, opf, xhtml, MIMETYPE, CONTAINER } from "./fixtures/epub.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = (n) => path.join(root, "scripts", n);

function sh(name, args, cwd, { allowFail = false } = {}) {
  try {
    return { ok: true, out: execFileSync("node", [script(name), "--root", ".", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    if (!allowFail) throw new Error(`${name} failed:\n${e.stdout || ""}${e.stderr || ""}`);
    return { ok: false, out: (e.stdout || "") + (e.stderr || ""), code: e.status };
  }
}

const jsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

/** A store built by running the real pipeline over a fixture book. */
function buildStore(fixture, { depth = 2, target = 400 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "distill-store-"));
  fs.writeFileSync(path.join(dir, "book.epub"), fixture.epub);
  sh("ingest.mjs", ["--source", "book.epub", "--slug", "book"], dir, { allowFail: true });
  sh("enumerate.mjs", ["--slug", "book", "--depth", String(depth)], dir, { allowFail: true });
  sh("chunk.mjs", ["--slug", "book", "--target-chars", String(target)], dir, { allowFail: true });
  return dir;
}

const cleanup = [];
function store(fixture, opts) {
  const d = buildStore(fixture, opts);
  cleanup.push(d);
  return d;
}
process.on("exit", () => cleanup.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

// ---------------------------------------------------------------------------
describe("e2e · the pipeline runs over a book", () => {
  const dir = store(nestedToc());

  it("ingests into segments with derived metadata", () => {
    const pages = jsonl(path.join(dir, "sources/converted/book/pages.jsonl"));
    equal(pages.length, 2);
    assert(pages.every((p) => p.locator_scheme === "epub-spine"), "every segment records its locator scheme");
    assert(pages.every((p) => p.kind), "kind is derived at ingest, never left unset");
    assert(pages.every((p) => p.text_sha256 && p.char_count > 0), "digest and length are recorded");
  });

  it("enumerates the denominator from the book's own contents", () => {
    const corpus = jsonl(path.join(dir, "corpus.jsonl"));
    equal(corpus.map((u) => u.title), ["Part One", "Section 1.1", "Section 1.2", "Part Two"]);
    assert(corpus.every((u) => u.grain === "toc"), "every unit was transcribed, none invented");
  });

  it("gives every chunk a unit", () => {
    const chunks = jsonl(path.join(dir, "sources/converted/book/chunks.jsonl"));
    assert(chunks.length > 0, "the book produced chunks");
    equal(chunks.filter((c) => !c.unit).map((c) => c.id), [], "a chunk with no unit is text coverage cannot see");
  });

  it("gives every chunk a locator that resolves to the source", () => {
    const chunks = jsonl(path.join(dir, "sources/converted/book/chunks.jsonl"));
    for (const c of chunks) {
      assert(/^.+@\d+-\d+$/.test(c.locator), `locator ${c.locator} must name a document and a span`);
    }
  });

  it("passes every gate, digests included", () => {
    const r = sh("check-store.mjs", ["--verify"], dir, { allowFail: true });
    includes(r.out, "No problems found", "a freshly built store must be clean");
  });

  it("certifies, naming the extractor and the conformance state", () => {
    const r = sh("certify.mjs", [], dir, { allowFail: true });
    includes(r.out, "epub-builtin@");
    includes(r.out, "EXTRACTION");
  });
});

// ---------------------------------------------------------------------------
describe("integrity · tampering is caught", () => {
  const clean = () => store(plain());

  it("catches an edited segment file", () => {
    const dir = clean();
    fs.appendFileSync(path.join(dir, "sources/converted/book/page-0001.txt"), "smuggled");
    const r = sh("check-store.mjs", ["--verify"], dir, { allowFail: true });
    assert(!r.ok, "verification must fail");
    includes(r.out, "segment-digest");
    includes(r.out, "segment-length");
  });

  it("catches a replaced original", () => {
    const dir = clean();
    fs.writeFileSync(path.join(dir, "sources/original/book.epub"), imagesAndSizes().epub);
    const r = sh("check-store.mjs", ["--verify"], dir, { allowFail: true });
    includes(r.out, "original-digest");
  });

  it("catches a deleted original, rather than passing for lack of evidence", () => {
    const dir = clean();
    fs.rmSync(path.join(dir, "sources/original/book.epub"));
    const r = sh("check-store.mjs", ["--verify"], dir, { allowFail: true });
    includes(r.out, "original-missing");
  });

  it("catches an edited pages.jsonl through the manifest fingerprint", () => {
    const dir = clean();
    const f = path.join(dir, "sources/converted/book/pages.jsonl");
    const rows = jsonl(f);
    rows[0].char_count = rows[0].char_count + 1;
    fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const r = sh("check-store.mjs", ["--verify"], dir, { allowFail: true });
    includes(r.out, "manifest-digest");
  });

  it("fails on a corrupt JSONL line rather than skipping it", () => {
    const dir = clean();
    fs.appendFileSync(path.join(dir, "corpus.jsonl"), "{not json\n");
    const r = sh("check-store.mjs", [], dir, { allowFail: true });
    assert(!r.ok, "a damaged store must not report clean");
    includes(r.out, "unparseable JSON");
  });
});

// ---------------------------------------------------------------------------
describe("determinism · derivation is reproducible", () => {
  const dir = store(imagesAndSizes());
  const STAMP = "2026-01-01T00:00:00+00:00";

  it("rebuilds the graph byte-identically", () => {
    sh("graph.mjs", [], dir);
    const first = fs.readFileSync(path.join(dir, "graph.jsonl"), "utf8");
    fs.rmSync(path.join(dir, "graph.jsonl"));
    sh("graph.mjs", [], dir);
    equal(fs.readFileSync(path.join(dir, "graph.jsonl"), "utf8"), first, "the graph is a projection or it is a second store");
  });

  it("rebuilds concepts and gaps byte-identically under a frozen clock", () => {
    sh("index.mjs", ["--quiet", "--generated-at", STAMP], dir);
    const a = ["concepts.jsonl", "gaps.jsonl"].map((f) => fs.readFileSync(path.join(dir, f), "utf8"));
    sh("index.mjs", ["--quiet", "--generated-at", STAMP], dir);
    const b = ["concepts.jsonl", "gaps.jsonl"].map((f) => fs.readFileSync(path.join(dir, f), "utf8"));
    equal(b, a, "a derived artifact that cannot be rebuilt and diffed makes determinism unverifiable");
  });

  it("re-chunks to the same ids and the same spans", () => {
    const f = path.join(dir, "sources/converted/book/chunks.jsonl");
    const before = fs.readFileSync(f, "utf8");
    sh("chunk.mjs", ["--slug", "book", "--target-chars", "400"], dir, { allowFail: true });
    equal(fs.readFileSync(f, "utf8"), before);
  });

  it("re-enumerates to the same manifest", () => {
    const before = fs.readFileSync(path.join(dir, "corpus.jsonl"), "utf8");
    sh("enumerate.mjs", ["--slug", "book"], dir, { allowFail: true });
    equal(fs.readFileSync(path.join(dir, "corpus.jsonl"), "utf8"), before);
  });
});

// ---------------------------------------------------------------------------
describe("derivation · nothing is hand-maintained that can be computed", () => {
  const dir = store(plain());

  it("derives every segment field, leaving only a gap reason to a human", () => {
    const HUMAN = new Set(["gap"]);
    const DERIVED = new Set([
      "page", "locator_scheme", "href", "spine_index", "linear", "kind", "nav_title",
      "char_count", "text_sha256", "headings", "anchors", "media", "extractor", "extraction_error",
    ]);
    for (const p of jsonl(path.join(dir, "sources/converted/book/pages.jsonl"))) {
      for (const k of Object.keys(p)) {
        assert(DERIVED.has(k) || HUMAN.has(k), `segment field '${k}' is neither derived nor a declared human judgement`);
      }
    }
  });

  it("overwrites a hand-written status — pitfall #1, tested", () => {
    const f = path.join(dir, "corpus.jsonl");
    const rows = jsonl(f);
    rows[0].status = "saturated"; // a lie: the unit holds no claims at all
    fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

    sh("sync-corpus.mjs", [], dir, { allowFail: true });
    equal(jsonl(f)[0].status, "pending", "status is derived from the artifacts, never accepted as written");
  });

  it("flags a status that outran the store, if one somehow survives", () => {
    const f = path.join(dir, "corpus.jsonl");
    const rows = jsonl(f);
    rows[0].status = "saturated";
    fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    sh("index.mjs", ["--quiet", "--generated-at", "2026-01-01T00:00:00+00:00"], dir);
    const gaps = jsonl(path.join(dir, "gaps.jsonl"));
    assert(
      gaps.some((g) => String(g.gap).includes("zero claims")),
      "a unit marked done while holding nothing is the failure the indexer exists to catch"
    );
    sh("sync-corpus.mjs", [], dir, { allowFail: true });
  });

  it("computes confidence from the rubric rather than accepting a number", () => {
    const dir2 = store(plain());
    fs.mkdirSync(path.join(dir2, "claims/book"), { recursive: true });
    const unit = jsonl(path.join(dir2, "corpus.jsonl"))[0].unit;
    const claim = {
      id: `${unit}/c01`, unit, type: "principle",
      statement: "Record the boundary of a rule where the source states it, not where it feels natural.",
      condition: "a rule has been formalized", consequence: "it is applied outside its range",
      defines: ["boundary"], mentions: [],
      evidence: { source: "book", locator: "OEBPS/ch01.xhtml@0-10", support: "direct", excerpt_hash: "a".repeat(64) },
      origin: "source", confidence: 0.42, prompt_version: "extract@abc1234",
      extracted_at: "2026-01-01T00:00:00+00:00",
    };
    fs.writeFileSync(path.join(dir2, "claims/book/c.jsonl"), JSON.stringify(claim) + "\n");

    const before = sh("check-store.mjs", [], dir2, { allowFail: true });
    includes(before.out, "does not match the rubric", "a hand-set score must be rejected");

    sh("confidence.mjs", [], dir2, { allowFail: true });
    equal(jsonl(path.join(dir2, "claims/book/c.jsonl"))[0].confidence, 0.9);
  });
});

// ---------------------------------------------------------------------------
describe("resume · work survives interruption and insertion", () => {
  it("keeps chunk ids stable when a document is added elsewhere in the spine", () => {
    // Two books differing only by an appended chapter. Ids for the shared
    // documents must not move: a positional id would renumber everything after
    // an insertion and orphan every claim that referenced one.
    const before = plain();
    const dirA = store(before);
    const idsA = jsonl(path.join(dirA, "sources/converted/book/chunks.jsonl")).map((c) => c.id);

    const extended = {
      name: "plain-plus",
      epub: buildZip([
        MIMETYPE(),
        CONTAINER(),
        entry("OEBPS/content.opf", opf({
          items:
            `<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>` +
            `<item id="c1" href="ch01.xhtml" media-type="application/xhtml+xml"/>` +
            `<item id="c2" href="ch02.xhtml" media-type="application/xhtml+xml"/>` +
            `<item id="c3" href="ch03.xhtml" media-type="application/xhtml+xml"/>` +
            `<item id="c4" href="ch04.xhtml" media-type="application/xhtml+xml"/>`,
          spine: `<itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/><itemref idref="c4"/>`,
        })),
        entry("OEBPS/nav.xhtml", xhtml("Contents",
          `<nav epub:type="toc"><ol>` +
          `<li><a href="ch01.xhtml">One: Beginnings</a></li>` +
          `<li><a href="ch02.xhtml">Two: Middles</a></li>` +
          `<li><a href="ch03.xhtml">Three: Ends</a></li>` +
          `<li><a href="ch04.xhtml">Four: Appendix</a></li></ol></nav>`)),
        entry("OEBPS/ch01.xhtml", xhtml("One", `<h1>One: Beginnings</h1><p>Extraction is not compression.</p><p>A rule without its conditions is noise.</p>`)),
        entry("OEBPS/ch02.xhtml", xhtml("Two", `<h1>Two: Middles</h1><p>The manifest is the denominator.</p>`)),
        entry("OEBPS/ch03.xhtml", xhtml("Three", `<h1>Three: Ends</h1><p>A withheld certificate is a result.</p>`)),
        entry("OEBPS/ch04.xhtml", xhtml("Four", `<h1>Four: Appendix</h1><p>Added after the fact.</p>`)),
      ]),
    };
    const dirB = store(extended);
    const idsB = jsonl(path.join(dirB, "sources/converted/book/chunks.jsonl")).map((c) => c.id);

    for (const id of idsA) {
      assert(idsB.includes(id), `chunk ${id} moved when a later document was added`);
    }
    assert(idsB.length > idsA.length, "the added chapter must contribute its own chunks");
  });

  it("keeps unit ids stable across re-enumeration", () => {
    const dir = store(nestedToc());
    const before = jsonl(path.join(dir, "corpus.jsonl")).map((u) => u.unit);
    sh("enumerate.mjs", ["--slug", "book"], dir, { allowFail: true });
    equal(jsonl(path.join(dir, "corpus.jsonl")).map((u) => u.unit), before);
  });

  it("carries derived status through a re-enumeration", () => {
    const dir = store(plain());
    const f = path.join(dir, "corpus.jsonl");
    const rows = jsonl(f);
    rows[0].status = "extracted";
    fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    sh("enumerate.mjs", ["--slug", "book"], dir, { allowFail: true });
    equal(jsonl(f)[0].status, "extracted", "re-reading the TOC must not reset work already done");
  });

  it("refuses a re-ingest that would change the text", () => {
    const dir = store(plain());
    fs.writeFileSync(path.join(dir, "other.epub"), imagesAndSizes().epub);
    const r = sh("ingest.mjs", ["--source", "other.epub", "--slug", "book"], dir, { allowFail: true });
    includes(r.out, "RE-INGEST CHANGED THE TEXT");
  });
});

// ---------------------------------------------------------------------------
describe("negative · store gates", () => {
  it("refuses to chunk before the denominator exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "distill-store-"));
    cleanup.push(dir);
    fs.writeFileSync(path.join(dir, "book.epub"), plain().epub);
    sh("ingest.mjs", ["--source", "book.epub", "--slug", "book"], dir, { allowFail: true });
    const r = sh("chunk.mjs", ["--slug", "book"], dir, { allowFail: true });
    assert(!r.ok, "chunking with no units must be refused");
    includes(r.out, "run enumerate.mjs first");
  });

  it("refuses a non-EPUB source, with no fallback offered", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "distill-store-"));
    cleanup.push(dir);
    fs.writeFileSync(path.join(dir, "book.pdf"), "%PDF-1.7\nnot an epub\n");
    const r = sh("ingest.mjs", ["--source", "book.pdf", "--slug", "book"], dir, { allowFail: true });
    assert(!r.ok);
    includes(r.out, "EPUB is the only supported format");
  });

  it("reports an unreferenced manifest resource", () => {
    const dir = store(imagesAndSizes());
    const profile = JSON.parse(fs.readFileSync(path.join(dir, "sources/converted/book/source.json"), "utf8"));
    includes(JSON.stringify(profile.unreferenced_resources), "unused.xhtml");
  });

  it("flags an image-only segment so its figures are not counted as covered", () => {
    const dir = store(imagesAndSizes());
    const r = sh("check-store.mjs", [], dir, { allowFail: true });
    includes(r.out, "image-only-segment");
  });
});
