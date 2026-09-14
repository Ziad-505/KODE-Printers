# Architecture decision records

One file per decision that a future reader would otherwise have to reverse
engineer from the code. Each states the decision, what it costs, and what was
rejected — a record with no rejected option is a description, not a decision.

The numbering continues KODE-TECH-0005's own sequence. ADRs 001–012 are recorded
in that document; the ones below are this build's departures from it, referenced
from the table in the README.

| #                                    | Decision                                         | Status                       |
| ------------------------------------ | ------------------------------------------------ | ---------------------------- |
| [013](013-typescript-throughout.md)  | Full TypeScript rather than incremental adoption | Accepted, supersedes ADR-003 |
| [014](014-no-floor-column.md)        | No `printers.floor`; `area` instead              | Accepted                     |
| [015](015-pjl-injection-guard.md)    | PJL injection guard on the RAW path              | Accepted                     |
| [016](016-printer-safety-gate.md)    | A printer-safety gate                            | Accepted                     |
| [017](017-scan-hub-and-walkup-ui.md) | Scan hub, QR walk-up, templates, zones UI        | Accepted                     |
