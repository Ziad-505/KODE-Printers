# KODE Printer

Central print, scan and audit for KODE Sports Club. Staff upload a file in a
browser, choose a printer they are permitted to use, and the server sends it —
no drivers, no installs, on any device. Activity started at a printer's own
panel is detected and logged too, so the record covers what the club actually
did rather than only what went through the app.

Implements the target architecture in **KODE-TECH-0005 v1.0**, with the
departures recorded in [`docs/adr/`](docs/adr/).

---

## What it does

**Printing** — upload, or pick a quick-print template; page ranges, copies,
colour, duplex and paper size; a live impression count before you commit; hold
a job and release it from your phone when you are standing at the device.

**Scanning** — scans arriving from club printers land in an inbox with an
in-browser preview. Reserve a printer before you walk over and the next scan
from it is filed straight to you.

**The fleet** — live status per device including toner levels and a days-to-empty
forecast, the blocking reason in plain words ("the paper tray is empty"), and a
printable QR sticker that opens the print page with that printer selected.

**The record** — every job, every walk-up event, every administrative change.
Keyset-paginated history, streaming CSV export, cost and CO₂e reporting, and an
append-only audit log the database itself refuses to rewrite.

---

## Quick start

```bash
cp .env.example .env
```

Fill in `POSTGRES_PASSWORD`, `JWT_SECRET` and `SECRET_KEY` — the process refuses
to boot on a placeholder or a default pair. Generate the secrets with:

```bash
openssl rand -base64 48
```

Then:

```bash
docker compose up -d --build
```

Create the first administrator. The password is printed once and the account can
do nothing until it is changed:

```bash
docker compose exec app node dist/db/seed.js
```

Open `https://printers.kodesportsclub.local`, sign in as `admin`, choose a new
password, then add your first printer by IP address — serial number, vendor,
model, IPP support and capabilities are discovered from the device.

### Giving someone an account

Nobody signs themselves up, and nobody is ever told their own first password.

On **People**, press _Create an account_, enter their name and tick the printers
they may use. A single-use link comes back; press **Copy link** and send it
however you already reach that person. They open it, choose a password nobody
else ever sees, and land signed in.

A forgotten password is the same three moves — _Make a reset link_, copy, send —
and making one signs that account out everywhere immediately. Setup links last
seven days, reset links one hour, and issuing a new one kills the old one.

No mail server is involved anywhere in this, deliberately: an SMTP dependency
that has to work before anyone can sign in is a worse failure mode than a link
that is pasted by hand.

### Development

```bash
npm install
npm run dev          # API on :3000, web on :5173
npm test             # unit suite; integration tests skip without a database
npm run test:all     # starts the throwaway test database first, then runs everything
npm run typecheck    # strict, all three packages, plus the tests
npm run lint
```

The API needs a database even in development:

```bash
docker compose up -d db
npm run migrate && npm run seed
```

`npm run dev:harness` starts the fake-printer harness, so the whole print path
is exercisable without hardware.

---

## Architecture

```
apps/
  server/     Express API, queue worker, device watchers, collector agent
  web/        React PWA (Vite), installable on phones
packages/
  shared/     types, zod schemas, error taxonomy, pure functions — one contract
tools/
  fake-printer/  scriptable IPP + RAW/9100 + SNMP device, for tests
```

Five layers on the server, and nothing reaches across a boundary: a route never
opens a socket, a service never reads `process.env`.

```
routes/      HTTP only — parse, authorise, delegate, shape
services/    all business logic
  transport/   IPP, RAW/9100, PJL, selection, the safety gate
  snmp/        counters, identity, state, supplies
  pipeline/    queue, sandboxed converters, dispatch
  watchers/    walk-up detection, scan folder, status, retention
models/      one file per table, parameterised SQL, no ORM
db/          pool, migrations
```

### The parts worth understanding

**Transport.** IPP first, RAW/9100 as fallback. The distinction that matters is
between a _transient_ IPP failure and a _protocol_ one: a printer that is merely
asleep must not be demoted to RAW, and conflating the two is the defect
§B6.2 warns about. It is modelled explicitly in `IppFailureKind` rather than
inferred from an error string.

**Walk-up attribution.** Counter deltas reconcile against a persisted ledger of
outstanding impressions, oldest job first. Reconciling against _quantity_ rather
than elapsed time is what makes a slow job attribute correctly and a genuine
walk-up during a long print still get caught. The algorithm is pure and lives in
`services/watchers/attribution.ts`, covered by every mandatory scenario in
§B17.2.

**The queue.** PostgreSQL with `FOR UPDATE SKIP LOCKED`, concurrency 2. Not for
throughput — the converters serialise anyway — but so a job survives a restart,
retries when a printer is mid-reboot, and does not die behind a browser timeout
during a 60-second conversion.

**Printer safety.** Not in the source document, and the reason it exists here:
per-job impression ceilings with a confirmation step, refusal to send to a
jammed or empty device, per-printer concurrency and cooldown, a circuit breaker,
and a **PJL injection guard** (see below).

---

## Departures from KODE-TECH-0005

Each is recorded as a superseding ADR in [`docs/adr/`](docs/adr/).

| #   | Departure                                        | Why                                                                                                                     |
| --- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| 013 | Full TypeScript rather than incremental adoption | Overrides ADR-003 at the club's request. Greenfield build, so there is no working JavaScript to preserve.               |
| 014 | No `printers.floor` column                       | Every KODE building is single-storey. `area` ("Reception", "Back office") is what helps someone find a printer.         |
| 015 | PJL injection guard on the RAW path              | A `.txt` whose content is `@PJL DEFAULT PASSWORD=0` reconfigures the device. Any user who can print text could do this. |
| 016 | Printer-safety gate                              | Impression ceilings, state gating, cooldown, circuit breaker. Not specified anywhere in the document.                   |
| 017 | Scan hub, QR walk-up, templates, zones UI        | The document scopes the backend only (DEC-08).                                                                          |

### The PJL hole, specifically

RAW/9100 is a socket the device parses. A plain-text file whose own content
contains PJL directives is not inert data — it is executable configuration:

```
<ESC>%-12345X@PJL DEFAULT PASSWORD=0
@PJL SET HOLD=ON
```

That resets the device's admin password and takes it offline. The delivered
build sends text straight through. `guardRawContent()` refuses such files, and
the pipeline additionally wraps all text into PDF before sending, which removes
the surface entirely.

---

## Operations

- **API contract** — [`docs/openapi.yaml`](docs/openapi.yaml). §B5 makes
  disagreement between it and the implemented routes a release blocker, which is
  why it lives beside the code rather than in a wiki.
- **Go-live checklist** — [`docs/RUNBOOK.md`](docs/RUNBOOK.md)
- **Backup and restore** — `scripts/backup.sh`, `scripts/restore.sh`; an
  untested backup is not a backup, so restore into a scratch database before
  go-live and quarterly after.
- **Health** — `GET /api/health` (liveness, used by the container healthcheck)
  and `GET /api/health/ready` (readiness: database, converters, disk, worker).
- **Metrics** — Prometheus at `/api/health/metrics`, bound to localhost. Point
  the club's existing Zabbix at it rather than introducing a second stack.

### Known limitations, stated rather than hidden

- A printer with SNMP disabled reports **no** walk-up activity. The fleet board
  and every report covering it carry a coverage note (§B8.5).
- Without vendor print/copy counters a photocopy is indistinguishable from a
  print. Such activity is recorded as `unknown` and labelled **device activity**,
  never "prints" (DEC-06). Changing that label without the counters would
  overstate what the club printed.
- Two walk-up jobs inside one poll cycle produce one combined entry. SNMP
  returns a single number; individual attribution is impossible from a counter.
- Scan tracking needs Scan to Network Folder configured on each device. Printers
  supporting only scan-to-USB or scan-to-email cannot be tracked at all.

---

## Testing

```bash
npm test                # unit; integration skips when no test database is up
npm run test:all        # brings the test database up, then runs everything
npm run test:coverage   # thresholds on ledger, transport, permissions
```

Integration tests need a real PostgreSQL and **skip with a clear reason** when
none is reachable, so a developer without Docker running is not blocked. They
run against a dedicated throwaway database rather than the application's own:

```bash
npm run test:db     # docker compose --profile test up -d --wait db-test
npm test
npm run test:db:stop
```

That container publishes **5434** and holds its data in tmpfs. The port matters:
a developer's own PostgreSQL usually has 5432 and the application's database
container publishes 5433, and the integration suite `TRUNCATE`s every table
between tests. A third port that belongs to nothing else is what stops a typo in
`DATABASE_URL` wiping something someone cared about.

The fake-printer harness (`tools/fake-printer`) provides an IPP responder, a
9100 listener that records the exact bytes it received, and a scriptable SNMP
agent whose page counter a test drives directly. §B17.1 calls this "the piece
most likely to be skipped and most costly to skip" — without it, nothing that
matters is testable without hardware.

It earned its keep on first run. The `ipp` library parses responses inside an
`IncomingMessage` handler, so a device that answers on 631 with an HTML login
page — a common configuration — made its parser throw a `RangeError` outside any
promise and take the process down. The transport now owns its own HTTP request
and validates the response shape before parsing, so such a device demotes
cleanly to RAW/9100 instead of crashing the server.

### Assets

The KODE mark lives as vector path data in
[`packages/shared/src/brand.ts`](packages/shared/src/brand.ts), so every surface
— the app, the favicon, the boot splash, the PWA icons — reads one definition.

It was **traced from `kodeBranding/images (3).png`**, not extracted from the
PDFs. `Logo - Black.pdf` and `Logo - White.pdf` contain only the "KODE"
wordmark: eight subpaths spelling K‑O‑D‑E plus the trademark glyph, and no mark
at all. The mark exists in the supplied assets solely as raster.

The trace is 111 points across six contours at a 1.3px tolerance on a 350px
glyph — under half a percent, which keeps the 26.5° cut straight while dropping
the bitmap's stair-stepping. Six contours because the mark is **two disjoint
glyphs**, the V and the angled leg, each drawn as a filled outline with a
hairline inner channel. `fill-rule="evenodd"` is therefore mandatory; under the
default nonzero rule the channels fill in and the mark becomes a blob.

If a true vector ever surfaces, replacing `KODE_MARK_PATH` is the whole
migration.

Icons are generated rather than committed as opaque binaries:

```bash
node scripts/generate-icons.mjs
```

Montserrat is not vendored. Drop `montserrat-variable.woff2` into
`apps/web/public/fonts/` and the interface picks it up; without it the CSS falls
back to the system stack, which is legible but not KODE.

### Running the UI

```bash
npm run dev
```

Web on `:5173`, API on `:3000`. The web app runs standalone — it degrades to the
sign-in screen when the API is absent — but to get past that you need a
database:

```bash
docker compose up -d db
npm run migrate && npm run seed
```

---

## Licence

Internal, confidential. KODE Sports Club · Technology.
