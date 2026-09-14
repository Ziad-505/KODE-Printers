# ADR-014 — No `floor` column on printers

**Status:** accepted · **Date:** at schema design

## Context

§B4 specifies `printers.floor`. Every KODE building is single-storey.

## Decision

The column is not created. `printers.area` holds free text — "Reception",
"Back office", "Pro shop" — and `zones` groups printers for reporting.

## Consequences

A column of guaranteed NULLs is worse than no column: it appears in every
`SELECT *`, it invites a report grouped by it, and the report is empty. `area`
holds what people actually say when asked where a printer is, which is the
question the field exists to answer.

If the club ever occupies a multi-storey building, adding `floor` is a
non-destructive migration. Removing a column that a report already groups by is
not.

## Rejected

_Create it and leave it null._ Faithful to the document, useless in the estate
it describes.
