# EPUB, and why it is the only supported input

## The decision

A PDF states no reading order, no headings and no table of contents. All three
have to be inferred from where text sits on a page, and every inference is a
place where a wrong-but-plausible result enters the store. The pipeline used to
carry a PDF path, and with it a whole mechanism of human page declarations to
compensate — and even then it could not tell a blank page from a dropped one.
Its best available signal was "this page looks thin next to its neighbours".

An EPUB states all three, in markup we can hold in memory and check against.
That changes what is *provable*, not merely what is convenient:

**Extraction can be verified instead of estimated.** `reconcile()` walks the
source document, collects every prose text node, and asserts each one reached
the output. A node that did not is a refusal at ingest, naming the offset and
the text. There is no PDF equivalent and there cannot be.

Everything else follows from that one difference:

| | EPUB | PDF |
|---|---|---|
| Reading order | `spine`, explicit | inferred from text positions |
| Table of contents | nav or NCX, machine-readable | absent or inferred |
| Headings | real elements | inferred from font size |
| Fidelity check | exact, text-node reconciliation | heuristic, size-relative |
| Unit enumeration | transcribed mechanically | authored by a person or a model |
| Chunk → unit | derived from href and offset | guessed from page ranges |

So the manual declaration flow is gone, the median low-yield heuristic is gone,
and the cross-check against a second extractor is gone with the format that
needed it. The ingestion stage still has an adversary; it is the source markup
rather than a second tool, which is stronger and needs nothing installed.

## What a segment is

One spine document. Ordered, addressable, and carrying its own digest — the
same contract a page had, which is why the store keeps the `pages.jsonl`
vocabulary and every existing gate keeps working. Rows record
`locator_scheme: "epub-spine"`, the `href`, the spine index, the nav title,
headings, anchors and media.

Sizes vary enormously and legitimately: a title page of 90 characters sits
beside a chapter of 40,000. Nothing size-relative is allowed to be a defect
signal for that reason.

## What it refuses

Refusing is the posture throughout. Text recovered from a book the extractor
does not fully understand looks like text and is not.

| Condition | Why refusing is right |
|---|---|
| `META-INF/encryption.xml` present | The book is DRM-protected. Whatever came out would be bytes we cannot attribute to it. |
| A spine document missing from the archive | Extracting the rest reports a book with a hole in it as complete. |
| A spine `idref` with no manifest entry | The reading order is incomplete, so it cannot serve as a denominator. |
| A spine item that is not a content document | Its bytes are not prose. |
| An empty spine | The book has no reading order to follow. |
| A CRC mismatch, or a damaged deflate stream | The archive's own index says these bytes are wrong. |
| No `mimetype` declaring `application/epub+zip` | Not an EPUB, and there is no fallback format. |

**DRM is the common case for a purchased book.** That refusal will be the first
thing most people hit, and it is correct rather than a limitation to work
around. Supply a DRM-free copy.

## What it reads

- **Package** — `container.xml` → OPF: manifest, spine (including
  `linear="no"`, which is kept and marked rather than dropped), metadata.
- **Navigation** — EPUB 3 `nav` first, EPUB 2 `.ncx` as the fallback, both
  nested to arbitrary depth, both keeping fragment targets so a unit can start
  inside a document.
- **Content** — block versus inline boundaries, headings with their level and
  offset, anchors, entities (named, decimal and hex), CDATA, tables, nested
  lists, MathML and SVG text.
- **Media** — images, audio and video are recorded with their offset. An
  image-only chapter therefore has zero prose and a media record, which is a
  fact about the book rather than a defect.

Two deliberate exclusions, both tested:

**`<script>` and `<style>` contents never reach the text**, even when they read
as prose. A fixture puts a full sentence inside each precisely so a naive
tag-stripper fails.

**`alt` text is recorded on the media entry and not spliced into the prose.**
It is metadata about a figure, not body text, and injecting it would put words
into the store at offsets the source does not have.

## Enumeration — where R5 stops being aspirational

The nav document states the units and their order, so
`node scripts/enumerate.mjs --slug my-book` is transcription rather than
recollection. This is what the rule always asked for and nothing previously
implemented: every script read `corpus.jsonl` and none wrote it.

Unit grain defaults to nav depth 2 — chapter, then section where the TOC has
one — configurable under `enumerate.depth`. Depth 2 is what puts a unit in R6's
ten-to-forty claim window for a typical technical book; depth 1 overshoots the
way chapter grain did in the previous project.

Two conditions produce gap records rather than invention:

- **No navigation at all.** Units fall back to spine grain, which is the
  source's own coarser answer, and the absence is recorded.
- **A spine document the TOC never names.** A unit is added so its text is
  counted, and a gap says the book's own structure does not cover it.

## Identifiers

`slug/s003/u01` for a unit, `slug/s003/k000` for a chunk: spine index, then
ordinal within that document. Derived from position in the source, never from a
running count across the book, and never from the title — a title changes with
a typo fix, and a positional id renumbers everything after an insertion,
orphaning every claim that referenced one.

## Qualifying another extractor

The built-in is not privileged by fiat. Any extractor faces the same twelve
fixtures with the same known-correct text:

```bash
node scripts/extractor-check.mjs --record
```

Six of those fixtures are refusals, weighted equally: an extractor that returns
plausible text for a DRM-protected book fails, because scoring only "did output
appear" would reward exactly the wrong behaviour. See
[extractors.md](extractors.md) for the adapter contract.
