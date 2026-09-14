# ADR-017 — Scan hub, QR walk-up, templates and zones UI

**Status:** accepted · **Date:** at scoping

## Context

DEC-08 scopes KODE-TECH-0005 to the backend. §B9 specifies scan _detection_ —
observe a folder, log what arrives — and stops there. Zones are named as a gap
(GAP-14) with no model behind them.

Detection alone produces a table nobody opens.

## Decision

Four additions, each turning an existing backend capability into something staff
use:

1. **Scan hub** — an inbox with in-browser preview, claim, and a scan-to-me
   reservation that files the next scan from a device to the person who reserved
   it.
2. **QR stickers** — one per printer, opening the print page with that printer
   selected.
3. **Templates** — the documents the club prints constantly, uploaded once with
   the right settings.
4. **Zones** — a first-class table, so reports break out by area and the printer
   picker groups by somewhere a person recognises.

## Consequences

Each is deliberately thin over what the backend already does. A template print
goes through the ordinary submission path, so the safety gate, the ledger entry
and the audit row all still happen — a second path that skipped them is exactly
where those guarantees would quietly stop holding.

Scan-to-me is the only one that adds a rule: one live reservation per printer,
enforced by a partial unique index. A folder drop carries no identity, so a
second concurrent claimant cannot be disambiguated and is refused rather than
guessed at. A wrong guess files a member's scanned ID into a stranger's inbox.

The QR sticker removes the step people actually get wrong — picking the right
device from a list of fifty while standing in front of the one they want.

## Rejected

_Trigger scans remotely._ No cross-vendor protocol exists to start a scan from
the network. The system observes; it does not initiate, and saying so plainly
beats a button that works on one vendor.

_Per-user scan folders._ It would give true identity-aware scanning, and it
needs per-user configuration on every device. Reservations get most of the
benefit with none of the device administration.
