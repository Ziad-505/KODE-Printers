# KODE Printer — runbook

Everything here assumes the Compose deployment in `docker-compose.yml`.

---

## Go-live

1. **Secrets.** `cp .env.example .env`, then generate two _different_ values:

   ```bash
   openssl rand -base64 48
   ```

   Fill `POSTGRES_PASSWORD`, `JWT_SECRET` and `SECRET_KEY`. The process refuses
   to boot on a placeholder, on anything under 32 characters, on a default
   database credential pair, or if the two secrets match.

2. **Topology.** Pick one and set it, because the binding guard checks the
   property rather than guessing the means:

   - `DEPLOYMENT_TOPOLOGY=loopback` — the proxy shares this host. `BIND_HOST`
     must be `127.0.0.1`.
   - `DEPLOYMENT_TOPOLOGY=container` — the proxy is a separate service.
     `TRUST_PROXY_HOPS` must be at least 1, and the app's port must **not** be
     published.

3. **Origins.** `CORS_ORIGINS` is an explicit list. A wildcard fails the boot.

4. **Start and migrate.**

   ```bash
   docker compose up -d --build
   ```

   Migrations run at boot under an advisory lock, so a rolling restart cannot
   apply one twice.

5. **Seed the first administrator.** The password prints once.

   ```bash
   docker compose exec app node dist/db/seed.js
   ```

6. **Change it.** Until it is changed, every route except sign-in and
   change-password returns 503. This is the intended state, not a fault.

   This is the only password anyone is ever told. Every account after it is
   created without one — see _Giving people accounts_ below.

7. **Second administrator.** Create one before you finish. The system refuses
   to demote or disable the last one, so without a second account a lockout is
   recoverable only by editing the database.

8. **Verify.**

   ```bash
   curl -fsS localhost:3000/api/health/ready | jq .status
   ```

   `pass` or `warn`. A `warn` on the converters means Office documents will not
   convert — fix it before anyone tries.

9. **Restore rehearsal.** An untested backup is not a backup. Restore into a
   scratch database now, and quarterly thereafter:

   ```bash
   ./scripts/backup.sh && ./scripts/restore.sh <dump> kode_restore_test
   ```

---

## Giving people accounts

Press **Create an account** on the People screen, tick the printers they may
use, and send them the link it produces. They choose their own password.

| Situation          | What you do                                                          |
| ------------------ | -------------------------------------------------------------------- |
| New starter        | Create an account, Copy link, send it                                |
| They lost the link | _New link_ on their row — the old one stops working                  |
| Forgotten password | _Make a reset link_, copy, send                                      |
| Someone left       | _Turn off_. Their sessions end at once and their print history stays |

Link lifetimes: **seven days** for a new account, **one hour** for a reset. Both
work exactly once. Only the hash is stored, so a link cannot be shown again —
if it is lost, make another.

Making a reset link signs that person out on every device immediately. That is
deliberate: an administrator issuing one is answering either "I can't get in" or
"I think someone else can", and the second case is not helped by leaving the
intruder's session alive.

Nothing here sends email. If someone asks why they did not get one, that is the
answer — the link goes out through whatever you already use to reach them.

---

## Adding printers

Add by IP address only. Serial number, vendor, model, IPP support and
capabilities all come from the probe.

- The address must be private (RFC1918 or link-local). So must the host of any
  IPP URI you set by hand.
- A device with SNMP disabled **reports no walk-up activity**. It will show a
  coverage note on every report that covers it. That is deliberate: an invisible
  gap is a false report.
- Vendor print/copy counter OIDs are worth setting where the model exposes them.
  Without them, a photocopy and a print are indistinguishable and the activity is
  recorded as `unknown` and labelled "device activity".

---

## Day-to-day

| Symptom                             | Where to look                          | Usual cause                                                                                    |
| ----------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Job stuck in `queued`               | `/api/health/ready` → `queue-depth`    | Worker not running, or the printer's circuit is open                                           |
| Job failed with `PRINTER_NOT_READY` | The printer's `stateReasons`           | Jam, empty tray, open door. Fix it; the job retries                                            |
| Printer flips online/offline        | `printer.state_changed` notifications  | Sleep timer on the device, or a flaky switch port                                              |
| `device-mismatch` on a printer      | Audit log, `printer.identity_mismatch` | A device was swapped and took the old lease. Confirm what is physically there before clearing  |
| Reports understate usage            | `coverageNote` in the summary response | A printer in scope has SNMP off                                                                |
| Collector shows unhealthy           | `GET /api/collectors`                  | Three missed heartbeats. Check the uplink from the collector side; it keeps spooling meanwhile |
| "This link no longer works"         | Audit log, `user.setup_link`           | Used already, expired, or superseded by a newer link. Make a fresh one                         |

### Requests to keep

```bash
# What is the queue doing?
curl -fsS localhost:3000/api/health/ready | jq '.checks[] | select(.name=="queue-depth")'

# Trace one user's complaint. They can read the request id off the error.
docker compose logs app | grep <requestId>
```

---

## Alerts worth wiring into Zabbix

Metrics are at `/api/health/metrics`, reachable from the internal network only.

| Metric                      | Threshold     | Means                                                          |
| --------------------------- | ------------- | -------------------------------------------------------------- |
| `kode_queue_oldest_seconds` | > 900         | Jobs are not draining. Same threshold the readiness check uses |
| `kode_queue_depth`          | > 50          | Backlog building                                               |
| `kode_printers_up`          | drops sharply | A switch or a building, not a printer                          |
| Disk on the upload volume   | > 80%         | The retention sweep also raises this as a notification         |

---

## Recovery

**The server was killed mid-job.** Nothing to do. Rows left in `processing` are
reclaimed within 60 seconds and re-queued; the ledger entry for the interrupted
job expires rather than being attributed to a walk-up.

**A printer's counter went backwards.** Expected after a firmware update. The
baseline re-anchors, no job is logged, and a warning notification records that
totals around that time may be incomplete.

**The collector's uplink was down for hours.** Events spooled locally and replay
on reconnection; idempotency keys stop them double-logging. If the spool hit its
cap, an error names how many events were discarded — that period is genuinely
under-reported and the report should say so.

**Someone replayed a refresh token.** Every session for that account is already
ended and a critical notification was raised. Confirm with the person whether it
was their own stale tab before treating it as a theft.

---

## Things this system cannot do

State these before someone discovers them in a report.

- A printer with SNMP disabled contributes **nothing** to walk-up figures.
- Without vendor counters, a photocopy is indistinguishable from a print.
- Two walk-up jobs inside one poll cycle appear as one combined entry. SNMP
  returns a single number.
- Printing **through** a site collector is not implemented. Such jobs are
  refused at submission with a message that says so; scans and walk-up tracking
  from those buildings still work.
- Scan tracking needs Scan to Network Folder. Scan-to-USB and scan-to-email
  cannot be tracked at all.
