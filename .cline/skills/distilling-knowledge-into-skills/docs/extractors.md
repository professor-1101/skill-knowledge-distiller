# Extractors — the adapter contract

EPUB is the only supported format, and [epub.md](epub.md) says why. This file
is about the layer above that: how an extractor is qualified, pinned and
recorded, so "extraction quality" is a measured property rather than an
assumption about the machine.

## The defect this exists to close

Extractor output is an input to every hash in the store. A different version
re-wraps a line, so `char_count` changes, so chunk offsets shift, so every
`excerpt_hash` computed against that text stops resolving. Nothing would
notice. Two people ingesting the same book on different machines would build
stores that both pass every gate and whose evidence chains disagree —
provenance scoped to one machine, with nothing saying so.

## Three mechanisms

**A built-in extractor that refuses rather than degrades.** `lib/epub.mjs`,
zero dependencies, `node:zlib` for the archive. Encrypted books, missing spine
documents, dangling idrefs and corrupt entries each produce a refusal. Text
recovered from a book the extractor does not fully understand looks like text
and is not.

**Conformance, so quality is measured.** `extractor-check.mjs` runs twelve
fixtures with known-correct text and records the score in the store beside the
segments it produced. Six of the twelve test **refusal**, weighted equally: an
extractor that returns plausible text for a DRM-protected book fails, because
scoring only "did output appear" would reward exactly the wrong behaviour. The
suite is itself fingerprinted, since a fixture edited unnoticed moves the bar
everything is measured against.

**A pinned extraction profile.** `source.json` records the original's digest,
the extractor id including version, the conformance score, and a
`manifest_sha256` over every segment's digest. A re-ingest that changes the
text is refused rather than absorbed:

```
RE-INGEST CHANGED THE TEXT
  was  epub-builtin@1.0.0  d2ec89035be0379e
  now  other@0.1           cef7a0043181d09b
```

## No cross-check, and why that is not a gap

The PDF pipeline ran a second extractor and compared, because nothing else
could tell whether a page had been read correctly. EPUB has something better:
the source markup itself. Reconciliation asserts every prose text node reached
the output, which is a stronger claim than two tools agreeing and needs nothing
installed.

It proves no text was *lost*. It does not prove ordering is *right* — that is
covered by fixtures with known-correct output, which is the honest division of
labour between the two.

## Configuration

```json
{
  "extractors": {
    "primary": "epub-builtin",
    "custom": {
      "name": "my-reader",
      "id": "my-reader@2.1",
      "command": "python3 tools/extract.py {{FILE}}"
    }
  },
  "enumerate": { "depth": 2 },
  "chunk": { "target_chars": 6000, "overlap": 0 },
  "saturation": { "ratio": 0.05 }
}
```

A project may qualify its own extractor in any language — it faces the same
twelve fixtures and gets the same provenance guarantees. The command receives
the file path and prints one JSON object:

```json
{ "id": "py-mupdf@1.24.9",
  "pages": [{ "page": 1, "text": "…", "error": null }] }
```

`error` with `text: null` is how an external extractor refuses, and the
pipeline treats that exactly as it treats the built-in refusing.

## How the requirements are met

| Requirement | Mechanism |
|---|---|
| Reliable, reproducible extraction | Reconciliation against the source markup; conformance suite; pinned extractor id; `manifest_sha256`; drift refuses to pass silently |
| Incremental and resumable | Ingestion is per document and re-entrant; page files and profile are on disk; chunk and checkpoint state unchanged |
| Page boundaries and provenance | Per-page files, digests and offsets; the chain runs claim → chunk → page → converted doc → original digest |
| Other extractors still possible | Any command qualifies via the custom contract, in any language |
| Portable, nothing to install | The built-in needs only Node, which Cline guarantees; external tools are reported when missing, never installed |
| Same gates regardless of extractor | Every adapter returns the same shape and faces the same reconciliation, fidelity, tiling and declaration gates |

## Known limits of the built-in extractor

Stated plainly, because an extractor whose limits are undocumented is one whose
output you cannot calibrate.

- **DRM-protected books**: refused. This is the common case for a purchased
  copy, and it is correct rather than a limitation to work around.
- **Ordering in unusual layouts**: reading order follows the spine and then
  document order within each document. Footnote asides and floated figures
  appear where the markup puts them, which is the source's own answer but not
  always the reading experience.
- **Media content**: images, audio and video are recorded and never
  transcribed. There is no OCR. A chapter that is one figure yields no prose
  and is flagged so the absence is measured.
- **`alt` text is not prose**: recorded on the media entry, never spliced into
  the text, because injecting it would put words in the store at offsets the
  source does not have.
