# Ingesting a book

EPUB is the only supported input. The reasoning, and what the extractor
refuses, is in [epub.md](epub.md); this file is the operational side.

The risk being managed is counter-intuitive. **A failed conversion is loud and
harmless. One that succeeds and is wrong reports as coverage.** A silently
truncated book looks exactly like a thin one.

Four mechanisms answer that, and none of them is "trust the tool":

1. **Reconciliation.** Every prose text node in the source must reach the
   output. A node that did not is a refusal at ingest, naming the offset and
   the text. This is what a format with real markup makes possible.
2. **Conformance scoring**, so extraction quality is measured rather than
   assumed — twelve fixtures, six of them refusals.
3. **A pinned extraction profile**, because an extractor's *version* changes
   its text and changed text breaks every `excerpt_hash` computed against it.
4. **Derivation over declaration.** A segment's kind, its title, its headings
   and its media come from the markup. The only thing a person declares is a
   gap, and only because "these figures carry the content" is a judgement.

```bash
node scripts/extractor-check.mjs --record            # qualify what you will use
node scripts/ingest.mjs --source book.epub --slug my-book
node scripts/enumerate.mjs --slug my-book            # the denominator, transcribed
node scripts/chunk.mjs --slug my-book                # tiled, unit-linked
```

## The chain

```
claim → excerpt_hash → chunk → page → converted document → original file sha256
```

Every link is verifiable offline by anyone holding the original. The original
is copied to `sources/original/`, digested before anything reads it, and never
modified.

## The gates, and why each exists

**Reconciliation.** Every prose text node reached the output, or the segment is
refused. Exact, not size-relative — which matters because segment sizes vary
enormously and legitimately.

**A refusal must still be declared.** An extractor refusing is the honest
outcome, but an undeclared refusal is still a segment nobody accounted for.
Flagged `extraction-refused` until someone says what it is.

**An image-only segment is flagged, not assumed empty.** Whatever those figures
say is not in the store. That is a fact about the book, and it has to be
visible rather than counted as covered.

**A segment with neither prose nor media is flagged.** Usually real front
matter; never something to assume.

**`kind` must be derived.** A row with none was written by something other than
ingest, which means it is not describing what the markup says.

**Re-ingest that changes the text is refused, not warned about.** The manifest
fingerprint covers every segment digest, so swapping extractor or version is
detected — and every `excerpt_hash` in the store was computed against the old
text.

## The one thing a human still declares

```bash
node scripts/ingest.mjs --slug my-book --declare gap:12 \
  --reason "the figure carries the content and there is no text alternative"
```

A reason is required. A gap that does not say what is missing is
indistinguishable from a segment nobody looked at.

Every other segment property is derived from the markup and is not yours to
set — the PDF-era flow of declaring pages blank, image or OCR'd is gone with
the format that needed it.

## Chunking

```bash
node scripts/chunk.mjs --slug my-book --target-chars 6000
```

Sized so one probe round yields 10-40 claims. Chapter grain put 110 claims in
one unit in the previous run and hid everything behind a single status flag;
too fine buys bookkeeping and no recall.

Boundaries prefer a heading, then a paragraph break. Chunk ids are structural —
`slug/s003/k000`, spine index then ordinal — so inserting a chapter elsewhere
does not renumber them and orphan the claims that referenced them.

**Tiling and linkage:** every chunk resolves to the unit whose TOC entry covers
its start offset, and chunks cover the document exactly once, with any
overlap declared. Without it, coverage is measured against a denominator that
silently omits whatever never became a chunk — and that region reports as
covered rather than as missing.
