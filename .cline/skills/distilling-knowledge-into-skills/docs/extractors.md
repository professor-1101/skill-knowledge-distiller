# Extractors — the decision, and why it is shaped this way

Status: accepted. Supersedes the first ingestion design, which drove an
unspecified external tool and recorded only its name.

## The problem that was actually there

The first design shelled out to `pdftotext` and wrote down that it had. That
looked adequate and was not, for a reason worse than "quality varies by tool":

**Extractor output is an input to every hash in the store.** A different
poppler version re-wraps a line, so `char_count` changes, so chunk offsets
shift, so every `excerpt_hash` computed against that text stops resolving.
Nothing in the pipeline would have noticed. Two people ingesting the same book
on different machines would build stores that both pass every gate and whose
evidence chains disagree — provenance scoped to one machine, with nothing
saying so.

That is the same class of failure the whole design exists to prevent, one level
up from where it was being watched: **a clean-looking wrong result that reports
as correct.**

## What was rejected, and why

### Rejected: depend on one external tool, well documented

Documenting "install poppler" does not pin a version, does not survive a distro
upgrade, and leaves the pipeline unable to run at all where the tool is absent.
The environment this skill was built in has no PDF tooling whatsoever, which is
not an exotic case — it is a container.

### Rejected: a bundled Python reference extractor

This was the suggested fix, and the diagnosis behind it was right. The remedy
is not, for two reasons that only became clear when the constraints were laid
against each other.

**Python is not guaranteed where this runs; Node is.** Cline ships as an npm
package, so Node ≥18 is present on any machine running it. Python is a separate
bet. Making the *reference* path — the one that exists precisely so there is
always a known-good option — depend on the less certain runtime inverts the
point.

**The Python ecosystem advantage does not survive contact with the constraint.**
`pypdf` and PyMuPDF are what make Python attractive here, and neither can be
used: a skill directory copied into `~/.cline/skills/` gets no `pip install`
any more than it gets an `npm install`. A stdlib-only Python extractor and a
stdlib-only Node extractor are the same amount of work against the same PDF
specification, and only one of them is guaranteed to have a runtime.

So Python remains fully supported — as an external extractor with a documented
adapter contract, on equal footing with poppler and MuPDF. It is not the
reference.

### Rejected: one canonical extractor, and trust it

The deeper correction. A single reference extractor makes output *uniform*, not
*reproducible* — and uniform-but-wrong is exactly what we are guarding against.
It would also be a lie by omission: a hand-written parser will lose to poppler
on hard documents, and blessing it as canonical would push people toward worse
text for the sake of consistency.

## The decision

Four mechanisms, none of which is "trust the tool".

### 1. A built-in extractor that refuses rather than degrades

`lib/pdf.mjs`. Zero dependencies, `node:zlib` for FlateDecode. Handles classic
xref tables, cross-reference streams, object streams, Flate/ASCIIHex/ASCII85
filters, the page tree, content-stream text operators, WinAnsi and `Differences`
encodings, and ToUnicode CMaps.

Its defining property is what it does at the edge. An encrypted document, a
filter it does not implement, a composite font with no ToUnicode map — each
produces a **refusal for that page**, never partial text and never mojibake.
Degraded text that looks like text is the failure the ingestion tier exists to
catch, so an extractor that emits it is worse than one that stops.

It is not claimed to beat poppler on hard documents. It is the always-available
baseline, and the independent second opinion.

### 2. Conformance, so quality is measured rather than assumed

```bash
node scripts/extractor-check.mjs --record
```

Seven fixtures with known-correct text, generated deterministically from source
so every byte is auditable. Any extractor faces the same suite and gets the
same score, which is recorded in the store beside the pages it produced.

Two fixtures test **refusal**, and they carry as much weight as the rest. An
extractor that returns plausible text for an encrypted file, or for a font
whose bytes cannot be mapped, fails — scoring only "did it produce output"
would reward precisely the wrong behaviour.

The suite itself is fingerprinted, because a fixture edited unnoticed moves the
bar everything is measured against.

### 3. A pinned extraction profile

`sources/converted/<doc>/source.json` records the original's digest, the
extractor **id including its version and flags**, the conformance score, and a
`manifest_sha256` over every page's character count and text digest.

Re-ingesting with a different extractor or version produces a different
manifest hash, and ingestion says so loudly:

```
RE-INGEST CHANGED THE TEXT
  was  builtin@1.0.0  d2ec89035be0379e
  now  py-naive@0.1   cef7a0043181d09b

Every excerpt_hash in the store was computed against the old text, so those
evidence chains no longer resolve.
```

That single check is what closes the original defect.

### 4. Cross-check — an adversary for the ingestion tier

Where a second independent extractor is available, both run and their per-page
text is compared on word overlap, which is robust to the layout differences
that distinguish extractors without changing what a page says. Pages below the
threshold are flagged `extraction-disagreement`, and one extractor refusing
while the other produces text is flagged hardest — that usually means the
confident one is guessing.

Two independent extractors agreeing is real evidence the conversion is right.
This is the principle the rest of the pipeline already runs on — every producer
has an adversary — applied to the one stage that did not have one.

## Configuration

```json
{
  "extractors": {
    "primary": "builtin",
    "cross_check": "pdftotext",
    "cross_check_threshold": 0.75,
    "custom": {
      "name": "py-mupdf",
      "id": "py-mupdf@1.24.9",
      "command": "python3 tools/extract.py {{FILE}}"
    }
  }
}
```

`cross_check` may be `false` to disable, a named extractor, or omitted to use
whatever second one is available. A custom command receives the file path and
prints one JSON object:

```json
{ "id": "py-mupdf@1.24.9",
  "pages": [{ "page": 1, "text": "…", "error": null }] }
```

`error` with `text: null` is how an external extractor refuses, and the
pipeline treats that exactly as it treats the built-in refusing.

## How the requirements are met

| Requirement | Mechanism |
|---|---|
| Reliable, reproducible extraction | Conformance suite; pinned extractor id; `manifest_sha256`; drift refuses to pass silently |
| Incremental and resumable | Ingestion is per document and re-entrant; page files and profile are on disk; chunk and checkpoint state unchanged |
| Page boundaries and provenance | Per-page files, digests and offsets; the chain runs claim → chunk → page → converted doc → original digest |
| External extractors still possible | poppler and MuPDF adapters ship; any command qualifies via the custom contract, Python included |
| Portable, nothing to install | The built-in needs only Node, which Cline guarantees; external tools are reported when missing, never installed |
| Same gates regardless of extractor | Every adapter returns the same shape and faces the same reconciliation, fidelity, tiling and declaration gates |

## Known limits of the built-in extractor

Stated plainly, because an extractor whose limits are undocumented is one whose
output you cannot calibrate.

- **Encrypted documents**: refused. Decrypt first.
- **Scanned pages**: no OCR. They arrive as image pages and need a declaration.
- **Composite fonts without ToUnicode**: refused per page. Poppler does better
  here, using embedded font programs — a good reason to configure it as primary
  where it is available.
- **LZW, DCT, CCITT, JBIG2 streams**: refused rather than guessed.
- **Layout fidelity**: reading order follows the content stream with newline
  and space heuristics from text-positioning operators. Multi-column layouts
  and complex tables will read worse than poppler's `-layout`.

Where the built-in refuses and a qualified external extractor succeeds, use the
external one. The point of this design is not that the built-in is best — it is
that whichever you use is *named, scored, pinned, and checked against a second
opinion*.
