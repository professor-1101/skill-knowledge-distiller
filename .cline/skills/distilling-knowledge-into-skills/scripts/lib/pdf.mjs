// pdf.mjs — the built-in reference extractor.
//
// Zero dependencies, stdlib only (`node:zlib` supplies FlateDecode). It exists
// so the pipeline has one extractor that is always present, always the same
// version, and whose behaviour is pinned by the conformance fixtures rather
// than by whatever a machine happens to have installed.
//
// **Its defining property is that it refuses rather than degrades.** Where it
// cannot faithfully recover text — an encrypted document, a filter it does not
// implement, a composite font with no ToUnicode map — it returns a gap for
// that page instead of partial or mojibake output. Degraded text that looks
// like text is the exact failure the ingestion tier exists to prevent, and an
// extractor that produces it is worse than one that stops.
//
// It is deliberately not claimed to beat poppler or MuPDF on hard documents.
// It is the always-available baseline and the independent second opinion: two
// extractors agreeing on a page is real evidence the conversion is right, and
// disagreement is a signal worth a human. See docs/extractors.md.

import zlib from "node:zlib";

// ---------------------------------------------------------------------------
// Lexer / object model
// ---------------------------------------------------------------------------

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

class Ref {
  constructor(num, gen) {
    this.num = num;
    this.gen = gen;
  }
}
class Name {
  constructor(v) {
    this.v = v;
  }
}
class PdfStream {
  constructor(dict, raw) {
    this.dict = dict;
    this.raw = raw;
  }
}

class Lexer {
  constructor(buf, pos = 0) {
    this.b = buf;
    this.p = pos;
  }
  skip() {
    for (;;) {
      while (this.p < this.b.length && WS.has(this.b[this.p])) this.p++;
      if (this.b[this.p] === 0x25) {
        // comment
        while (this.p < this.b.length && this.b[this.p] !== 0x0a && this.b[this.p] !== 0x0d) this.p++;
      } else return;
    }
  }
  peekByte() {
    this.skip();
    return this.b[this.p];
  }
  token() {
    this.skip();
    const start = this.p;
    if (this.p >= this.b.length) return null;
    const c = this.b[this.p];
    if (DELIM.has(c)) {
      if (c === 0x3c && this.b[this.p + 1] === 0x3c) {
        this.p += 2;
        return "<<";
      }
      if (c === 0x3e && this.b[this.p + 1] === 0x3e) {
        this.p += 2;
        return ">>";
      }
      this.p++;
      return String.fromCharCode(c);
    }
    while (this.p < this.b.length && !WS.has(this.b[this.p]) && !DELIM.has(this.b[this.p])) this.p++;
    return this.b.toString("latin1", start, this.p);
  }
  // Parse one object. `resolve` is optional and only needed for stream lengths.
  object(resolve) {
    this.skip();
    const c = this.b[this.p];
    if (c === undefined) return null;

    if (c === 0x2f) return this.name();
    if (c === 0x28) return this.literalString();
    if (c === 0x3c && this.b[this.p + 1] !== 0x3c) return this.hexString();
    if (c === 0x5b) {
      this.p++;
      const arr = [];
      for (;;) {
        this.skip();
        if (this.b[this.p] === 0x5d) {
          this.p++;
          return arr;
        }
        if (this.p >= this.b.length) return arr;
        arr.push(this.object(resolve));
      }
    }
    if (c === 0x3c && this.b[this.p + 1] === 0x3c) return this.dictOrStream(resolve);

    const save = this.p;
    const tok = this.token();
    if (tok === null) return null;
    if (tok === "true") return true;
    if (tok === "false") return false;
    if (tok === "null") return null;
    if (/^[+-]?[\d.]+$/.test(tok)) {
      // Possible "N G R" indirect reference.
      const mark = this.p;
      const t2 = this.token();
      if (t2 !== null && /^\d+$/.test(t2)) {
        const t3 = this.token();
        if (t3 === "R") return new Ref(parseInt(tok, 10), parseInt(t2, 10));
      }
      this.p = mark;
      return parseFloat(tok);
    }
    // Unknown keyword: hand it back as an operator-ish string.
    if (this.p === save) this.p++;
    return { op: tok };
  }
  name() {
    this.p++; // '/'
    const start = this.p;
    while (this.p < this.b.length && !WS.has(this.b[this.p]) && !DELIM.has(this.b[this.p])) this.p++;
    let s = this.b.toString("latin1", start, this.p);
    if (s.includes("#")) s = s.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    return new Name(s);
  }
  literalString() {
    this.p++; // '('
    const out = [];
    let depth = 1;
    while (this.p < this.b.length) {
      let ch = this.b[this.p++];
      if (ch === 0x5c) {
        const e = this.b[this.p++];
        const map = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12 };
        if (e in map) out.push(map[e]);
        else if (e >= 0x30 && e <= 0x37) {
          let oct = String.fromCharCode(e);
          for (let i = 0; i < 2 && this.b[this.p] >= 0x30 && this.b[this.p] <= 0x37; i++) {
            oct += String.fromCharCode(this.b[this.p++]);
          }
          out.push(parseInt(oct, 8) & 0xff);
        } else if (e === 0x0a) {
          /* line continuation */
        } else if (e === 0x0d) {
          if (this.b[this.p] === 0x0a) this.p++;
        } else out.push(e);
      } else if (ch === 0x28) {
        depth++;
        out.push(ch);
      } else if (ch === 0x29) {
        depth--;
        if (depth === 0) break;
        out.push(ch);
      } else out.push(ch);
    }
    return { bytes: Buffer.from(out) };
  }
  hexString() {
    this.p++; // '<'
    let hex = "";
    while (this.p < this.b.length && this.b[this.p] !== 0x3e) {
      const ch = String.fromCharCode(this.b[this.p++]);
      if (/[0-9a-fA-F]/.test(ch)) hex += ch;
    }
    this.p++;
    if (hex.length % 2) hex += "0";
    return { bytes: Buffer.from(hex, "hex") };
  }
  dictOrStream(resolve) {
    this.p += 2; // '<<'
    const d = {};
    for (;;) {
      this.skip();
      if (this.b[this.p] === 0x3e && this.b[this.p + 1] === 0x3e) {
        this.p += 2;
        break;
      }
      if (this.p >= this.b.length) break;
      const key = this.object(resolve);
      if (!(key instanceof Name)) {
        if (key === null) break;
        continue;
      }
      d[key.v] = this.object(resolve);
    }
    const mark = this.p;
    this.skip();
    if (this.b.toString("latin1", this.p, this.p + 6) === "stream") {
      this.p += 6;
      if (this.b[this.p] === 0x0d) this.p++;
      if (this.b[this.p] === 0x0a) this.p++;
      let len = d.Length;
      if (len instanceof Ref && resolve) len = resolve(len);
      const start = this.p;
      let end;
      if (typeof len === "number" && len >= 0 && start + len <= this.b.length) {
        end = start + len;
        // Trust but verify: a wrong /Length is common in damaged files.
        const after = this.b.toString("latin1", end, end + 20);
        if (!/^\s*endstream/.test(after)) end = undefined;
      }
      if (end === undefined) {
        const idx = this.b.indexOf("endstream", start, "latin1");
        end = idx === -1 ? this.b.length : idx;
        while (end > start && (this.b[end - 1] === 0x0a || this.b[end - 1] === 0x0d)) end--;
      }
      const raw = this.b.subarray(start, end);
      this.p = this.b.indexOf("endstream", end, "latin1");
      this.p = this.p === -1 ? this.b.length : this.p + 9;
      return new PdfStream(d, raw);
    }
    this.p = mark;
    return d;
  }
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

class Unsupported extends Error {}

function applyPredictor(data, parms, resolve) {
  if (!parms) return data;
  const p = resolve(parms) || {};
  const pred = resolve(p.Predictor) || 1;
  if (pred <= 1) return data;
  if (pred < 10) throw new Unsupported(`TIFF predictor ${pred}`);
  const colors = resolve(p.Colors) || 1;
  const bpc = resolve(p.BitsPerComponent) || 8;
  const columns = resolve(p.Columns) || 1;
  const bpp = Math.ceil((colors * bpc) / 8);
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  const out = [];
  let prev = Buffer.alloc(rowLen);
  for (let i = 0; i + 1 + rowLen <= data.length + rowLen; i += rowLen + 1) {
    if (i >= data.length) break;
    const ft = data[i];
    const row = Buffer.from(data.subarray(i + 1, i + 1 + rowLen));
    for (let j = 0; j < row.length; j++) {
      const a = j >= bpp ? row[j - bpp] : 0;
      const b = prev[j];
      const c = j >= bpp ? prev[j - bpp] : 0;
      if (ft === 1) row[j] = (row[j] + a) & 0xff;
      else if (ft === 2) row[j] = (row[j] + b) & 0xff;
      else if (ft === 3) row[j] = (row[j] + ((a + b) >> 1)) & 0xff;
      else if (ft === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        row[j] = (row[j] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
    }
    out.push(row);
    prev = row;
  }
  return Buffer.concat(out);
}

function ascii85(buf) {
  const s = buf.toString("latin1").replace(/\s/g, "").replace(/^<~/, "").replace(/~>$/, "");
  const out = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === "z") {
      out.push(0, 0, 0, 0);
      i++;
      continue;
    }
    const grp = s.slice(i, i + 5);
    i += 5;
    const pad = 5 - grp.length;
    let n = 0;
    for (const ch of grp.padEnd(5, "u")) n = n * 85 + (ch.charCodeAt(0) - 33);
    const bytes = [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
    out.push(...bytes.slice(0, 4 - pad));
  }
  return Buffer.from(out);
}

function decodeStream(stream, resolve) {
  let data = stream.raw;
  let filters = resolve(stream.dict.Filter);
  if (!filters) return data;
  if (!Array.isArray(filters)) filters = [filters];
  let parms = resolve(stream.dict.DecodeParms);
  if (!Array.isArray(parms)) parms = [parms];

  filters.forEach((f, i) => {
    const name = f instanceof Name ? f.v : String(f);
    if (name === "FlateDecode" || name === "Fl") {
      try {
        data = zlib.inflateSync(data);
      } catch {
        try {
          data = zlib.inflateRawSync(data.subarray(1));
        } catch (e) {
          throw new Unsupported(`FlateDecode failed (${e.message})`);
        }
      }
      data = applyPredictor(data, parms[i], resolve);
    } else if (name === "ASCIIHexDecode" || name === "AHx") {
      const hex = data.toString("latin1").split(">")[0].replace(/\s/g, "");
      data = Buffer.from(hex.length % 2 ? hex + "0" : hex, "hex");
    } else if (name === "ASCII85Decode" || name === "A85") {
      data = ascii85(data);
      data = applyPredictor(data, parms[i], resolve);
    } else if (name === "Crypt") {
      /* identity in practice for unencrypted files */
    } else {
      // LZWDecode, DCTDecode, CCITTFaxDecode, JBIG2Decode, RunLengthDecode.
      // Refusing is the correct behaviour: guessing at image codecs would
      // produce bytes that are not text and look like text.
      throw new Unsupported(`filter ${name}`);
    }
  });
  return data;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

class Doc {
  constructor(buf) {
    this.b = buf;
    this.offsets = new Map(); // num -> byte offset
    this.compressed = new Map(); // num -> {stm, idx}
    this.cache = new Map();
    this.trailer = {};
    this.resolve = this.resolve.bind(this);
  }

  load() {
    try {
      this.readXref();
    } catch {
      this.offsets.clear();
    }
    // A scan is not a fallback for convenience — a damaged or
    // incrementally-updated xref is common, and refusing the whole document
    // over it would lose books that are perfectly readable.
    if (!this.offsets.size || !this.trailer.Root) this.scanObjects();
    if (!this.trailer.Root) throw new Unsupported("no document catalog (/Root) found");
  }

  readXref() {
    const tail = this.b.toString("latin1", Math.max(0, this.b.length - 2048));
    const m = /startxref\s+(\d+)/g;
    let last = null;
    let mm;
    while ((mm = m.exec(tail))) last = mm[1];
    if (last === null) throw new Unsupported("no startxref");
    const seen = new Set();
    let pos = parseInt(last, 10);
    while (pos !== undefined && pos >= 0 && pos < this.b.length && !seen.has(pos)) {
      seen.add(pos);
      pos = this.readXrefSection(pos);
    }
  }

  readXrefSection(pos) {
    const lx = new Lexer(this.b, pos);
    lx.skip();
    if (this.b.toString("latin1", lx.p, lx.p + 4) === "xref") {
      lx.p += 4;
      for (;;) {
        lx.skip();
        if (this.b.toString("latin1", lx.p, lx.p + 7) === "trailer") {
          lx.p += 7;
          const tr = lx.object(this.resolve) || {};
          for (const [k, v] of Object.entries(tr)) if (!(k in this.trailer)) this.trailer[k] = v;
          if (tr.XRefStm !== undefined) this.readXrefSection(Number(tr.XRefStm));
          return tr.Prev !== undefined ? Number(tr.Prev) : undefined;
        }
        const startTok = lx.token();
        const countTok = lx.token();
        if (!/^\d+$/.test(startTok || "") || !/^\d+$/.test(countTok || "")) return undefined;
        const start = parseInt(startTok, 10);
        const count = parseInt(countTok, 10);
        for (let i = 0; i < count; i++) {
          lx.skip();
          const off = parseInt(this.b.toString("latin1", lx.p, lx.p + 10), 10);
          const type = this.b.toString("latin1", lx.p + 17, lx.p + 18);
          lx.p += 18;
          const num = start + i;
          if (type === "n" && !this.offsets.has(num) && !this.compressed.has(num)) {
            this.offsets.set(num, off);
          }
        }
      }
    }
    // Cross-reference stream.
    lx.token();
    lx.token();
    lx.token(); // N G obj
    const stm = lx.object(this.resolve);
    if (!(stm instanceof PdfStream)) throw new Unsupported("xref is neither a table nor a stream");
    const d = stm.dict;
    for (const [k, v] of Object.entries(d)) if (!(k in this.trailer)) this.trailer[k] = v;
    const w = (this.resolve(d.W) || []).map(Number);
    const size = Number(this.resolve(d.Size) || 0);
    let index = this.resolve(d.Index);
    if (!Array.isArray(index)) index = [0, size];
    const data = decodeStream(stm, this.resolve);
    const rowLen = w.reduce((a, x) => a + x, 0);
    let p = 0;
    for (let s = 0; s < index.length; s += 2) {
      const start = Number(index[s]);
      const count = Number(index[s + 1]);
      for (let i = 0; i < count && p + rowLen <= data.length; i++, p += rowLen) {
        const f = [];
        let q = p;
        for (const width of w) {
          let val = 0;
          for (let k = 0; k < width; k++) val = val * 256 + data[q++];
          f.push(width === 0 ? null : val);
        }
        const type = w[0] === 0 ? 1 : f[0];
        const num = start + i;
        if (this.offsets.has(num) || this.compressed.has(num)) continue;
        if (type === 1) this.offsets.set(num, f[1]);
        else if (type === 2) this.compressed.set(num, { stm: f[1], idx: f[2] });
      }
    }
    return d.Prev !== undefined ? Number(this.resolve(d.Prev)) : undefined;
  }

  scanObjects() {
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    const s = this.b.toString("latin1");
    let m;
    while ((m = re.exec(s))) this.offsets.set(parseInt(m[1], 10), m.index);
    if (!this.trailer.Root) {
      const t = s.lastIndexOf("trailer");
      if (t !== -1) {
        const lx = new Lexer(this.b, t + 7);
        const tr = lx.object(this.resolve) || {};
        for (const [k, v] of Object.entries(tr)) if (!(k in this.trailer)) this.trailer[k] = v;
      }
    }
    if (!this.trailer.Root) {
      // Catalog by inspection — an xref stream's /Root lives in its dict.
      const c = s.indexOf("/Type /Catalog") !== -1 ? s.indexOf("/Type /Catalog") : s.indexOf("/Type/Catalog");
      if (c !== -1) {
        const objStart = s.lastIndexOf(" obj", c);
        const numM = /(\d+)\s+(\d+)\s+obj\s*$/.exec(s.slice(Math.max(0, objStart - 24), objStart + 4));
        if (numM) this.trailer.Root = new Ref(parseInt(numM[1], 10), 0);
      }
    }
  }

  resolve(o) {
    if (!(o instanceof Ref)) return o;
    const key = o.num;
    if (this.cache.has(key)) return this.cache.get(key);
    this.cache.set(key, null); // cycle guard
    let val = null;
    if (this.offsets.has(key)) {
      const lx = new Lexer(this.b, this.offsets.get(key));
      const n = lx.token();
      lx.token();
      const kw = lx.token();
      if (kw === "obj" && parseInt(n, 10) === key) val = lx.object(this.resolve);
    } else if (this.compressed.has(key)) {
      val = this.fromObjStm(key);
    }
    this.cache.set(key, val);
    return val;
  }

  fromObjStm(num) {
    const { stm } = this.compressed.get(num);
    if (!this._objstm) this._objstm = new Map();
    if (!this._objstm.has(stm)) {
      const container = this.resolve(new Ref(stm, 0));
      if (!(container instanceof PdfStream)) return null;
      const data = decodeStream(container, this.resolve);
      const n = Number(this.resolve(container.dict.N));
      const first = Number(this.resolve(container.dict.First));
      const head = new Lexer(data, 0);
      const pairs = [];
      for (let i = 0; i < n; i++) {
        const a = head.token();
        const b = head.token();
        pairs.push([parseInt(a, 10), parseInt(b, 10)]);
      }
      const map = new Map();
      for (const [objNum, off] of pairs) {
        const lx = new Lexer(data, first + off);
        map.set(objNum, lx.object(this.resolve));
      }
      this._objstm.set(stm, map);
    }
    return this._objstm.get(stm).get(num) ?? null;
  }

  pages() {
    const root = this.resolve(this.trailer.Root);
    if (!root) throw new Unsupported("no catalog");
    const out = [];
    const walk = (nodeRef, inherited, depth) => {
      if (depth > 64 || out.length > 20000) return;
      const node = this.resolve(nodeRef);
      if (!node || node instanceof PdfStream) return;
      const inh = { ...inherited };
      for (const k of ["Resources", "MediaBox", "Rotate"]) if (node[k] !== undefined) inh[k] = node[k];
      const type = this.resolve(node.Type);
      const kids = this.resolve(node.Kids);
      if (Array.isArray(kids)) {
        for (const k of kids) walk(k, inh, depth + 1);
      } else if (!type || (type instanceof Name && type.v === "Page")) {
        out.push({ dict: node, inherited: inh });
      }
    };
    const pagesRef = root.Pages;
    if (pagesRef === undefined) throw new Unsupported("catalog has no /Pages");
    walk(pagesRef, {}, 0);
    if (!out.length) throw new Unsupported("page tree yielded no pages");
    return out;
  }
}

// ---------------------------------------------------------------------------
// Fonts: byte sequences to text
// ---------------------------------------------------------------------------

const WIN_ANSI_HIGH = {
  128: "€", 130: "‚", 131: "ƒ", 132: "„", 133: "…",
  134: "†", 135: "‡", 136: "ˆ", 137: "‰", 138: "Š",
  139: "‹", 140: "Œ", 142: "Ž", 145: "‘", 146: "’",
  147: "“", 148: "”", 149: "•", 150: "–", 151: "—",
  152: "˜", 153: "™", 154: "š", 155: "›", 156: "œ",
  158: "ž", 159: "Ÿ",
};

function parseToUnicode(data) {
  const s = data.toString("latin1");
  const map = new Map();
  const hex = (h) => {
    let out = "";
    for (let i = 0; i + 4 <= h.length; i += 4) out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    return out;
  };
  for (const m of s.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      map.set(parseInt(p[1], 16), hex(p[2]));
    }
  }
  for (const m of s.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = m[1];
    for (const p of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const lo = parseInt(p[1], 16);
      const hi = parseInt(p[2], 16);
      const dst = parseInt(p[3], 16);
      if (hi - lo > 65535) continue;
      for (let c = lo; c <= hi; c++) map.set(c, String.fromCharCode(dst + (c - lo)));
    }
    for (const p of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g)) {
      const lo = parseInt(p[1], 16);
      const items = [...p[3].matchAll(/<([0-9a-fA-F]*)>/g)];
      items.forEach((it, i) => map.set(lo + i, hex(it[1])));
    }
  }
  return map;
}

function buildFont(fontDict, doc) {
  const R = doc.resolve;
  const subtype = R(fontDict.Subtype);
  const st = subtype instanceof Name ? subtype.v : "";
  const font = { twoByte: false, toUnicode: null, diff: new Map(), base: "std" };

  const tu = R(fontDict.ToUnicode);
  if (tu instanceof PdfStream) {
    try {
      font.toUnicode = parseToUnicode(decodeStream(tu, R));
    } catch {
      font.toUnicode = null;
    }
  }

  if (st === "Type0") {
    font.twoByte = true;
    // A composite font without a ToUnicode map cannot be decoded to text
    // without embedded font programs and CID-to-GID tables. Producing bytes
    // anyway yields plausible-looking mojibake, which is worse than nothing.
    if (!font.toUnicode) font.undecodable = "Type0 font with no ToUnicode map";
    return font;
  }

  const enc = R(fontDict.Encoding);
  if (enc instanceof Name) font.base = enc.v;
  else if (enc && typeof enc === "object" && !(enc instanceof PdfStream)) {
    const be = R(enc.BaseEncoding);
    if (be instanceof Name) font.base = be.v;
    const diffs = R(enc.Differences);
    if (Array.isArray(diffs)) {
      let code = 0;
      for (const item of diffs) {
        const v = R(item);
        if (typeof v === "number") code = v;
        else if (v instanceof Name) font.diff.set(code++, glyphToChar(v.v));
      }
    }
  }
  return font;
}

const GLYPHS = {
  space: " ", quotesingle: "'", quotedbl: '"', hyphen: "-", period: ".",
  comma: ",", colon: ":", semicolon: ";", quoteright: "’",
  quoteleft: "‘", quotedblleft: "“", quotedblright: "”",
  endash: "–", emdash: "—", bullet: "•", fi: "fi", fl: "fl",
  ellipsis: "…", parenleft: "(", parenright: ")", slash: "/",
};

function glyphToChar(g) {
  if (GLYPHS[g]) return GLYPHS[g];
  if (/^uni([0-9A-Fa-f]{4})$/.test(g)) return String.fromCharCode(parseInt(g.slice(3), 16));
  if (g.length === 1) return g;
  return "";
}

function decodeText(bytes, font) {
  if (font.undecodable) return null;
  let out = "";
  if (font.twoByte) {
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = (bytes[i] << 8) | bytes[i + 1];
      const t = font.toUnicode?.get(code);
      if (t === undefined) return null;
      out += t;
    }
    return out;
  }
  for (const c of bytes) {
    if (font.toUnicode?.has(c)) {
      out += font.toUnicode.get(c);
      continue;
    }
    if (font.diff.has(c)) {
      out += font.diff.get(c);
      continue;
    }
    if (c >= 32 && c < 127) out += String.fromCharCode(c);
    else if (font.base.startsWith("WinAnsi") && WIN_ANSI_HIGH[c]) out += WIN_ANSI_HIGH[c];
    else if (c >= 160) out += String.fromCharCode(c);
    else if (c === 9 || c === 10 || c === 13) out += " ";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Content stream to text
// ---------------------------------------------------------------------------

function pageText(page, doc) {
  const R = doc.resolve;
  let contents = R(page.dict.Contents);
  const parts = [];
  const streams = Array.isArray(contents) ? contents : [contents];
  for (const c of streams) {
    const s = R(c);
    if (s instanceof PdfStream) parts.push(decodeStream(s, R));
  }
  if (!parts.length) return "";
  const data = Buffer.concat(parts.map((p) => Buffer.concat([p, Buffer.from("\n")])));

  const resources = R(page.dict.Resources ?? page.inherited.Resources) || {};
  const fontsDict = R(resources.Font) || {};
  const fonts = new Map();
  const getFont = (name) => {
    if (fonts.has(name)) return fonts.get(name);
    const fd = R(fontsDict[name]);
    const f = fd && typeof fd === "object" ? buildFont(fd, doc) : { base: "std", diff: new Map() };
    fonts.set(name, f);
    return f;
  };

  const lx = new Lexer(data, 0);
  const stack = [];
  let out = "";
  let font = { base: "std", diff: new Map() };
  let lastY = null;
  let lastX = null;
  let tm = null;
  let leading = 0;
  let undecodable = null;

  const emit = (t) => {
    if (t === null) {
      // Name the actual reason. "Could not decode" sends someone looking for a
      // corrupt file when the real answer is a subset font shipped without the
      // map that makes its bytes mean anything.
      undecodable = undecodable || font.undecodable || "font with no recoverable encoding";
      return;
    }
    out += t;
  };
  const newline = () => {
    if (out && !out.endsWith("\n")) out += "\n";
  };

  while (lx.p < data.length) {
    const before = lx.p;
    const o = lx.object(R);
    if (o === null && lx.p === before) break;
    if (o && o.op) {
      const op = o.op;
      const a = stack;
      if (op === "BT") {
        tm = [1, 0, 0, 1, 0, 0];
        lastY = null;
        lastX = null;
      } else if (op === "ET") {
        newline();
      } else if (op === "Tf") {
        const nm = a[a.length - 2];
        if (nm instanceof Name) font = getFont(nm.v);
      } else if (op === "TL") {
        leading = Number(a[a.length - 1]) || 0;
      } else if (op === "Td" || op === "TD") {
        const ty = Number(a[a.length - 1]) || 0;
        const tx = Number(a[a.length - 2]) || 0;
        if (op === "TD") leading = -ty;
        if (tm) {
          tm[4] += tx;
          tm[5] += ty;
        }
        if (ty !== 0) newline();
        else if (tx > 0 && out && !out.endsWith(" ") && !out.endsWith("\n")) out += " ";
      } else if (op === "Tm") {
        const n = a.slice(-6).map(Number);
        if (n.length === 6) {
          if (lastY !== null && Math.abs(n[5] - lastY) > 0.6) newline();
          else if (lastX !== null && n[4] - lastX > 1 && out && !out.endsWith(" ") && !out.endsWith("\n")) out += " ";
          tm = n;
          lastY = n[5];
          lastX = n[4];
        }
      } else if (op === "T*") {
        newline();
        if (tm) tm[5] -= leading;
      } else if (op === "Tj") {
        const s = a[a.length - 1];
        if (s && s.bytes) emit(decodeText(s.bytes, font));
      } else if (op === "'" || op === '"') {
        newline();
        const s = a[a.length - 1];
        if (s && s.bytes) emit(decodeText(s.bytes, font));
      } else if (op === "TJ") {
        const arr = a[a.length - 1];
        if (Array.isArray(arr)) {
          for (const item of arr) {
            if (item && item.bytes) emit(decodeText(item.bytes, font));
            else if (typeof item === "number" && item < -120) {
              if (out && !out.endsWith(" ") && !out.endsWith("\n")) out += " ";
            }
          }
        }
      }
      if (tm) lastY = tm[5];
      stack.length = 0;
    } else {
      stack.push(o);
      if (stack.length > 64) stack.shift();
    }
  }

  if (undecodable) throw new Unsupported(undecodable);
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract text page by page.
 *
 * Returns `{ pages: [{ page, text, error }] }`. A page that could not be
 * faithfully recovered carries `error` and `text: null` — never partial text.
 * The caller turns that into a gap record; it must not become an empty page,
 * because an empty page reports as covered.
 */
export function extractPdf(buffer) {
  const doc = new Doc(buffer);
  if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new Unsupported("not a PDF (missing %PDF- header)");
  }
  doc.load();
  if (doc.trailer.Encrypt !== undefined) {
    throw new Unsupported(
      "the document is encrypted; decrypt it first rather than extracting what happens to come through"
    );
  }
  const pages = doc.pages();
  const out = [];
  pages.forEach((p, i) => {
    try {
      out.push({ page: i + 1, text: pageText(p, doc), error: null });
    } catch (e) {
      out.push({ page: i + 1, text: null, error: e.message });
    }
  });
  return { pages: out };
}

export { Unsupported };
