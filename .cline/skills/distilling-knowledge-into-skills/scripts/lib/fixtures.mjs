// fixtures.mjs — deterministic PDFs with known-correct text.
//
// These are the conformance suite. They are generated rather than committed as
// binaries so the repository stays text-only and every byte is reproducible
// from source — a fixture nobody can regenerate is a fixture nobody can audit.
//
// Each carries the exact text it should yield, so any extractor — the built-in
// one, poppler, MuPDF, a Python script — can be scored against the same
// evidence. That is what makes "extraction quality" a measured property of a
// configured tool rather than an assumption about the machine.
//
// The refusal fixtures matter as much as the others. An extractor that returns
// plausible text for an encrypted document, or for a composite font with no
// ToUnicode map, is producing something that looks like text and is not — the
// exact failure the ingestion tier exists to catch.

import zlib from "node:zlib";

function buildPdf(objects, { compressXref = false } = {}) {
  const header = Buffer.from("%PDF-1.5\n%\xE2\xE3\xCF\xD3\n", "latin1");
  const chunks = [header];
  const offsets = [0];
  let pos = header.length;

  objects.forEach((body, i) => {
    const num = i + 1;
    const buf = Buffer.concat([Buffer.from(`${num} 0 obj\n`, "latin1"), body, Buffer.from("\nendobj\n", "latin1")]);
    offsets[num] = pos;
    chunks.push(buf);
    pos += buf.length;
  });

  const size = objects.length + 1;
  if (!compressXref) {
    let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let i = 1; i < size; i++) xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
    xref += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
    chunks.push(Buffer.from(xref, "latin1"));
    return Buffer.concat(chunks);
  }

  // Cross-reference stream: type 1 entries only, W [1 4 2].
  const rows = [];
  rows.push(Buffer.from([0, 0, 0, 0, 0, 255, 255]));
  for (let i = 1; i < size; i++) {
    const b = Buffer.alloc(7);
    b[0] = 1;
    b.writeUInt32BE(offsets[i], 1);
    rows.push(b);
  }
  const xrefNum = size;
  const xrefOffset = pos;
  const rowsBuf = Buffer.concat(rows);
  const b2 = Buffer.alloc(7);
  b2[0] = 1;
  b2.writeUInt32BE(xrefOffset, 1);
  const data = zlib.deflateSync(Buffer.concat([rowsBuf, b2]));
  const dict =
    `<< /Type /XRef /Size ${size + 1} /W [1 4 2] /Root 1 0 R ` +
    `/Filter /FlateDecode /Length ${data.length} >>`;
  const xrefObj = Buffer.concat([
    Buffer.from(`${xrefNum} 0 obj\n${dict}\nstream\n`, "latin1"),
    data,
    Buffer.from("\nendstream\nendobj\n", "latin1"),
  ]);
  chunks.push(xrefObj);
  chunks.push(Buffer.from(`startxref\n${xrefOffset}\n%%EOF\n`, "latin1"));
  return Buffer.concat(chunks);
}

function stream(dict, body, { deflate = false } = {}) {
  let data = Buffer.from(body, "latin1");
  let extra = "";
  if (deflate) {
    data = zlib.deflateSync(data);
    extra = " /Filter /FlateDecode";
  }
  return Buffer.concat([
    Buffer.from(`<< ${dict}${extra} /Length ${data.length} >>\nstream\n`, "latin1"),
    data,
    Buffer.from("\nendstream", "latin1"),
  ]);
}

const L = (s) => Buffer.from(s, "latin1");

/** One page of plain WinAnsi text, uncompressed. The simplest possible case. */
function simple() {
  const content = `BT /F1 12 Tf 72 720 Td (Extraction is not compression.) Tj
0 -16 Td (Preserve the conditions and the exceptions.) Tj ET`;
  return {
    name: "simple-uncompressed",
    why: "one page, WinAnsi Type1, uncompressed content stream",
    pdf: buildPdf([
      L("<< /Type /Catalog /Pages 2 0 R >>"),
      L("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
      L("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"),
      stream("", content),
      L("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"),
    ]),
    expect: ["Extraction is not compression.\nPreserve the conditions and the exceptions."],
  };
}

/** Flate-compressed content, TJ kerning, and a second page. */
function flateTwoPage() {
  const c1 = `BT /F1 12 Tf 72 720 Td [(A rule without its) -300 (applicability conditions is noise.)] TJ ET`;
  const c2 = `BT /F1 12 Tf 72 720 Td (Page two carries its own text.) Tj
0 -16 Td (Boundaries survive the conversion.) Tj ET`;
  return {
    name: "flate-two-page",
    why: "FlateDecode content streams, TJ kerning-as-space, multi-page tree",
    pdf: buildPdf([
      L("<< /Type /Catalog /Pages 2 0 R >>"),
      L("<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 /Resources << /Font << /F1 5 0 R >> >> >>"),
      L("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>"),
      stream("", c1, { deflate: true }),
      L("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"),
      L("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 7 0 R >>"),
      stream("", c2, { deflate: true }),
    ]),
    expect: [
      "A rule without its applicability conditions is noise.",
      "Page two carries its own text.\nBoundaries survive the conversion.",
    ],
  };
}

/** PDF 1.5 cross-reference stream — the modern layout most real books use. */
function xrefStream() {
  const content = `BT /F1 12 Tf 72 720 Td (Cross-reference streams are the common case.) Tj ET`;
  return {
    name: "xref-stream",
    why: "PDF 1.5 cross-reference stream instead of a classic xref table",
    pdf: buildPdf(
      [
        L("<< /Type /Catalog /Pages 2 0 R >>"),
        L("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
        L("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"),
        stream("", content, { deflate: true }),
        L("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"),
      ],
      { compressXref: true }
    ),
    expect: ["Cross-reference streams are the common case."],
  };
}

/** A ToUnicode CMap, which is how subset-embedded fonts stay readable. */
function toUnicodeCmap() {
  // Codes 1..5 map to "G","a","p","!","s" — deliberately not their byte values,
  // so an extractor ignoring the CMap produces visibly wrong text rather than
  // accidentally-right text.
  const cmap = `/CIDInit /ProcSet findresource begin
12 dict begin begincmap
1 begincodespacerange <00> <FF> endcodespacerange
5 beginbfchar
<01> <0047>
<02> <0061>
<03> <0070>
<04> <0021>
<05> <0073>
endbfchar
endcmap end end`;
  const content = `BT /F1 12 Tf 72 720 Td <0102030405> Tj ET`;
  return {
    name: "tounicode-cmap",
    why: "subset font whose bytes are meaningless without the ToUnicode CMap",
    pdf: buildPdf([
      L("<< /Type /Catalog /Pages 2 0 R >>"),
      L("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
      L("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"),
      stream("", content),
      L("<< /Type /Font /Subtype /TrueType /BaseFont /ABCDEF+Custom /ToUnicode 6 0 R >>"),
      stream("", cmap),
    ]),
    expect: ["Gap!s"],
  };
}

/** Must be refused: no key, so any text produced would be invented. */
function encrypted() {
  const pdf = buildPdf([
    L("<< /Type /Catalog /Pages 2 0 R >>"),
    L("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    L("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>"),
    stream("", "BT ET"),
  ]);
  const patched = Buffer.from(
    pdf.toString("latin1").replace("/Root 1 0 R", "/Root 1 0 R /Encrypt 5 0 R"),
    "latin1"
  );
  return {
    name: "encrypted",
    why: "an encrypted document must be refused, never partially decoded",
    pdf: patched,
    expectRefusal: /encrypt/i,
  };
}

/** Must be refused per page: composite font with no ToUnicode map. */
function type0NoToUnicode() {
  const content = `BT /F1 12 Tf 72 720 Td <00480065> Tj ET`;
  return {
    name: "type0-no-tounicode",
    why: "a composite font with no ToUnicode map cannot be decoded; guessing yields mojibake",
    pdf: buildPdf([
      L("<< /Type /Catalog /Pages 2 0 R >>"),
      L("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
      L("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"),
      stream("", content),
      L("<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+CID /Encoding /Identity-H /DescendantFonts [6 0 R] >>"),
      L("<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+CID /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>"),
    ]),
    expectPageRefusal: [/ToUnicode/i],
  };
}

/** A page that is genuinely empty, beside one that is not. */
function thinPage() {
  const c1 = `BT /F1 12 Tf 72 720 Td (${"The denominator is the manifest. ".repeat(12)}) Tj ET`;
  return {
    name: "thin-page",
    why: "a genuinely blank page beside a full one — the low-yield gate must flag, not drop",
    pdf: buildPdf([
      L("<< /Type /Catalog /Pages 2 0 R >>"),
      L("<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 /Resources << /Font << /F1 5 0 R >> >> >>"),
      L("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>"),
      stream("", c1),
      L("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"),
      L("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 7 0 R >>"),
      stream("", "BT ET"),
    ]),
    expect: [("The denominator is the manifest. ".repeat(12)).trim(), ""],
  };
}

export function allFixtures() {
  return [simple(), flateTwoPage(), xrefStream(), toUnicodeCmap(), thinPage(), encrypted(), type0NoToUnicode()];
}
