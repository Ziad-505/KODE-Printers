# ADR-013 — TypeScript throughout

**Status:** accepted, supersedes ADR-003 · **Date:** at project start

## Context

ADR-003 in KODE-TECH-0005 recommends adopting TypeScript incrementally, keeping
the delivered JavaScript working while types are added around it. That is sound
advice for a codebase in production.

This is not one. There is no working JavaScript to preserve.

## Decision

TypeScript everywhere, `strict` plus `exactOptionalPropertyTypes` and
`noUncheckedIndexedAccess`, with no `allowJs` escape hatch.

## Consequences

The strict flags are the point rather than decoration. `noUncheckedIndexedAccess`
is what forces `rows[0]` to be checked before use, which is the single most
common source of runtime `undefined` in a database layer.

The cost is real: `exactOptionalPropertyTypes` makes `{ ...defaults, ...partial }`
a type error whenever the partial can carry an explicit `undefined`, which is
why `compact()` exists in the template route. That is a fair trade for a
guarantee that an optional field is either absent or a value, never a silent
`undefined` overwriting a default.

## Rejected

_Incremental adoption._ It buys safety for existing behaviour. With no existing
behaviour it buys a second build path and a permanent boundary where types stop.
