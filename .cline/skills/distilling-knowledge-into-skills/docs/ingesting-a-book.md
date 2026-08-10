# Ingesting a book

The biggest risk here is counter-intuitive. **A failed conversion is loud and
harmless. A conversion that succeeds and is wrong reports as coverage.** Half a
book silently missing looks exactly like half a book that had nothing in it.

So this tier does not implement conversion. It drives a declared external
extractor, records exactly which one and what it returned, and enforces the
invariants that make a silent loss impossible to mistake for an empty page.

Bundling a PDF parser would mean npm dependencies, and a skill directory copied
into `~/.cline/skills/` never gets an `npm install`. A missing tool is reported;
nothing is installed on your behalf.

```bash
node scripts/ingest.mjs --source book.pdf --slug my-book
node scripts/ingest.mjs --source notes.md --slug my-book --extractor text
```

Requires `pdftotext` and `pdfinfo` (poppler-utils) for PDFs.

## The chain

```
claim → excerpt_hash → chunk → page → converted document → original file sha256
```

Every link is verifiable offline by anyone holding the original. The original
is copied to `sources/original/`, digested before anything reads it, and never
modified.

## The gates, and why each exists

**Page-count reconciliation.** Pages converted must equal pages in the
original. The count is the denominator every coverage number is measured
against; without it "fully extracted" cannot mean anything.

**Low-yield detection.** A page returning almost nothing while its neighbours
return thousands of characters is a conversion failure, not an empty page.
Flagged `conversion-suspect`, and extraction from it is refused.

**Nothing is skipped silently.** A page with no declared `kind` blocks
chunking. A page carrying image content must have either an OCR record or a gap
— because a skipped page reports as covered, which is the whole failure.

**OCR is a tier, not a transcription.** An OCR'd page records its engine and a
confidence. OCR is a guess, and a guess whose uncertainty is not recorded reads
as fact downstream — the same reasoning that keeps `origin: model` in its own
confidence-capped tier.

## Declaring what a flagged page actually is

Only a human can settle "is this blank, a scan, or did the converter drop it?"
So the declaration is recorded as data rather than inferred:

```bash
node scripts/ingest.mjs --slug my-book --declare blank:41
node scripts/ingest.mjs --slug my-book --declare image:88 --ocr tesseract --ocr-confidence 0.82
node scripts/ingest.mjs --slug my-book --declare gap:88 \
  --reason "figure carries the content; no OCR available"
```

A gap declaration requires a reason. A gap that does not say what is missing is
indistinguishable from a page nobody looked at.

## Chunking

```bash
node scripts/chunk.mjs --slug my-book --target-chars 6000
```

Sized so one probe round yields 10-40 claims. Chapter grain put 110 claims in
one unit in the previous run and hid everything behind a single status flag;
too fine buys bookkeeping and no recall.

Boundaries prefer a paragraph break, because a chunk ending mid-sentence
produces claims whose evidence span is a fragment, and a fragment cannot be
checked against the source by eye.

**The tiling invariant:** chunks cover the document exactly once, with any
overlap declared. Without it, coverage is measured against a denominator that
silently omits whatever never became a chunk — and that region reports as
covered rather than as missing.
