# ADR-015 — PJL injection guard on the RAW path

**Status:** accepted · **Date:** during transport implementation

## Context

RAW/9100 is a TCP socket the device parses. Anything written to it is
interpreted, and PJL directives inside a _document_ are indistinguishable from
PJL the server wrote. A plain-text file whose own content is

```
<ESC>%-12345X@PJL DEFAULT PASSWORD=0
@PJL SET HOLD=ON
```

resets the device's administrator password and takes it offline. Any user
permitted to print a `.txt` can do this. Nothing in the source document
addresses it.

## Decision

Two layers, because either alone has a hole.

1. `guardRawContent()` refuses content bound for port 9100 unless it can prove
   the bytes are a wrapped document — a PDF that begins `%PDF-`, or PostScript
   that begins `%!`. Anything else is scanned for PJL and refused if found.
2. The pipeline converts text to PDF before dispatch, so the dangerous payload
   does not reach the transport in the first place.

## Consequences

The guard tests the **bytes**, not the declared content type. An earlier version
asked whether the type was `text/*`; the pipeline sets its content type to what
it intends to produce, which is `application/pdf` from the first line of the job
onward, so the guard never ran on a real job. It passed its own unit tests and
protected nothing. Verifying the claim against the magic bytes closes that
structurally.

Text is refused rather than stripped. Silently removing lines produces a print
that differs from what was submitted, which is worse than a clear refusal.

A legitimate document that merely _mentions_ `@PJL` in its text is not affected:
by then it is a PDF, and the guard passes anything it can prove is wrapped.

## Rejected

_Trust the pipeline to always convert._ It does today. The guard is what makes
that a property rather than a habit, and the one path that could regress —
a conversion falling back to its input — is exactly the path that kept the PDF
label all the way to the socket.
