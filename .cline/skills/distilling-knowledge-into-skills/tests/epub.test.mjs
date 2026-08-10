// epub.test.mjs — the extractor, its refusals, and the structural edge cases.
//
// Three categories in one file because they exercise one component: unit
// behaviour, what it refuses, and the markup shapes a real book presents.

import { describe, it, assert, equal, includes, refuses } from "./harness.mjs";
import {
  epubFixtures, refusalFixtures, plain, nestedToc, scriptStyle, complexMarkup,
  imagesAndSizes, ncxAndNonLinear, buildZip, entry, opf, MIMETYPE, CONTAINER,
} from "./fixtures/epub.mjs";
import { readZip, zipMap, readEntry } from "../scripts/lib/zip.mjs";
import { walk, decodeEntities, textOf, findAll } from "../scripts/lib/xml.mjs";
import { extractEpub, openEpub, readToc, flattenToc, extractDocument, reconcile, unreferencedResources, NON_PROSE } from "../scripts/lib/epub.mjs";

const norm = (s) => String(s ?? "").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();

// ---------------------------------------------------------------------------
describe("unit · zip", () => {
  it("reads the central directory, not a header scan", () => {
    const zip = readZip(plain().epub);
    const names = zip.entries.map((e) => e.name);
    assert(names[0] === "mimetype", "mimetype must be the first entry");
    includes(names.join(","), "OEBPS/content.opf");
  });

  it("stores the mimetype uncompressed, as the specification requires", () => {
    const zip = readZip(plain().epub);
    equal(zip.entries[0].method, 0, "mimetype must be stored, not deflated");
  });

  it("round-trips a deflated entry", () => {
    const zip = readZip(plain().epub);
    const map = zipMap(zip);
    const text = readEntry(zip, map.get("OEBPS/ch02.xhtml")).toString("utf8");
    includes(text, "The manifest is the denominator.");
  });

  it("refuses a truncated archive", () => {
    const buf = plain().epub;
    refuses(() => readZip(buf.subarray(0, 10)), /too small|no end-of-central-directory/i);
  });
});

// ---------------------------------------------------------------------------
describe("unit · xml", () => {
  it("decodes named, decimal and hex entities", () => {
    equal(decodeEntities("caf&#233; &amp; cr&egrave;me &#x2014; ok"), "café & crème — ok");
  });

  it("leaves an unknown entity verbatim rather than dropping it", () => {
    equal(decodeEntities("a &notreal; b"), "a &notreal; b");
  });

  it("does not end a tag on a > inside an attribute value", () => {
    const seen = [];
    walk(`<p title="a > b">text</p>`, { onText: (t) => seen.push(t) });
    equal(seen.join(""), "text");
  });

  it("treats CDATA as text", () => {
    const seen = [];
    walk(`<p><![CDATA[literal prose]]></p>`, { onText: (t) => seen.push(t) });
    includes(seen.join(""), "literal prose");
  });

  it("survives unbalanced markup", () => {
    const seen = [];
    walk(`<div><p>one<div>two</div>`, { onText: (t) => seen.push(t.trim()) });
    includes(seen.join("|"), "one");
    includes(seen.join("|"), "two");
  });

  it("finds elements by local name across namespaces", () => {
    equal(textOf(`<pkg><dc:title>A Book</dc:title></pkg>`, "dc:title"), "A Book");
    equal(findAll(`<m><item id="a"/><item id="b"/></m>`, "item").length, 2);
  });
});

// ---------------------------------------------------------------------------
describe("unit · extraction", () => {
  it("extracts every fixture chapter exactly", () => {
    const f = plain();
    const r = extractEpub(f.epub);
    equal(r.pages.map((p) => norm(p.text)), f.expect.map(norm));
  });

  it("keeps inline elements inside the sentence and breaks on blocks", () => {
    const d = extractDocument(`<body><p>Inline <em>emphasis</em> here.</p><p>Next block.</p></body>`, "x");
    equal(norm(d.text), "Inline emphasis here.\nNext block.");
  });

  it("records headings with their level and offset", () => {
    const d = extractDocument(`<body><h1>Title</h1><p>Body.</p><h2>Sub</h2><p>More.</p></body>`, "x");
    equal(d.headings.map((h) => [h.level, h.title]), [[1, "Title"], [2, "Sub"]]);
    assert(d.headings[1].offset > d.headings[0].offset, "offsets must increase in document order");
  });

  it("records an image as media and keeps its alt text out of the prose", () => {
    const d = extractDocument(`<body><p>Before.</p><img src="f.png" alt="A diagram"/><p>After.</p></body>`, "x");
    equal(d.media.length, 1);
    equal(d.media[0].alt, "A diagram");
    assert(!d.text.includes("A diagram"), "alt text is metadata about a figure, not body prose");
  });

  it("records anchors so a fragment locator resolves to an offset", () => {
    const d = extractDocument(`<body><p>One.</p><section id="s2"><p>Two.</p></section></body>`, "x");
    const a = d.anchors.find((x) => x.id === "s2");
    assert(a && a.offset > 0, "the anchor must carry the offset it starts at");
  });
});

// ---------------------------------------------------------------------------
describe("unit · reconciliation", () => {
  it("passes when every prose text node reached the output", () => {
    const xhtml = `<body><h1>Head</h1><p>One.</p><p>Two.</p></body>`;
    const d = extractDocument(xhtml, "x");
    equal(reconcile(xhtml, d.text), []);
  });

  it("catches a dropped text node", () => {
    const xhtml = `<body><p>Kept.</p><p>Dropped sentence.</p></body>`;
    const missing = reconcile(xhtml, "Kept.");
    equal(missing.length, 1);
    includes(missing[0].text, "Dropped sentence");
  });

  it("catches text emitted out of document order", () => {
    const xhtml = `<body><p>First.</p><p>Second.</p></body>`;
    assert(reconcile(xhtml, "Second. First.").length > 0, "reversed order must not pass");
  });

  it("shares its exclusion list with extraction, so the two cannot drift", () => {
    assert(NON_PROSE.has("script") && NON_PROSE.has("style"));
    const f = scriptStyle();
    const r = extractEpub(f.epub);
    equal(r.pages[0].error, null, "a document whose only losses are script/style must still reconcile");
  });
});

// ---------------------------------------------------------------------------
describe("negative · refusals", () => {
  for (const f of refusalFixtures()) {
    it(`refuses ${f.name} — ${f.why}`, () => {
      refuses(() => extractEpub(f.epub), f.expectRefusal);
    });
  }

  it("refuses a spine document whose media type is not a content document", () => {
    const bad = buildZip([
      MIMETYPE(),
      CONTAINER(),
      entry("OEBPS/content.opf", opf({
        items: `<item id="c1" href="ch01.png" media-type="image/png"/>`,
        spine: `<itemref idref="c1"/>`,
      })),
      entry("OEBPS/ch01.png", Buffer.from([1, 2, 3])),
    ]);
    refuses(() => extractEpub(bad), /not a content document/i);
  });

  it("refuses an empty spine", () => {
    const bad = buildZip([
      MIMETYPE(),
      CONTAINER(),
      entry("OEBPS/content.opf", opf({ items: `<item id="c1" href="a.xhtml" media-type="application/xhtml+xml"/>`, spine: `` })),
      entry("OEBPS/a.xhtml", `<html><body><p>x</p></body></html>`),
    ]);
    refuses(() => extractEpub(bad), /spine is empty/i);
  });
});

// ---------------------------------------------------------------------------
describe("edge · script and style", () => {
  it("never lets script or style contents reach the text, even when they read as prose", () => {
    const f = scriptStyle();
    const r = extractEpub(f.epub);
    equal(r.pages.map((p) => norm(p.text)), f.expect.map(norm));
    for (const forbidden of f.mustNotContain) {
      assert(!r.pages[0].text.includes(forbidden), `text must not contain ${JSON.stringify(forbidden)}`);
    }
  });
});

describe("edge · complex markup", () => {
  const f = complexMarkup();
  const r = extractEpub(f.epub);

  it("extracts tables, nested lists, entities, MathML and SVG text", () => {
    equal(r.pages[0].error, null);
    for (const needle of f.mustContain) includes(norm(r.pages[0].text), needle);
  });

  it("emits no markup and no undecoded entities", () => {
    for (const forbidden of f.mustNotContain) {
      assert(!r.pages[0].text.includes(forbidden), `must not contain ${JSON.stringify(forbidden)}`);
    }
  });

  it("breaks a line on <br/>", () => {
    includes(r.pages[0].text, "A line\nbroken by a rule.");
  });
});

describe("edge · nested tables of contents", () => {
  const f = nestedToc();
  const book = openEpub(f.epub);
  const toc = readToc(book);

  it("reads a three-level nav", () => {
    equal(flattenToc(toc.entries, 9).length, f.depth3Count);
  });

  it("flattens to the configured depth", () => {
    equal(flattenToc(toc.entries, 1).map((e) => e.title), f.depth1Titles);
    equal(flattenToc(toc.entries, 2).map((e) => e.title), f.depth2Titles);
  });

  it("keeps fragment targets so a unit can start inside a document", () => {
    const s11 = flattenToc(toc.entries, 9).find((e) => e.title === "Subsection 1.1.1");
    equal(s11.fragment, "s11");
  });
});

describe("edge · spine structures", () => {
  const f = ncxAndNonLinear();
  const r = extractEpub(f.epub);

  it("falls back to NCX navigation when there is no nav document", () => {
    equal(r.toc.source, f.tocSource);
    equal(flattenToc(r.toc.entries, 1).map((e) => e.title), f.tocTitles);
  });

  it("reads nested navPoints", () => {
    includes(flattenToc(r.toc.entries, 9).map((e) => e.title).join("|"), "One point one");
  });

  it("keeps a linear=no item in the store, marked, rather than dropping it", () => {
    const nl = r.pages[f.nonLinearPage - 1];
    equal(nl.linear, false);
    includes(nl.text, "Not in the reading order.");
  });
});

describe("edge · images and uneven segments", () => {
  const f = imagesAndSizes();
  const r = extractEpub(f.epub);

  it("gives an image-only chapter zero text and a media record, not silence", () => {
    const plate = r.pages[f.imageOnlyPage - 1];
    equal(norm(plate.text), "");
    equal(plate.media.length, 1);
    equal(plate.media[0].alt, f.altText);
  });

  it("tolerates a 90-character segment beside a 5,000-character one", () => {
    const lengths = r.pages.map((p) => (p.text || "").length);
    assert(Math.max(...lengths) / Math.max(1, Math.min(...lengths.filter((n) => n > 0))) > 50,
      "the fixture must actually be lopsided for this to mean anything");
    assert(r.pages.every((p) => p.error === null), "size alone must never be treated as a defect");
  });

  it("reports a manifest resource the spine never references", () => {
    const orphans = unreferencedResources(r.book, r.pages);
    includes(orphans.map((o) => o.path).join(","), f.unreferenced);
  });
});

describe("edge · every fixture reconciles", () => {
  for (const f of epubFixtures()) {
    it(`${f.name} loses no text node — ${f.why}`, () => {
      const r = extractEpub(f.epub);
      const failed = r.pages.filter((p) => p.error);
      equal(failed.map((p) => p.error), [], `${f.name} must reconcile`);
    });
  }
});
