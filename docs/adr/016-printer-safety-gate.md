# ADR-016 — A printer-safety gate

**Status:** accepted · **Date:** during pipeline implementation

## Context

"Safe for printers" is a requirement the club stated and the source document
does not cover. The failure modes are concrete, cheap to prevent and expensive
to clean up:

- A 4,000-page job submitted by accident empties a tray, a cartridge and an
  afternoon.
- A job fired at a jammed device is not queued at the device — many MFPs discard
  it when the jam clears, so the user waits for output that never appears.
- A device failing every send gets hammered by the retry loop, which is how a
  printer mid-firmware-update ends up bricked.
- Concurrent jobs to one engine interleave on some models, producing two half
  documents.

## Decision

One module, `services/transport/safety.ts`, with two entry points:

- `checkSubmission` — runs in the request, on facts that do not need the device:
  active, not draining, not collector-served, under the impression ceiling, and
  a confirmation step above the warning threshold.
- `checkDispatch` — runs in the worker immediately before the send, on live
  device state: blocking state reasons, and the circuit breaker.

Plus per-printer concurrency and a cooldown, both enforced in the dequeue query
rather than after it, so a job that cannot run keeps its place instead of
burning an attempt.

## Consequences

The split is the substance. Device state at submission is stale by the time a
job dequeues, so checking only at submission fires jobs at printers that jammed
in between; checking only at dispatch means a 4,000-page mistake is discovered
after the file was accepted and converted.

A dispatch refusal is **retryable** and a submission refusal generally is not.
That distinction is what makes "someone is refilling the paper" a delay rather
than a failure.

Every check returns a reason, not a boolean, and the reason is rendered into a
sentence: "the paper tray is empty", not `media-empty`. The raw keyword is kept
in the audit record.

## Rejected

_Rely on the device to refuse._ Over RAW there is no feedback channel at all, so
"the device will handle it" means "nobody will know".

_A global page cap only._ The estate is not uniform: the A3 device in the academy
office legitimately runs 500-page tournament draws; the reception printer never
should. Hence the per-printer override.
