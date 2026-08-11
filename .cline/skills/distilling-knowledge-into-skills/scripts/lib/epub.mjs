// epub.mjs — the reference extractor, and the reason EPUB is the only format.
//
// A PDF has no semantic structure to recover: reading order, headings and the
// table of contents all have to be inferred from where text sits on a page,
// and every inference is a place where a wrong-but-plausible result enters the
// store. An EPUB states all three, in markup we can hold and check.
//
// The consequence that matters most: **extraction here can be verified rather
// than estimated.** `reconcile()` walks the source XHTML, collects every text
// node the tokenizer sees, and asserts each one reached the output. PDF admits
// no such check, which is why it needed an entire mechanism of human page
// declarations to compensate.
//
// Refuses rather than degrades, the same posture throughout: DRM, a spine item
// missing from the archive, a malformed package document, a spine entry with
// no manifest counterpart. Partial text that looks whole is the failure being
// guarded against.

import path from "node:path";
import { readZip, readEntry, zipMap, ZipError } from "./zip.mjs";
import { walk, findAll, textOf, decodeEntities, XmlError } from "./xml.mjs";

export class EpubError extends Error {}

export const EXTRACTOR_VERSION = "1.0.0";

// Elements whose content is not prose. Excluded from both extraction and
// reconciliation, so the exclusion is one list rather than two that can drift.
export const NON_PROSE = new Set(["script", "style", "head", "title", "meta", "link"]);

// Elements that end a line. Everything else is inline, so a `<em>` inside a
// sentence does not split it.
const BLOCK = new Set([
  "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr", "td", "th",
  "blockquote", "pre", "section", "article", "header", "footer", "aside",
  "figure", "figcaption", "dt", "dd", "table", "ul", "ol", "dl", "hr", "br",
  "nav", "body", "main", "caption", "address",
]);

const HEADING = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

function resolveHref(base, href) {
  const clean = String(href).split("#")[0];
  if (!clean) return null;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(base), decodeURIComponent(clean)));
  return joined.replace(/^\.\//, "");
}

// ---------------------------------------------------------------------------
// Package
// ---------------------------------------------------------------------------

export function openEpub(buffer) {
  let zip;
  try {
    zip = readZip(buffer);
  } catch (e) {
    throw new EpubError(e instanceof ZipError ? e.message : `not a readable archive: ${e.message}`);
  }
  const files = zipMap(zip);
  const read = (name) => {
    const e = files.get(name);
    if (!e) return null;
    return readEntry(zip, e);
  };

  const mimetype = read("mimetype");
  if (!mimetype || mimetype.toString("utf8").trim() !== "application/epub+zip") {
    throw new EpubError(
      "no `mimetype` entry declaring application/epub+zip — this is not an EPUB. " +
        "Only EPUB is supported; there is no fallback format."
    );
  }

  // DRM. Refusing is the only honest option: whatever we could read from an
  // encrypted resource would be bytes we cannot attribute to the book.
  if (files.has("META-INF/encryption.xml")) {
    const enc = read("META-INF/encryption.xml").toString("utf8");
    throw new EpubError(
      "the book is encrypted (META-INF/encryption.xml is present" +
        (/adept|lcp/i.test(enc) ? ", carrying DRM" : "") +
        "). Extraction is refused: text recovered from an encrypted resource cannot " +
        "be attributed to the source. Supply a DRM-free copy."
    );
  }

  const container = read("META-INF/container.xml");
  if (!container) throw new EpubError("META-INF/container.xml is missing — the archive is not a valid EPUB");
  const rootfiles = findAll(container.toString("utf8"), "rootfile");
  const opfPath = rootfiles.map((r) => r["full-path"]).find(Boolean);
  if (!opfPath) throw new EpubError("container.xml names no rootfile, so the package document cannot be found");

  const opfBuf = read(opfPath);
  if (!opfBuf) throw new EpubError(`the package document '${opfPath}' named by container.xml is not in the archive`);
  const opf = opfBuf.toString("utf8");

  const pkg = parsePackage(opf, opfPath, files);
  return { zip, files, read, opfPath, ...pkg };
}

function parsePackage(opf, opfPath, files) {
  const items = new Map();
  for (const a of findAll(opf, "item")) {
    if (!a.id || !a.href) continue;
    const resolved = resolveHref(opfPath, a.href);
    items.set(a.id, {
      id: a.id,
      href: a.href,
      path: resolved,
      mediaType: a["media-type"] || "",
      properties: (a.properties || "").split(/\s+/).filter(Boolean),
      present: resolved ? files.has(resolved) : false,
    });
  }
  if (!items.size) throw new EpubError("the package document declares no manifest items");

  const spineAttrs = findAll(opf, "spine")[0] || {};
  const spine = [];
  for (const a of findAll(opf, "itemref")) {
    if (!a.idref) continue;
    const item = items.get(a.idref);
    if (!item) {
      throw new EpubError(
        `spine references '${a.idref}', which the manifest does not declare. ` +
          `The reading order is therefore incomplete and cannot be trusted as the denominator.`
      );
    }
    spine.push({ ...item, linear: (a.linear || "yes").toLowerCase() !== "no" });
  }
  if (!spine.length) throw new EpubError("the spine is empty — the book has no reading order");

  for (const s of spine) {
    if (!s.present) {
      throw new EpubError(
        `spine document '${s.path}' is missing from the archive. Extracting the ` +
          `rest would report a book with a hole in it as complete.`
      );
    }
    if (s.mediaType && !/xhtml|html|xml/i.test(s.mediaType)) {
      throw new EpubError(
        `spine document '${s.path}' has media type '${s.mediaType}', which is not ` +
          `a content document. Its text cannot be recovered as prose.`
      );
    }
  }

  const version = (findAll(opf, "package")[0] || {}).version || "";
  const title = textOf(opf, "dc:title") || textOf(opf, "title") || "";
  const language = textOf(opf, "dc:language") || "";
  const identifier = textOf(opf, "dc:identifier") || "";

  return {
    items,
    spine,
    version,
    tocId: spineAttrs.toc || null,
    metadata: { title, language, identifier },
  };
}

// ---------------------------------------------------------------------------
// Table of contents — EPUB 3 nav, EPUB 2 NCX
// ---------------------------------------------------------------------------

/**
 * The TOC, nested, in the source's own order.
 *
 * This is the artifact that makes R5 real. A manifest transcribed from here is
 * transcription; a manifest written by a model is recollection, and the
 * difference is the whole reason the enumerate stage exists.
 */
export function readToc(book) {
  const navItem = [...book.items.values()].find((i) => i.properties.includes("nav"));
  if (navItem && navItem.present) {
    const entries = parseNav(book.read(navItem.path).toString("utf8"), navItem.path);
    if (entries.length) return { source: "nav", path: navItem.path, entries };
  }
  const ncxItem =
    (book.tocId && book.items.get(book.tocId)) ||
    [...book.items.values()].find((i) => /ncx/i.test(i.mediaType) || /\.ncx$/i.test(i.path || ""));
  if (ncxItem && ncxItem.present) {
    const entries = parseNcx(book.read(ncxItem.path).toString("utf8"), ncxItem.path);
    if (entries.length) return { source: "ncx", path: ncxItem.path, entries };
  }
  return { source: null, path: null, entries: [] };
}

/** EPUB 3 `nav` — nested `<ol><li><a>`, arbitrary depth. */
function parseNav(xhtml, navPath, type = "toc") {
  const roots = [];
  const stack = [];
  let inNav = false;
  let navDepth = 0;
  let olDepth = 0;
  let pending = null;
  let collecting = null;

  walk(xhtml, {
    onOpen(name, attrs) {
      if (name === "nav") {
        const t = attrs["epub:type"] || attrs.type || attrs.role || "";
        // A book may carry several navs (toc, landmarks, page-list). Only the
        // requested one is the table of contents.
        inNav = t.split(/\s+/).includes(type) || (!t && type === "toc" && !roots.length);
        navDepth = 0;
        return;
      }
      if (!inNav) return;
      if (name === "ol" || name === "ul") olDepth++;
      if (name === "a" || name === "span") {
        pending = {
          href: attrs.href ? resolveHref(navPath, attrs.href) : null,
          fragment: attrs.href && attrs.href.includes("#") ? attrs.href.split("#")[1] : null,
          rawHref: attrs.href || null,
          title: "",
          depth: olDepth,
          children: [],
        };
        collecting = pending;
      }
      navDepth++;
    },
    onText(t) {
      if (collecting) collecting.title += t;
    },
    onClose(name) {
      if (name === "nav") {
        inNav = false;
        return;
      }
      if (!inNav) return;
      if (name === "a" || name === "span") {
        if (pending) {
          pending.title = pending.title.replace(/\s+/g, " ").trim();
          const parent = stack[stack.length - 1];
          if (parent && pending.depth > parent.depth) parent.children.push(pending);
          else {
            while (stack.length && stack[stack.length - 1].depth >= pending.depth) stack.pop();
            const p2 = stack[stack.length - 1];
            if (p2) p2.children.push(pending);
            else roots.push(pending);
          }
          stack.push(pending);
          pending = null;
        }
        collecting = null;
      }
      if (name === "ol" || name === "ul") {
        olDepth--;
        while (stack.length && stack[stack.length - 1].depth > olDepth) stack.pop();
      }
    },
  });

  return roots;
}

/** EPUB 2 `.ncx` — nested `<navPoint>` with `<navLabel><text>` and `<content src>`. */
function parseNcx(xml, ncxPath) {
  const roots = [];
  const stack = [];
  let inLabel = false;
  let current = null;

  walk(xml, {
    onOpen(name, attrs) {
      const local = name.includes(":") ? name.split(":").pop() : name;
      if (local === "navpoint") {
        const node = { href: null, fragment: null, rawHref: null, title: "", depth: stack.length, children: [] };
        const parent = stack[stack.length - 1];
        (parent ? parent.children : roots).push(node);
        stack.push(node);
        current = node;
      } else if (local === "text") {
        inLabel = true;
      } else if (local === "content" && current && attrs.src) {
        current.href = resolveHref(ncxPath, attrs.src);
        current.rawHref = attrs.src;
        current.fragment = attrs.src.includes("#") ? attrs.src.split("#")[1] : null;
      }
    },
    onText(t) {
      if (inLabel && current) current.title += t;
    },
    onClose(name) {
      const local = name.includes(":") ? name.split(":").pop() : name;
      if (local === "text") inLabel = false;
      if (local === "navpoint") {
        if (current) current.title = current.title.replace(/\s+/g, " ").trim();
        stack.pop();
        current = stack[stack.length - 1] || null;
      }
    },
  });

  return roots;
}

/** EPUB 3 `page-list`, when the publisher maps to a print edition. */
export function readPageList(book) {
  const navItem = [...book.items.values()].find((i) => i.properties.includes("nav"));
  if (!navItem || !navItem.present) return [];
  return parseNav(book.read(navItem.path).toString("utf8"), navItem.path, "page-list");
}

/** Flatten to a depth, keeping deeper entries recorded rather than dropped. */
export function flattenToc(entries, maxDepth, out = [], depth = 1) {
  for (const e of entries) {
    if (depth <= maxDepth) {
      out.push({ title: e.title, href: e.href, fragment: e.fragment, depth });
    }
    if (e.children.length) flattenToc(e.children, maxDepth, out, depth + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

/**
 * Extract prose from one content document.
 *
 * Images contribute a `media` record and no text. Their `alt` is deliberately
 * not injected into the prose stream: it is metadata about a figure, not body
 * text, and splicing it in would put words into the store at offsets the source
 * does not have.
 */
export function extractDocument(xhtml, href) {
  let text = "";
  const media = [];
  const headings = [];
  const anchors = [];
  const skip = [];
  let headingLevel = null;
  let headingStart = 0;

  const atBlockEdge = () => !text || text.endsWith("\n");
  const breakLine = () => {
    if (!atBlockEdge()) text += "\n";
  };

  walk(xhtml, {
    onOpen(name, attrs) {
      if (NON_PROSE.has(name)) skip.push(name);
      if (skip.length) return;

      if (attrs.id) anchors.push({ id: attrs.id, offset: text.length });
      if (name === "img" || name === "image") {
        media.push({ kind: "image", src: attrs.src || attrs["xlink:href"] || null, alt: attrs.alt ?? null, offset: text.length });
        return;
      }
      if (name === "audio" || name === "video") {
        media.push({ kind: name, src: attrs.src || null, offset: text.length });
      }
      if (BLOCK.has(name)) breakLine();
      if (HEADING.has(name)) {
        headingLevel = Number(name[1]);
        headingStart = text.length;
      }
    },
    onText(t) {
      if (skip.length) return;
      // Collapse runs of whitespace but keep a single separator: markup uses
      // newlines for source formatting, not for meaning.
      const chunk = t.replace(/\s+/g, " ");
      if (!chunk) return;
      if (chunk === " " && atBlockEdge()) return;
      text += chunk;
    },
    onClose(name) {
      if (NON_PROSE.has(name)) {
        const i = skip.lastIndexOf(name);
        if (i !== -1) skip.splice(i, 1);
        return;
      }
      if (skip.length) return;
      if (HEADING.has(name) && headingLevel !== null) {
        headings.push({
          level: headingLevel,
          title: text.slice(headingStart).replace(/\s+/g, " ").trim(),
          offset: headingStart,
        });
        headingLevel = null;
      }
      if (BLOCK.has(name)) breakLine();
    },
  });

  text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
  return { href, text, media, headings, anchors };
}

/**
 * Reconciliation: every prose text node in the source must appear in the output.
 *
 * This is the check that makes EPUB canonical. It cannot prove ordering — only
 * fixtures with known-correct output do that — but it proves nothing was
 * *dropped*, which is the failure that reports as coverage. The excluded set is
 * `NON_PROSE`, shared with extraction so the two cannot drift apart.
 */
export function reconcile(xhtml, extractedText) {
  const haystack = extractedText.replace(/\s+/g, " ");
  const missing = [];
  const skip = [];
  let index = 0;

  walk(xhtml, {
    onOpen(name) {
      if (NON_PROSE.has(name)) skip.push(name);
    },
    onClose(name) {
      if (NON_PROSE.has(name)) {
        const i = skip.lastIndexOf(name);
        if (i !== -1) skip.splice(i, 1);
      }
    },
    onText(t, at) {
      if (skip.length) return;
      const needle = t.replace(/\s+/g, " ").trim();
      if (!needle) return;
      // Search forward only. A node found earlier than the previous one is out
      // of order, which reconciliation reports as a miss rather than passing.
      const found = haystack.indexOf(needle, index);
      if (found === -1) {
        missing.push({ at, text: needle.slice(0, 80) });
      } else {
        index = found + needle.length;
      }
    },
  });

  return missing;
}

// ---------------------------------------------------------------------------
// Adapter surface
// ---------------------------------------------------------------------------

/**
 * The extractor-adapter shape: one segment per spine document, in reading
 * order. A segment is the EPUB analogue of a page — ordered, addressable and
 * digest-bearing — so everything downstream keeps working unchanged.
 */
export function extractEpub(buffer) {
  const book = openEpub(buffer);
  const toc = readToc(book);
  const pages = [];

  book.spine.forEach((item, idx) => {
    const xhtml = book.read(item.path).toString("utf8");
    let doc;
    try {
      doc = extractDocument(xhtml, item.path);
    } catch (e) {
      pages.push({ page: idx + 1, text: null, error: `extraction failed: ${e.message}`, href: item.path });
      return;
    }
    const missing = reconcile(xhtml, doc.text);
    if (missing.length) {
      pages.push({
        page: idx + 1,
        text: null,
        href: item.path,
        error:
          `reconciliation failed: ${missing.length} text node(s) in the source did not ` +
          `reach the output, first at offset ${missing[0].at} (${JSON.stringify(missing[0].text)})`,
      });
      return;
    }
    pages.push({
      page: idx + 1,
      text: doc.text,
      error: null,
      href: item.path,
      spine_index: idx,
      linear: item.linear,
      media: doc.media,
      headings: doc.headings,
      anchors: doc.anchors,
    });
  });

  return { id: `epub-builtin@${EXTRACTOR_VERSION}`, pages, book, toc };
}

/**
 * Resources declared in the manifest but referenced by nothing in the spine.
 *
 * Reported rather than ignored: an unused chapter file usually means the spine
 * is wrong, and that is a hole in the denominator nobody would otherwise see.
 */
export function unreferencedResources(book, pages) {
  const used = new Set(book.spine.map((s) => s.path));
  for (const p of pages) {
    for (const m of p.media || []) {
      if (m.src) {
        const r = resolveHref(p.href, m.src);
        if (r) used.add(r);
      }
    }
  }
  const nav = [...book.items.values()].find((i) => i.properties.includes("nav"));
  if (nav) used.add(nav.path);
  if (book.tocId && book.items.get(book.tocId)) used.add(book.items.get(book.tocId).path);

  return [...book.items.values()]
    .filter((i) => i.path && !used.has(i.path) && !/^(image|audio|video|font|application\/(x-)?font)/i.test(i.mediaType))
    .map((i) => ({ id: i.id, path: i.path, mediaType: i.mediaType }));
}

export { resolveHref };
