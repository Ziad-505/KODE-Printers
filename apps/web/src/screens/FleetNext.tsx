import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Paginated, Printer, PrinterSupply } from '@kode/shared';
import { api, ApiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { printerCondition, supplyGaugePercent, supplyLevelText, supplyName } from '../lib/plain.js';
import { Modal, Button, PrintIcon, QrIcon, ScanIcon, useToast } from '../components/ui.js';
import '../styles/next.css';

/**
 * The fleet board, rebuilt — a proposal, not a replacement.
 *
 * Lives at `/fleet/next` beside the current screen at `/fleet` so the two can
 * be opened one after the other on the same phone. Nothing here is imported by
 * anything else, and every style is scoped under `.nx`, so the eleven screens
 * we have not looked at yet are untouched either way.
 *
 * The data, the queries and the vocabulary are identical to `Fleet.tsx` on
 * purpose. If the two screens read differently it is the design that changed,
 * not the information — which is the only way the comparison answers anything.
 *
 * What is actually different:
 *
 *   · **17px body type**, not 14.5px, and nothing under 13px anywhere. The
 *     search field is 16px because mobile Safari force-zooms the page when you
 *     focus anything smaller, and never zooms back.
 *   · **One container per card.** Hairlines between rows, inset to the text
 *     column; no box around the card, the rows or the gauges.
 *   · **Four cartridges, not five arbitrary supplies.** The old card sliced the
 *     first five of twelve, which on a WorkCentre meant four toners and one
 *     drum — a cut with no meaning. Toners are what run out; the eight service
 *     parts sit behind a disclosure.
 *   · **44px targets.** The old QR and scan buttons were 36px.
 *   · **A dot and a sentence** instead of a coloured pill.
 */

export function FleetNext(): ReactElement {
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

  const counts = useMemo(() => {
    const tally = { ready: 0, attention: 0, stopped: 0, unchecked: 0 };
    for (const printer of printers) {
      const kind = printerCondition(printer).kind;
      if (kind === 'ready') tally.ready += 1;
      else if (kind === 'attention') tally.attention += 1;
      else if (kind === 'stopped') tally.stopped += 1;
      else tally.unchecked += 1;
    }
    return tally;
  }, [printers]);

  const summary =
    [
      counts.ready > 0 ? `${counts.ready} ready` : null,
      counts.attention > 0
        ? `${counts.attention} need${counts.attention === 1 ? 's' : ''} attention`
        : null,
      counts.stopped > 0 ? `${counts.stopped} stopped` : null,
      counts.unchecked > 0 ? `${counts.unchecked} not checked yet` : null,
    ]
      .filter(Boolean)
      .join(' · ') || 'No printers yet';

  return (
    <div className="nx">
      <header className="nx-header">
        <h1 className="nx-header__title">Printers</h1>
        <p className="nx-header__subtitle">{summary}</p>

        <div className="nx-search">
          <span className="nx-search__icon">
            <SearchGlyph />
          </span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search printers"
            aria-label="Search printers"
          />
        </div>
      </header>

      {isLoading ? (
        <div className="nx-grid">
          {[0, 1, 2].map((index) => (
            <div key={index} className="nx-skeleton" style={{ height: 300 }} />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="nx-empty">
          <div className="nx-empty__title">
            {search ? 'Nothing matches that search' : 'No printers yet'}
          </div>
          <p>
            {search
              ? 'Try a different name, area or address.'
              : 'An administrator needs to add printers and grant you access to them.'}
          </p>
        </div>
      ) : (
        grouped.map(([zone, group]) => (
          <section className="nx-section" key={zone}>
            <h2 className="nx-section__label">{zone}</h2>
            <div className="nx-grid">
              {group.map((printer) => (
                <PrinterCard
                  key={printer.id}
                  printer={printer}
                  onShowQr={() => setQrPrinter(printer)}
                />
              ))}
            </div>
          </section>
        ))
      )}

      {isAdmin ? (
        <Link className="nx-compare" to="/admin/printers">
          Manage printers
        </Link>
      ) : null}
      <div>
        <Link className="nx-compare" to="/fleet">
          ← Back to the current design
        </Link>
      </div>

      <QrModal printer={qrPrinter} onClose={() => setQrPrinter(null)} />
    </div>
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
  const [showAll, setShowAll] = useState(false);

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

  /* Cartridges first, and only cartridges by default.
   *
   * A colorant is what separates something that runs out and gets reordered
   * from a service part an engineer replaces on a schedule. The old card showed
   * whichever five happened to come first. */
  const readable = printer.supplies.filter((supply) => supplyLevelText(supply) !== null);
  const cartridges = readable.filter((supply) => supply.colorant !== null);
  const rest = readable.filter((supply) => supply.colorant === null);
  const shown = showAll ? readable : cartridges.slice(0, 4);
  const hidden = readable.length - shown.length;

  return (
    <article className="nx-card">
      <div className="nx-card__head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <h3 className="nx-card__name">{printer.name}</h3>
          <div className="nx-card__where">
            {[printer.area, printer.model].filter(Boolean).join(' · ') || printer.ipAddress}
          </div>
        </div>
      </div>

      <div className={`nx-status nx-status--${condition.kind}`}>
        <span className="nx-status__dot" />
        <span>{condition.text}</span>
      </div>

      {condition.kind === 'stopped' ? (
        <p className="nx-note">Anything queued for it will print by itself once that is sorted.</p>
      ) : null}

      {printer.isDraining || printer.walkupTrackingUnavailable || printer.scanFolder ? (
        <div className="nx-tags">
          {printer.isDraining ? <span className="nx-tag">In maintenance</span> : null}
          {printer.walkupTrackingUnavailable ? (
            <span className="nx-tag">Use here is not counted</span>
          ) : null}
          {printer.scanFolder ? <span className="nx-tag">Scans are picked up</span> : null}
        </div>
      ) : null}

      {shown.length > 0 ? (
        <div className="nx-supplies">
          {shown.map((supply) => (
            <SupplyRow key={supply.name} supply={supply} />
          ))}
        </div>
      ) : null}

      {rest.length > 0 && cartridges.length > 0 ? (
        <button
          type="button"
          className="nx-disclosure"
          aria-expanded={showAll}
          onClick={() => setShowAll((open) => !open)}
        >
          <span>
            {showAll
              ? 'Show cartridges only'
              : `Show ${hidden} more part${hidden === 1 ? '' : 's'}`}
          </span>
          <ChevronGlyph />
        </button>
      ) : null}

      <div className="nx-actions">
        <Link
          className="nx-btn nx-btn--primary"
          to={`/print?printer=${printer.id}`}
          aria-disabled={printer.isDraining}
          style={printer.isDraining ? { opacity: 0.4, pointerEvents: 'none' } : undefined}
        >
          <PrintIcon />
          Print
        </Link>
        {printer.scanFolder ? (
          <button
            type="button"
            className="nx-btn nx-btn--quiet"
            onClick={() => reserve.mutate()}
            disabled={reserve.isPending}
            aria-label="Claim the next scan from this printer"
            title="Claim the next scan from this printer"
          >
            <ScanIcon />
          </button>
        ) : null}
        <button
          type="button"
          className="nx-btn nx-btn--quiet"
          onClick={onShowQr}
          aria-label="Show QR code"
          title="Show QR code"
        >
          <QrIcon />
        </button>
      </div>
    </article>
  );
}

/* ────────────────────────────────────────────────────────────── one supply ── */

function SupplyRow({ supply }: { supply: PrinterSupply }): ReactElement {
  const gauge = supplyGaugePercent(supply) ?? 0;
  const text = supplyLevelText(supply);

  const colorant = supply.colorant?.toLowerCase() ?? '';
  const swatch = colorant.includes('cyan')
    ? '#22b8cf'
    : colorant.includes('magenta')
      ? '#e64980'
      : colorant.includes('yellow')
        ? 'var(--kode-gold)'
        : colorant.includes('black')
          ? 'var(--text-primary)'
          : 'var(--text-tertiary)';

  /* The bar takes the alarm colour, the swatch keeps the cartridge colour.
   * Recolouring the swatch when a cartridge runs low loses the one thing it is
   * there to say, which is which cartridge this row is about. */
  const low = gauge <= 10;
  const fill = low ? 'var(--status-offline)' : gauge <= 25 ? 'var(--status-degraded)' : swatch;

  return (
    <div className="nx-supply">
      <div className="nx-supply__name">
        <span className="nx-supply__swatch" style={{ background: swatch }} />
        {/* The part and serial number stay one hover away for whoever orders it. */}
        <span
          title={supply.name}
          style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {supplyName(supply.name)}
        </span>
      </div>
      <div className={`nx-supply__value${low ? ' nx-supply__value--low' : ''}`}>{text}</div>
      <div className="nx-supply__bar">
        <div
          className="nx-supply__fill"
          style={{ width: `${Math.max(gauge, gauge > 0 ? 2 : 0)}%`, background: fill }}
        />
      </div>
      {supply.estimatedDaysRemaining !== null && supply.estimatedDaysRemaining <= 21 ? (
        <div className="nx-supply__note">
          {supply.estimatedDaysRemaining === 0
            ? 'due to run out today at the current rate'
            : `about ${supply.estimatedDaysRemaining} day${
                supply.estimatedDaysRemaining === 1 ? '' : 's'
              } left at the current rate`}
        </div>
      ) : null}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────── the sheet ── */

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
        <div className="nx" style={{ textAlign: 'center', paddingBottom: 0 }}>
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
          <div
            style={{ fontSize: 'var(--nx-title)', fontWeight: 650, marginTop: 'var(--space-3)' }}
          >
            {printer.name}
          </div>
          <div style={{ fontSize: 'var(--nx-subhead)', color: 'var(--text-secondary)' }}>
            {[printer.zoneLabel, printer.area].filter(Boolean).join(' · ')}
          </div>
          <p
            style={{
              fontSize: 'var(--nx-subhead)',
              color: 'var(--text-secondary)',
              maxWidth: '40ch',
              margin: 'var(--space-4) auto 0',
            }}
          >
            Tape this to the printer. Anyone with access can scan it with a phone camera to open the
            print page with this device already selected.
          </p>
        </div>
      ) : null}
    </Modal>
  );
}

/* ───────────────────────────────────────────────────────────────── glyphs ── */

const glyph = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

const SearchGlyph = (): ReactElement => (
  <svg {...glyph}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

const ChevronGlyph = (): ReactElement => (
  <svg {...glyph} width={16} height={16} className="nx-disclosure__chevron">
    <path d="m6 9 6 6 6-6" />
  </svg>
);
