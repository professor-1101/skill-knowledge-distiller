// epub.mjs — EPUB fixtures, generated deterministically from source.
//
// Committed as a generator rather than as binaries so the repository stays
// text-only and every byte is auditable. A fixture nobody can regenerate is a
// fixture nobody can check.
//
// The set is chosen from the structural hazards a real book actually presents:
// nested tables of contents, non-linear spine items, image-only chapters,
// prose hidden inside script and style, MathML and SVG text, wildly uneven
// segment sizes, EPUB 2 NCX navigation, and the refusal cases — DRM, a missing
// spine document, a spine entry with no manifest counterpart.

import zlib from "node:zlib";
import { crc32 } from "../../scripts/lib/zip.mjs";

function entry(name, data, store = false, { badCrc = false } = {}) {
  const nameBuf = Buffer.from(name, "utf8");
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  const comp = store ? body : zlib.deflateRawSync(body);
  const crc = badCrc ? (crc32(body) ^ 0xffffffff) >>> 0 : crc32(body);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);
  lh.writeUInt16LE(0x0800, 6); // UTF-8 names
  lh.writeUInt16LE(store ? 0 : 8, 8);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(comp.length, 18);
  lh.writeUInt32LE(body.length, 22);
  lh.writeUInt16LE(nameBuf.length, 26);
  return {
    nameBuf,
    local: Buffer.concat([lh, nameBuf, comp]),
    crc,
    csize: comp.length,
    usize: body.length,
    method: store ? 0 : 8,
  };
}

export function buildZip(files) {
  let offset = 0;
  const locals = [];
  const centrals = [];
  for (const f of files) {
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(f.method, 10);
    c.writeUInt32LE(f.crc, 16);
    c.writeUInt32LE(f.csize, 20);
    c.writeUInt32LE(f.usize, 24);
    c.writeUInt16LE(f.nameBuf.length, 28);
    c.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([c, f.nameBuf]));
    locals.push(f.local);
    offset += f.local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const MIMETYPE = () => entry("mimetype", "application/epub+zip", true);
const CONTAINER = (opf = "OEBPS/content.opf") =>
  entry(
    "META-INF/container.xml",
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">` +
      `<rootfiles><rootfile full-path="${opf}" media-type="application/oebps-package+xml"/></rootfiles></container>`
  );

function opf({ items, spine, version = "3.0", tocAttr = "" }) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<package xmlns="http://www.idpf.org/2007/opf" version="${version}" unique-identifier="bookid">` +
    `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">` +
    `<dc:title>A Test Book</dc:title><dc:language>en</dc:language>` +
    `<dc:identifier id="bookid">urn:uuid:0000</dc:identifier></metadata>` +
    `<manifest>${items}</manifest>` +
    `<spine${tocAttr}>${spine}</spine></package>`
  );
}

const xhtml = (title, body) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">` +
  `<head><title>${title}</title></head><body>${body}</body></html>`;

// ---------------------------------------------------------------------------

/** The ordinary case: EPUB 3, nav TOC, three chapters of prose. */
function plain() {
  const nav = xhtml(
    "Contents",
    `<nav epub:type="toc"><ol>` +
      `<li><a href="ch01.xhtml">One: Beginnings</a></li>` +
      `<li><a href="ch02.xhtml">Two: Middles</a></li>` +
      `<li><a href="ch03.xhtml">Three: Ends</a></li>` +
      `</ol></nav>`
  );
  const c1 = xhtml("One", `<h1>One: Beginnings</h1><p>Extraction is not compression.</p><p>A rule without its conditions is noise.</p>`);
  const c2 = xhtml("Two", `<h1>Two: Middles</h1><p>The manifest is the denominator.</p>`);
  const c3 = xhtml("Three", `<h1>Three: Ends</h1><p>A withheld certificate is a result.</p>`);
  return {
    name: "plain",
    why: "EPUB 3 with a nav TOC and three prose chapters",
    epub: buildZip([
      MIMETYPE(),
      CONTAINER(),
      entry("OEBPS/content.opf", opf({
        items:
          `<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>` +
          `<item id="c1" href="ch01.xhtml" media-type="application/xhtml+xml"/>` +
          `<item id="c2" href="ch02.xhtml" media-type="application/xhtml+xml"/>` +
          `<item id="c3" href="ch03.xhtml" media-type="application/xhtml+xml"/>`,
        spine: `<itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/>`,
      })),
      entry("OEBPS/nav.xhtml", nav),
      entry("OEBPS/ch01.xhtml", c1),
      entry("OEBPS/ch02.xhtml", c2),
      entry("OEBPS/ch03.xhtml", c3),
    ]),
    expect: [
      "One: Beginnings\nExtraction is not compression.\nA rule without its conditions is noise.",
      "Two: Middles\nThe manifest is the denominator.",
      "Three: Ends\nA withheld certificate is a result.",
    ],
    tocTitles: ["One: Beginnings", "Two: Middles", "Three: Ends"],
  };
}

/** Three-level nav, so depth handling is exercised rather than assumed. */
function nestedToc() {
  const nav = xhtml(
    "Contents",
    `<nav epub:type="toc"><ol>` +
      `<li><a href="ch01.xhtml">Part One</a><ol>` +
      `<li><a href="ch01.xhtml#s1">Section 1.1</a><ol>` +
      `<li><a href="ch01.xhtml#s11">Subsection 1.1.1</a></li></ol></li>` +
      `<li><a href="ch01.xhtml#s2">Section 1.2</a></li></ol></li>` +
      `<li><a href="ch02.xhtml">Part Two</a></li>` +
      `</ol></nav>`
  );
  const c1 = xhtml(
    "One",
    `<h1>Part One</h1><p>Opening prose.</p>` +
      `<section id="s1"><h2>Section 1.1</h2><p>First section body.</p>` +
      `<section id="s11"><h3>Subsection 1.1.1</h3><p>Deep body text.</p></section></section>` +
      `<section id="s2"><h2>Section 1.2</h2><p>Second section body.</p></section>`
  );
  const c2 = xhtml("Two", `<h1>Part Two</h1><p>Closing prose.</p>`);
  return {
    name: "nested-toc",
    why: "three-level nav with fragment targets, exercising unit grain by depth",
    epub: buildZip([
      MIMETYPE(),
      CONTAINER(),
      entry("OEBPS/content.opf", opf({
        items:
          `<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>` +
          `<item id="c1" href="ch01.xhtml" media-type="application/xhtml+xml"/>` +
          `<item id="c2" href="ch02.xhtml" media-type="application/xhtml+xml"/>`,
        spine: `<itemref idref="c1"/><itemref idref="c2"/>`,
      })),
      entry("OEBPS/nav.xhtml", nav),
      entry("OEBPS/ch01.xhtml", c1),
      entry("OEBPS/ch02.xhtml", c2),
    ]),
    depth1Titles: ["Part One", "Part Two"],
    depth2Titles: ["Part One", "Section 1.1", "Section 1.2", "Part Two"],
    depth3Count: 5,
  };
}

/** Prose inside script and style. A naive tag-stripper passes reconciliation and fails here. */
function scriptStyle() {
  const c1 = xhtml(
    "One",
    `<h1>Real Heading</h1>` +
      `<style>.note { content: "This sentence is not prose and must not appear."; }</style>` +
      `<script>var msg = "Neither is this one, and it reads like a sentence.";</script>` +
      `<p>Only this paragraph is body text.</p>`
  );
  return {
    name: "script-style",
    why: "script and style contents must never reach the text, even when they read as prose",
    epub: buildZip([
      MIMETYPE(),
      CONTAINER(),
      entry("OEBPS/content.opf", opf({
        items:
          `<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>` +
          `<item id="c1" href="ch01.xhtml" media-type="application/xhtml+xml"/>`,
        spine: `<itemref idref="c1"/>`,
      })),
      entry("OEBPS/nav.xhtml", xhtml("Contents", `<nav epub:type="toc"><ol><li><a href="ch01.xhtml">One</a></li></ol></nav>`)),
      entry("OEBPS/ch01.xhtml", c1),
    ]),
    expect: ["Real Heading\nOnly this paragraph is body text."],
    mustNotContain: ["not prose", "Neither is this one"],
  };
}

/** Complex markup: tables, nested lists, inline elements, MathML, SVG text, entities. */
function complexMarkup() {
  const c1 = xhtml(
    "One",
    `<h1>Complex</h1>` +
      `<p>Inline <em>emphasis</em> and <strong>weight</strong> must not split the sentence.</p>` +
      `<ul><li>First item</li><li>Second item<ul><li>Nested item</li></ul></li></ul>` +
      `<table><tr><th>Head A</th><th>Head B</th></tr><tr><td>Cell one</td><td>Cell two</td></tr></table>` +
      `<p>Entities: caf&#233; &amp; cr&egrave;me &mdash; done.</p>` +
      `<p>Math: <math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi><mo>+</mo><mn>1</mn></math></p>` +
      `<p>Figure: <svg xmlns="http://www.w3.org/2000/svg"><text>Label inside SVG</text></svg></p>` +
      `<p>A line<br/>broken by a rule.</p>`
  );
  return {
    name: "complex-markup",
    why: "tables, nested lists, inline elements, entities, MathML and SVG text",
    epub: buildZip([
      MIMETYPE(),
      CONTAINER(),
      entry("OEBPS/content.opf", opf({
        items:
          `<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>` +
          `<item id="c1" href="ch01.xhtml" media-type="application/xhtml+xml"/>`,
        spine: `<itemref idref="c1"/>`,
      })),
      entry("OEBPS/nav.xhtml", xhtml("Contents", `<nav epub:type="toc"><ol><li><a href="ch01.xhtml">One</a></li></ol></nav>`)),
      entry("OEBPS/ch01.xhtml", c1),
    ]),
    mustContain: [
      "Inline emphasis and weight must not split the sentence.",
      "Nested item",
      "Cell one",
      "café & crème — done.",
      "Label inside SVG",
    ],
    mustNotContain: ["<em>", "&amp;"],
  };
}

/** An image-only chapter beside prose, and uneven segment sizes. */
function imagesAndSizes() {
  const long = "The denominator is the manifest, and reconciliation only sees what it says exists. ".repeat(60);
  return {
    name: "images-and-sizes",
    why: "an image-only chapter, a 90-character front page, and a 5,000-character chapter",
    epub: buildZip([
      MIMETYPE(),
      CONTAINER(),
      entry("OEBPS/content.opf", opf({
        items:
          `<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>` +
          `<item id="c1" href="front.xhtml" media-type="application/xhtml+xml"/>` +
          `<item id="c2" href="plate.xhtml" media-type="application/xhtml+xml"/>` +
          `<item id="c3" href="ch01.xhtml" media-type="application/xhtml+xml"/>` +
          `<item id="img1" href="figure.png" media-type="image/png"/>` +
          `<item id="orphan" href="unused.xhtml" media-type="application/xhtml+xml"/>`,
        spine: `<itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/>`,
      })),
      entry("OEBPS/nav.xhtml", xhtml("Contents", `<nav epub:type="toc"><ol><li><a href="ch01.xhtml">One</a></li></ol></nav>`)),
      entry("OEBPS/front.xhtml", xhtml("Front", `<p>A Test Book</p>`)),
      entry("OEBPS/plate.xhtml", xhtml("Plate", `<div><img src="figure.png" alt="A diagram that carries the content"/></div>`)),
      entry("OEBPS/ch01.xhtml", xhtml("One", `<h1>One</h1><p>${long}</p>`)),
      entry("OEBPS/figure.png", Buffer.from([0x89, 0x50, 0x4e, 0x47])),
      entry("OEBPS/unused.xhtml", xhtml("Unused", `<p>Declared in the manifest and referenced by nothing.</p>`)),
    ]),
    imageOnlyPage: 2,
    unreferenced: "OEBPS/unused.xhtml",
    altText: "A diagram that carries the content",
  };
}

/** EPUB 2 with NCX navigation and a non-linear spine item. */
function ncxAndNonLinear() {
  const ncx =
    `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">` +
    `<navMap>` +
    `<navPoint id="n1" playOrder="1"><navLabel><text>Chapter One</text></navLabel><content src="ch01.xhtml"/>` +
    `<navPoint id="n1a" playOrder="2"><navLabel><text>One point one</text></navLabel><content src="ch01.xhtml#a"/></navPoint>` +
    `</navPoint>` +
    `<navPoint id="n2" playOrder="3"><navLabel><text>Chapter Two</text></navLabel><content src="ch02.xhtml"/></navPoint>` +
    `</navMap></ncx>`;
  return {
    name: "ncx-nonlinear",
    why: "EPUB 2 NCX navigation, nested navPoints, and a linear=no spine item",
    epub: buildZip([
      MIMETYPE(),
      CONTAINER(),
      entry("OEBPS/content.opf", opf({
        version: "2.0",
        tocAttr: ` toc="ncx"`,
        items:
          `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>` +
          `<item id="c1" href="ch01.xhtml" media-type="application/xhtml+xml"/>` +
          `<item id="c2" href="ch02.xhtml" media-type="application/xhtml+xml"/>` +
          `<item id="notes" href="notes.xhtml" media-type="application/xhtml+xml"/>`,
        spine: `<itemref idref="c1"/><itemref idref="c2"/><itemref idref="notes" linear="no"/>`,
      })),
      entry("OEBPS/toc.ncx", ncx),
      entry("OEBPS/ch01.xhtml", xhtml("One", `<h1>Chapter One</h1><p>First body.</p><p id="a">Anchored body.</p>`)),
      entry("OEBPS/ch02.xhtml", xhtml("Two", `<h1>Chapter Two</h1><p>Second body.</p>`)),
      entry("OEBPS/notes.xhtml", xhtml("Notes", `<h1>Endnotes</h1><p>Not in the reading order.</p>`)),
    ]),
    tocSource: "ncx",
    tocTitles: ["Chapter One", "Chapter Two"],
    nonLinearPage: 3,
  };
}

// --- refusals --------------------------------------------------------------

function drm() {
  const f = plain();
  const files = [
    MIMETYPE(),
    CONTAINER(),
    entry("META-INF/encryption.xml", `<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><CipherData><CipherReference URI="OEBPS/ch01.xhtml"/></CipherData></EncryptedData></encryption>`),
    entry("OEBPS/content.opf", opf({
      items: `<item id="c1" href="ch01.xhtml" media-type="application/xhtml+xml"/>`,
      spine: `<itemref idref="c1"/>`,
    })),
    entry("OEBPS/ch01.xhtml", xhtml("One", `<p>Unreadable.</p>`)),
  ];
  void f;
  return { name: "drm", why: "an encrypted book must be refused, never partially read", epub: buildZip(files), expectRefusal: /encrypt/i };
}

function missingSpineDoc() {
  return {
    name: "missing-spine-doc",
    why: "a spine document absent from the archive must refuse, not extract the rest",
    epub: buildZip([
      MIMETYPE(),
      CONTAINER(),
      entry("OEBPS/content.opf", opf({
        items:
          `<item id="c1" href="ch01.xhtml" media-type="application/xhtml+xml"/>` +
          `<item id="c2" href="ch02.xhtml" media-type="application/xhtml+xml"/>`,
        spine: `<itemref idref="c1"/><itemref idref="c2"/>`,
      })),
      entry("OEBPS/ch01.xhtml", xhtml("One", `<p>Present.</p>`)),
    ]),
    expectRefusal: /missing from the archive/i,
  };
}

function danglingIdref() {
  return {
    name: "dangling-idref",
    why: "a spine entry with no manifest counterpart makes the reading order incomplete",
    epub: buildZip([
      MIMETYPE(),
      CONTAINER(),
      entry("OEBPS/content.opf", opf({
        items: `<item id="c1" href="ch01.xhtml" media-type="application/xhtml+xml"/>`,
        spine: `<itemref idref="c1"/><itemref idref="ghost"/>`,
      })),
      entry("OEBPS/ch01.xhtml", xhtml("One", `<p>Present.</p>`)),
    ]),
    expectRefusal: /manifest does not declare/i,
  };
}

function notAnEpub() {
  return {
    name: "not-an-epub",
    why: "a ZIP without the mimetype declaration is not an EPUB and there is no fallback",
    epub: buildZip([entry("readme.txt", "just a zip")]),
    expectRefusal: /not an EPUB/i,
  };
}

/** A chapter whose recorded CRC does not match its bytes. */
function badCrc() {
  return {
    name: "bad-crc",
    why: "an entry whose CRC disagrees with its bytes is corrupt and must not be decoded into the store",
    epub: buildZip([
      MIMETYPE(),
      CONTAINER(),
      entry("OEBPS/content.opf", opf({
        items: `<item id="c1" href="ch01.xhtml" media-type="application/xhtml+xml"/>`,
        spine: `<itemref idref="c1"/>`,
      })),
      entry("OEBPS/ch01.xhtml", xhtml("One", `<p>The bytes are fine but the index disagrees.</p>`), false, { badCrc: true }),
    ]),
    expectRefusal: /CRC mismatch/i,
  };
}

/** A deflate stream that is genuinely damaged. */
function corruptStream() {
  const good = plain();
  const buf = Buffer.from(good.epub);
  // Find the local header of the last chapter and damage its payload. Working
  // from the signature keeps the fixture correct if the builder changes.
  const marker = Buffer.from("OEBPS/ch03.xhtml", "utf8");
  const at = buf.indexOf(marker);
  const dataStart = at + marker.length;
  for (let i = dataStart + 2; i < dataStart + 12 && i < buf.length; i++) buf[i] = buf[i] ^ 0x5a;
  return {
    name: "corrupt-stream",
    why: "a damaged deflate stream must be refused, not decoded into noise",
    epub: buf,
    expectRefusal: /(corrupt|CRC|deflate)/i,
  };
}

export function epubFixtures() {
  return [plain(), nestedToc(), scriptStyle(), complexMarkup(), imagesAndSizes(), ncxAndNonLinear()];
}

export function refusalFixtures() {
  return [drm(), missingSpineDoc(), danglingIdref(), notAnEpub(), badCrc(), corruptStream()];
}

export { plain, nestedToc, scriptStyle, complexMarkup, imagesAndSizes, ncxAndNonLinear, entry, xhtml, opf, MIMETYPE, CONTAINER };
