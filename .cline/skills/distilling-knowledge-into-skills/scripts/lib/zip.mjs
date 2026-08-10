// zip.mjs — read a ZIP container with nothing but node:zlib.
//
// An EPUB is a ZIP, so this is the floor of the whole ingestion tier. It reads
// the central directory rather than scanning for local headers, because the
// central directory is the archive's own index — scanning finds deleted and
// shadowed entries that the archive does not consider present, which is
// exactly the sort of plausible-but-wrong result the pipeline exists to avoid.
//
// Refuses rather than guesses: an unsupported compression method, a CRC
// mismatch, or a truncated archive throws. A partially-read book that looks
// whole is the failure mode here.

import zlib from "node:zlib";

export class ZipError extends Error {}

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function findEocd(buf) {
  // The comment field may be up to 64 KiB, so scan back that far and no more.
  const min = Math.max(0, buf.length - 0x10000 - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new ZipError("not a ZIP archive: no end-of-central-directory record");
}

/**
 * Parse the archive index.
 *
 * Returns entries in central-directory order, which for an EPUB is the order
 * the producer wrote them — worth preserving because `mimetype` must be first
 * and uncompressed, and that is a conformance signal we check later.
 */
export function readZip(buf) {
  if (buf.length < 22) throw new ZipError("file is too small to be a ZIP archive");
  const eocd = findEocd(buf);

  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  let cdSize = buf.readUInt32LE(eocd + 12);

  // ZIP64: a large book with many resources legitimately exceeds the 16-bit
  // count or the 32-bit offset, and silently reading the truncated values
  // would drop entries without a word.
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    const locator = eocd - 20;
    if (locator >= 0 && buf.readUInt32LE(locator) === EOCD64_LOCATOR_SIG) {
      const z64 = Number(buf.readBigUInt64LE(locator + 8));
      if (buf.readUInt32LE(z64) !== EOCD64_SIG) throw new ZipError("ZIP64 locator points at no ZIP64 record");
      count = Number(buf.readBigUInt64LE(z64 + 32));
      cdSize = Number(buf.readBigUInt64LE(z64 + 40));
      cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
    } else {
      throw new ZipError("archive claims ZIP64 values but carries no ZIP64 record");
    }
  }

  if (cdOffset + cdSize > buf.length) {
    throw new ZipError("central directory runs past the end of the file — the archive is truncated");
  }

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) {
      throw new ZipError(`central directory entry ${i + 1} of ${count} is malformed`);
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    let csize = buf.readUInt32LE(p + 20);
    let usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    let local = buf.readUInt32LE(p + 42);
    // Names are UTF-8 when bit 11 is set; CP437 otherwise. EPUB requires UTF-8,
    // and treating a CP437 name as UTF-8 only mangles non-ASCII filenames,
    // which surfaces as a missing-resource refusal rather than silent loss.
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);

    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) {
      const extra = buf.subarray(p + 46 + nlen, p + 46 + nlen + elen);
      let q = 0;
      while (q + 4 <= extra.length) {
        const id = extra.readUInt16LE(q);
        const size = extra.readUInt16LE(q + 2);
        if (id === 0x0001) {
          let r = q + 4;
          if (usize === 0xffffffff) { usize = Number(extra.readBigUInt64LE(r)); r += 8; }
          if (csize === 0xffffffff) { csize = Number(extra.readBigUInt64LE(r)); r += 8; }
          if (local === 0xffffffff) { local = Number(extra.readBigUInt64LE(r)); r += 8; }
          break;
        }
        q += 4 + size;
      }
    }

    entries.push({ name, method, crc, csize, usize, local, flags, dir: name.endsWith("/") });
    p += 46 + nlen + elen + clen;
  }

  return { entries, buf };
}

/** Decompress one entry, verifying its CRC. A wrong CRC is a refusal. */
export function readEntry(zip, entry) {
  const { buf } = zip;
  if (entry.dir) return Buffer.alloc(0);
  if (buf.readUInt32LE(entry.local) !== LOCAL_SIG) {
    throw new ZipError(`'${entry.name}': local header missing at the offset the index gives`);
  }
  const nlen = buf.readUInt16LE(entry.local + 26);
  const elen = buf.readUInt16LE(entry.local + 28);
  const start = entry.local + 30 + nlen + elen;
  const raw = buf.subarray(start, start + entry.csize);
  if (start + entry.csize > buf.length) {
    throw new ZipError(`'${entry.name}': data runs past the end of the file`);
  }

  let out;
  if (entry.method === 0) out = Buffer.from(raw);
  else if (entry.method === 8) {
    try {
      out = zlib.inflateRawSync(raw);
    } catch (e) {
      throw new ZipError(`'${entry.name}': deflate stream is corrupt (${e.message})`);
    }
  } else {
    throw new ZipError(
      `'${entry.name}': compression method ${entry.method} is not supported. ` +
        `Guessing at the bytes would produce something that looks like content and is not.`
    );
  }

  // The CRC is the archive's own claim about its contents. Checking it is what
  // separates "we read the file" from "we read something".
  if (entry.crc !== 0 && crc32(out) !== entry.crc) {
    throw new ZipError(`'${entry.name}': CRC mismatch — the entry is corrupt`);
  }
  if (entry.usize !== 0 && out.length !== entry.usize) {
    throw new ZipError(
      `'${entry.name}': decompressed to ${out.length} bytes, index says ${entry.usize}`
    );
  }
  return out;
}

/** Name-keyed access, with the duplicate-name case made loud. */
export function zipMap(zip) {
  const map = new Map();
  for (const e of zip.entries) {
    if (e.dir) continue;
    if (map.has(e.name)) {
      throw new ZipError(
        `'${e.name}' appears twice in the archive index. Which one a reader gets ` +
          `is undefined, so neither can be trusted as the source of a claim.`
      );
    }
    map.set(e.name, e);
  }
  return map;
}

export { crc32 };
