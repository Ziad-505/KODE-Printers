import type { CSSProperties, ReactElement } from 'react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Paginated, Printer, PrinterSupply } from '@kode/shared';
import { api, ApiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { printerCondition, supplyGaugePercent, supplyLevelText, supplyName } from '../lib/plain.js';
import {
  Badge,
  Button,
  buttonClasses,
  Card,
  EmptyState,
  FleetIcon,
  Input,
  Modal,
  Note,
  PageHeader,
  PrintIcon,
  QrIcon,
  ScanIcon,
  Skeleton,
  StatusBadge,
  StatusDot,
  useToast,
} from '../components/ui.js';

/**
 * The fleet board.
 *
 * A live view of every printer the signed-in person may use. The design goal is
 * that someone can glance at a phone from across a room and know whether the
 * printer they are walking to is going to work — which is why status, the
 * blocking reason, and toner sit above everything else on each card.
 *
 * Printers whose walk-up tracking is unavailable are labelled explicitly.
 * §B8.5: "A known gap that is visible is a limitation. A known gap that is
 * invisible is a false report."
 */
export function Fleet(): ReactElement {
  const { isAdmin } = useAuth();
  const [search, setSearch] = useState('');
  const [qrPrinter, setQrPrinter] = useState<Printer | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['printers', 'fleet'],
    queryFn: () => api.get<Paginated<Printer>>('/printers?limit=200'),
    refetchInterval: 60_000,
  });

  const printers = data?.items ?? [];

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return printers;
    return printers.filter((printer) =>
      [printer.name, printer.area, printer.model, printer.zoneLabel, printer.ipAddress]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }, [printers, search]);

  const grouped = useMemo(() => {
    const groups = new Map<string, Printer[]>();
    for (const printer of filtered) {
      const key = printer.zoneLabel ?? 'Unassigned';
      const bucket = groups.get(key);
      if (bucket) bucket.push(printer);
      else groups.set(key, [printer]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  /* Every printer lands in exactly one bucket.
   *
   * Counting by `status` alone left `unknown` devices — one that has never
   * answered a poll — in no bucket, so the summary described four printers out
   * of five and quietly lost the one most likely to need looking at. */
  const counts = useMemo(() => {
    const tally = { ready: 0, attention: 0, stopped: 0, unchecked: 0 };
    for (const printer of printers) {
      const kind = printerCondition(printer).kind;
      if (kind === 'ready') tally.ready += 1;
      else if (kind === 'attention') tally.attention += 1;
      else if (kind === 'stopped') tally.stopped += 1;
      else tally.unchecked += 1;
    }
    return { ...tally, untracked: printers.filter((p) => p.walkupTrackingUnavailable).length };
  }, [printers]);

  /** "2 ready, 1 needs attention" — only the parts that are not zero. */
  const summary = [
    counts.ready > 0 ? `${counts.ready} ready` : null,
    counts.attention > 0
      ? `${counts.attention} need${counts.attention === 1 ? 's' : ''} attention`
      : null,
    counts.stopped > 0 ? `${counts.stopped} stopped` : null,
    counts.unchecked > 0 ? `${counts.unchecked} not checked yet` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <PageHeader
        title="Printers"
        subtitle={printers.length > 0 ? summary : undefined}
        actions={
          <>
            <Input
              placeholder="Search printers…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              style={{ width: 'min(260px, 50vw)' }}
              aria-label="Search printers"
            />
            {isAdmin ? (
              <Link className={buttonClasses('secondary')} to="/admin/printers">
                Manage
              </Link>
            ) : null}
          </>
        }
      />

      {counts.untracked > 0 ? (
        <div style={{ marginBottom: 'var(--space-5)' }}>
          {/* The same fact §B8.5 requires, said the way somebody would say it.
              "Walk-up tracking unavailable" is the server's phrase and means
              nothing to the person reading a report. */}
          <Note>
            {counts.untracked === 1
              ? 'One printer cannot tell us when someone uses it directly, so the totals here and in every report are a little low.'
              : `${counts.untracked} printers cannot tell us when someone uses them directly, so the totals here and in every report are a little low.`}
          </Note>
        </div>
      ) : null}

      {isLoading ? (
        <div className="grid-cards">
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <Skeleton key={index} height={196} />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <EmptyState
            icon={<FleetIcon />}
            title={search ? 'Nothing matches that search' : 'No printers yet'}
            body={
              search
                ? 'Try a different name, area or address.'
                : 'An administrator needs to add printers and grant you access to them.'
            }
          />
        </Card>
      ) : (
        <div className="stack" style={{ gap: 'var(--space-6)' }}>
          {grouped.map(([zone, group]) => (
            <section key={zone}>
              <h2 className="section-title kode-slash">{zone}</h2>
              <div className="grid-cards kp-stagger">
                {group.map((printer, index) => (
                  <div key={printer.id} style={{ '--kp-index': index } as CSSProperties}>
                    <PrinterCard printer={printer} onShowQr={() => setQrPrinter(printer)} />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {/* Temporary, for the design comparison. At the bottom rather than in the
          header on purpose: a control up there would change the very layout
          being judged. Comes out with the decision. */}
      <Link
        to="/fleet/next"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          minHeight: 44,
          marginTop: 'var(--space-6)',
          fontSize: 'var(--text-xs)',
          fontWeight: 700,
          color: 'var(--kode-blue)',
        }}
      >
        Try the proposed design →
      </Link>

      <QrModal printer={qrPrinter} onClose={() => setQrPrinter(null)} />
    </>
  );
}

/* ─────────────────────────────────────────────────────────────── the card ── */

function PrinterCard({
  printer,
  onShowQr,
}: {
  printer: Printer;
  onShowQr: () => void;
}): ReactElement {
  const toast = useToast();
  const queryClient = useQueryClient();

  const reserve = useMutation({
    mutationFn: () => api.post<{ message: string }>('/scans/reserve', { printerId: printer.id }),
    onSuccess: (result) => {
      toast.push({ tone: 'success', title: 'Scan reserved', body: result.message });
      void queryClient.invalidateQueries({ queryKey: ['scans'] });
    },
    onError: (error) =>
      toast.push({
        tone: 'warning',
        title: 'Could not reserve',
        body: error instanceof ApiError ? error.message : 'Something went wrong.',
      }),
  });

  const condition = printerCondition(printer);

  return (
    <Card interactive>
      <div className="card__body stack" style={{ gap: 'var(--space-4)' }}>
        {/* The name wins the width argument.
         *
         * Both children used to be free to size themselves, so a long condition
         * label took the row and "Testing Xerox" rendered as "Te…". The name is
         * the one thing that identifies the card, so it gets `flex: 1` and the
         * badge is pushed onto its own line rather than allowed to squeeze it. */}
        <div className="stack" style={{ gap: 'var(--space-2)' }}>
          <div
            className="row row--between"
            style={{ alignItems: 'flex-start', gap: 'var(--space-3)' }}
          >
            <div style={{ minWidth: 0, flex: '1 1 auto' }}>
              <div className="truncate" style={{ fontWeight: 800, fontSize: 'var(--text-lg)' }}>
                {printer.name}
              </div>
              <div className="dim truncate" style={{ fontSize: 'var(--text-xs)' }}>
                {[printer.area, printer.model].filter(Boolean).join(' · ') || printer.ipAddress}
              </div>
            </div>
            <StatusDot status={printer.status} />
          </div>
          <div className="row row--wrap" style={{ gap: 'var(--space-2)' }}>
            <StatusBadge status={printer.status} label={condition.text} />
          </div>
        </div>

        {condition.kind === 'stopped' ? (
          <div className="note note--critical" role="status">
            <span aria-hidden="true">⚠</span>
            <span>Anything queued for it will print by itself once that is sorted.</span>
          </div>
        ) : null}

        {printer.supplies.length > 0 ? <Supplies supplies={printer.supplies} /> : null}

        <div className="row row--wrap" style={{ gap: 'var(--space-2)' }}>
          {printer.isDraining ? <Badge tone="degraded">In maintenance</Badge> : null}
          {printer.walkupTrackingUnavailable ? <Badge>Use here is not counted</Badge> : null}
          {printer.scanFolder ? <Badge>Scans are picked up</Badge> : null}
        </div>

        <div className="row" style={{ gap: 'var(--space-2)', marginTop: 'auto' }}>
          <Link
            className={buttonClasses('primary', 'sm')}
            to={`/print?printer=${printer.id}`}
            aria-disabled={printer.isDraining}
            style={printer.isDraining ? { opacity: 0.45, pointerEvents: 'none' } : undefined}
          >
            <PrintIcon />
            Print
          </Link>
          {printer.scanFolder ? (
            <Button
              variant="secondary"
              size="sm"
              icon={<ScanIcon />}
              loading={reserve.isPending}
              onClick={() => reserve.mutate()}
              title="Claim the next scan from this printer"
            >
              Scan to me
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={onShowQr} aria-label="Show QR code">
            <QrIcon />
          </Button>
        </div>
      </div>
    </Card>
  );
}

/**
 * Supply levels as stacked bars.
 *
 * Bars rather than donuts: a colour MFP has four or five cartridges, and five
 * small donuts side by side is unreadable at phone width while five bars stack
 * naturally and stay comparable.
 */
function Supplies({ supplies }: { supplies: readonly PrinterSupply[] }): ReactElement {
  const colorFor = (supply: PrinterSupply): string => {
    // The gauge fraction, not the displayed figure: a cartridge measured in
    // pages has no percentage to threshold on, and it still needs to turn red.
    const percent = supplyGaugePercent(supply) ?? 100;
    if (percent <= 10) return 'var(--status-offline)';
    if (percent <= 25) return 'var(--status-degraded)';
    const colorant = supply.colorant?.toLowerCase() ?? '';
    if (colorant.includes('cyan')) return '#22b8cf';
    if (colorant.includes('magenta')) return '#e64980';
    if (colorant.includes('yellow')) return 'var(--kode-gold)';
    return 'var(--text-secondary)';
  };

  return (
    <div className="stack" style={{ gap: 'var(--space-2)' }}>
      {supplies
        .filter((supply) => supplyLevelText(supply) !== null)
        .slice(0, 5)
        .map((supply) => (
          <div key={supply.name}>
            <div
              className="row row--between"
              style={{ fontSize: 'var(--text-2xs)', marginBottom: 3 }}
            >
              {/* `title` keeps the part and serial number one hover away, for
                  whoever is actually ordering the replacement. */}
              <span className="dim truncate" title={supply.name}>
                {supplyName(supply.name)}
              </span>
              <span style={{ fontWeight: 700, color: colorFor(supply) }}>
                {supplyLevelText(supply)}
              </span>
            </div>
            <div className="gauge">
              <div
                className="gauge__fill"
                style={{
                  width: `${supplyGaugePercent(supply) ?? 0}%`,
                  background: colorFor(supply),
                }}
              />
            </div>
            {supply.estimatedDaysRemaining !== null && supply.estimatedDaysRemaining <= 21 ? (
              <div className="dim" style={{ fontSize: 'var(--text-2xs)', marginTop: 2 }}>
                {supply.estimatedDaysRemaining === 0
                  ? 'due to run out today at the current rate'
                  : `about ${supply.estimatedDaysRemaining} day${
                      supply.estimatedDaysRemaining === 1 ? '' : 's'
                    } left at the current rate`}
              </div>
            ) : null}
          </div>
        ))}
    </div>
  );
}

/**
 * The QR sheet.
 *
 * Printed once and taped to the device. Scanning it opens the composer with
 * that printer already chosen, which removes the step people actually get wrong
 * — picking the right device from a list while standing in front of it.
 */
function QrModal({
  printer,
  onClose,
}: {
  printer: Printer | null;
  onClose: () => void;
}): ReactElement {
  return (
    <Modal
      open={printer !== null}
      onClose={onClose}
      title={printer ? `QR code for ${printer.name}` : 'QR code'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" onClick={() => window.print()}>
            Print this sheet
          </Button>
        </>
      }
    >
      {printer ? (
        <div className="stack" style={{ alignItems: 'center', textAlign: 'center' }}>
          <img
            src={`/api/printers/${printer.id}/qr`}
            alt={`QR code that opens the print page for ${printer.name}`}
            style={{
              width: 220,
              height: 220,
              background: '#fff',
              padding: 'var(--space-4)',
              borderRadius: 'var(--radius-lg)',
            }}
          />
          <div style={{ fontWeight: 800, fontSize: 'var(--text-lg)' }}>{printer.name}</div>
          <div className="dim" style={{ fontSize: 'var(--text-sm)' }}>
            {[printer.zoneLabel, printer.area].filter(Boolean).join(' · ')}
          </div>
          <p className="muted" style={{ fontSize: 'var(--text-sm)', maxWidth: '40ch' }}>
            Tape this to the printer. Anyone with access can scan it with a phone camera to open the
            print page with this device already selected.
          </p>
        </div>
      ) : null}
    </Modal>
  );
}
