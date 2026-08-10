// xml.mjs — a tokenizer for the XHTML and XML an EPUB is made of.
//
// Not a general XML parser and not trying to be. It emits a flat event stream —
// open, close, text — which is all three consumers need: the OPF and nav
// readers walk it for structure, and the text extractor walks it for prose.
//
// One consumer matters more than the others. Text-node reconciliation compares
// what the tokenizer saw against what extraction emitted, so this file is the
// shared reference point for "what is actually in the document". It therefore
// errs toward reporting text it is unsure about rather than dropping it: a
// missed text node here becomes invisible everywhere downstream.

export class XmlError extends Error {}

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", bull: "•", middot: "·", times: "×",
  eacute: "é", egrave: "è", agrave: "à", ccedil: "ç", uuml: "ü",
  ouml: "ö", auml: "ä", szlig: "ß", copy: "©", reg: "®", trade: "™",
  deg: "°", plusmn: "±", frac12: "½", laquo: "«", raquo: "»", shy: "­",
};

export function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    const named = NAMED_ENTITIES[body];
    // An unknown entity is left verbatim rather than dropped. It will show up
    // in the text as `&foo;`, which is visible and fixable; silently removing
    // it would be a loss nobody could see.
    return named === undefined ? m : named;
  });
}

const VOID = new Set(["br", "img", "hr", "meta", "link", "input", "area", "base", "col", "source"]);

function parseAttrs(raw) {
  const attrs = {};
  const re = /([:A-Za-z_][-.:\w]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(raw))) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? "");
  }
  return attrs;
}

/**
 * Walk a document, calling handlers as it goes.
 *
 * `onText` receives decoded text and the byte-ish offset it started at, so a
 * caller can map extracted prose back to a position in the source markup.
 */
export function walk(xml, { onOpen, onClose, onText } = {}) {
  const s = String(xml);
  let i = 0;
  const stack = [];

  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt === -1) {
      emitText(s.slice(i), i);
      break;
    }
    if (lt > i) emitText(s.slice(i, lt), i);

    if (s.startsWith("<!--", lt)) {
      const end = s.indexOf("-->", lt + 4);
      i = end === -1 ? s.length : end + 3;
      continue;
    }
    if (s.startsWith("<![CDATA[", lt)) {
      const end = s.indexOf("]]>", lt + 9);
      const body = s.slice(lt + 9, end === -1 ? s.length : end);
      // CDATA is literal: no entity decoding, but it is still text and must be
      // accounted for, or a document that wraps its prose in CDATA loses it.
      if (onText && body) onText(body, lt + 9, stack);
      i = end === -1 ? s.length : end + 3;
      continue;
    }
    if (s.startsWith("<!", lt) || s.startsWith("<?", lt)) {
      const end = s.indexOf(">", lt);
      i = end === -1 ? s.length : end + 1;
      continue;
    }

    const gt = findTagEnd(s, lt);
    if (gt === -1) {
      emitText(s.slice(lt), lt);
      break;
    }
    const inner = s.slice(lt + 1, gt);

    if (inner[0] === "/") {
      const name = inner.slice(1).trim().toLowerCase();
      while (stack.length && stack[stack.length - 1] !== name) {
        // Unbalanced markup is common in the wild. Popping to the match keeps
        // the walk going rather than abandoning a readable document.
        const popped = stack.pop();
        if (onClose) onClose(popped, stack);
      }
      if (stack.length) {
        stack.pop();
        if (onClose) onClose(name, stack);
      }
      i = gt + 1;
      continue;
    }

    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const sp = body.search(/[\s/]/);
    const name = (sp === -1 ? body : body.slice(0, sp)).toLowerCase();
    const attrs = sp === -1 ? {} : parseAttrs(body.slice(sp));

    if (onOpen) onOpen(name, attrs, stack, { start: lt, end: gt + 1 });
    if (!selfClosing && !VOID.has(name)) {
      stack.push(name);
    } else if (onClose) {
      onClose(name, stack);
    }
    i = gt + 1;
  }

  while (stack.length) {
    const popped = stack.pop();
    if (onClose) onClose(popped, stack);
  }

  function emitText(chunk, at) {
    if (!onText || !chunk) return;
    onText(decodeEntities(chunk), at, stack);
  }
}

// A `>` inside a quoted attribute value does not end the tag.
function findTagEnd(s, lt) {
  let quote = null;
  for (let i = lt + 1; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i;
    }
  }
  return -1;
}

/** Every element of a given name, with its attributes, in document order. */
export function findAll(xml, tagName) {
  const want = tagName.toLowerCase();
  const out = [];
  walk(xml, {
    onOpen(name, attrs) {
      if (name === want || name.endsWith(":" + want)) out.push(attrs);
    },
  });
  return out;
}

/** The concatenated text of the first element matching `tagName`. */
export function textOf(xml, tagName) {
  const want = tagName.toLowerCase();
  let depth = 0;
  let found = false;
  let out = "";
  walk(xml, {
    onOpen(name) {
      if (!found && (name === want || name.endsWith(":" + want))) {
        found = true;
        depth = 0;
      } else if (found) depth++;
    },
    onClose(name) {
      if (found && depth === 0 && (name === want || name.endsWith(":" + want))) found = "done";
      else if (found === true) depth--;
    },
    onText(t) {
      if (found === true) out += t;
    },
  });
  return out.trim();
}
