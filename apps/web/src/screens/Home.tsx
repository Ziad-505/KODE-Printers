import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Job, Paginated, Printer, TimeSeriesPoint, UsageSummary } from '@kode/shared';
import { api, qs } from '../lib/api.js';
import {
  badgeToneFor,
  friendlyTime,
  inkPhrase,
  jobHeadline,
  jobStatus,
  pageCount,
  printerCondition,
  supplyGaugePercent,
} from '../lib/plain.js';
import { useAuth } from '../lib/auth.js';
import { Card, Note, PageHeader, Skeleton, StatusDot } from '../components/ui.js';

/**
 * Home.
 *
 * The screen someone opens first, so it answers the three questions they
 * actually arrive with: is anything broken, how much are we printing, and what
 * just happened. Everything is phrased the way a person would say it — "Out of
 * paper", not `media-empty`; "Someone used the printer directly", not
 * `walkup`.
 *
 * There is no cost anywhere on this page. It was the first thing an
 * administrator saw and the least useful: money is a monthly question, and
 * putting it beside a live queue made a shift look expensive rather than busy.
 * It still lives in the reports.
 */
export function Home(): ReactElement {
  const { user } = useAuth();

  const today = isoDay(new Date());
  const monthAgo = isoDay(new Date(Date.now() - 29 * 86_400_000));

  const summary = useQuery({
    queryKey: ['stats', 'today', today],
    queryFn: () =>
      api.get<UsageSummary & { coverageNote: string | null }>(
        `/stats/summary${qs({ from: today, to: today })}`,
      ),
  });

  /* Two series rather than one.
   *
   * A job someone sent from the app and a page someone stood at the machine to
   * copy are different events, and the backend refuses to call the second one
   * printing. A single combined line would quietly do exactly that. */
  const appSeries = useQuery({
    queryKey: ['stats', 'series', 'app', monthAgo],
    queryFn: () =>
      api.get<TimeSeriesPoint[]>(
        `/stats/series${qs({ from: monthAgo, to: today, bucket: 'day', source: 'app' })}`,
      ),
  });

  const walkupSeries = useQuery({
    queryKey: ['stats', 'series', 'walkup', monthAgo],
    queryFn: () =>
      api.get<TimeSeriesPoint[]>(
        `/stats/series${qs({ from: monthAgo, to: today, bucket: 'day', source: 'walkup' })}`,
      ),
  });

  const printers = useQuery({
    queryKey: ['printers', 'home'],
    queryFn: () => api.get<Paginated<Printer>>('/printers?limit=100'),
  });

  const recent = useQuery({
    queryKey: ['jobs', 'home'],
    queryFn: () => api.get<Paginated<Job>>('/jobs?limit=6'),
  });

  const queued = useQuery({
    queryKey: ['jobs', 'queued'],
    queryFn: () => api.get<Paginated<Job>>('/jobs?status=queued&limit=20'),
  });

  const scans = useQuery({
    queryKey: ['scans', 'unclaimed'],
    queryFn: () => api.get<Paginated<never>>('/scans?status=unclaimed&limit=20'),
  });

  const fleet = printers.data?.items ?? [];
  const stopped = fleet.filter((printer) => printerCondition(printer).kind === 'stopped');
  const ready = fleet.filter((printer) => printerCondition(printer).kind === 'ready');

  return (
    <>
      <PageHeader
        title={`Hi ${firstName(user?.displayName ?? user?.username ?? '')}`}
        subtitle="Here's what's happening with printing today."
        actions={
          <Link to="/print" className="btn btn--primary">
            Print a document
          </Link>
        }
      />

      {stopped[0] ? <AttentionBanner printer={stopped[0]} /> : null}

      <div className="grid grid--3" style={{ marginBottom: 'var(--space-5)' }}>
        <BigStat
          label="Pages printed today"
          count={
            summary.data === undefined
              ? undefined
              : { value: summary.data.totalImpressions, capped: false }
          }
          meta={
            summary.data
              ? `From ${summary.data.totalJobs} document${summary.data.totalJobs === 1 ? '' : 's'} across the club.`
              : undefined
          }
          loading={summary.isPending}
        />
        <BigStat
          label="Waiting to print"
          count={countOf(queued.data)}
          meta="They go through on their own."
          loading={queued.isPending}
        />
        <BigStat
          label="Scans waiting"
          count={countOf(scans.data)}
          meta="Nobody has collected these yet."
          loading={scans.isPending}
        />
      </div>

      <div className="grid grid--sidebar">
        <div className="stack" style={{ gap: 'var(--space-5)' }}>
          <Card>
            <div className="card__header">
              <div>
                <div className="card__title">How much is being printed</div>
                <div className="dim" style={{ fontSize: 'var(--text-sm)' }}>
                  Over the last month, across the whole club.
                </div>
              </div>
              <div className="row" style={{ gap: 'var(--space-4)' }}>
                <Legend colour="var(--kode-blue)" label="Sent from the app" />
                <Legend colour="var(--surface-4)" label="Done at the printer" />
              </div>
            </div>
            <div className="card__body">
              {appSeries.isPending || walkupSeries.isPending ? (
                <Skeleton height={170} />
              ) : (
                <TrendChart app={appSeries.data ?? []} walkup={walkupSeries.data ?? []} />
              )}
            </div>
          </Card>

          <Card>
            <div className="card__header">
              <div className="card__title">What happened recently</div>
              <Link to="/jobs" className="btn btn--ghost btn--sm">
                See everything
              </Link>
            </div>
            <div className="card__body stack" style={{ gap: 0 }}>
              {recent.isPending ? (
                <Skeleton height={120} />
              ) : (recent.data?.items ?? []).length === 0 ? (
                <p className="dim">Nothing has been printed yet today.</p>
              ) : (
                (recent.data?.items ?? []).map((job) => <ActivityRow key={job.id} job={job} />)
              )}
            </div>
          </Card>
        </div>

        <Card>
          <div className="card__header">
            <div>
              <div className="card__title">Your printers</div>
              <div className="dim" style={{ fontSize: 'var(--text-sm)' }}>
                {printers.isPending
                  ? 'Checking…'
                  : `${ready.length} of ${fleet.length} are ready to use right now.`}
              </div>
            </div>
          </div>
          <div className="card__body stack" style={{ gap: 0 }}>
            {printers.isPending ? (
              <Skeleton height={140} />
            ) : (
              [...stopped, ...fleet.filter((printer) => !stopped.includes(printer))]
                .slice(0, 6)
                .map((printer) => <PrinterRow key={printer.id} printer={printer} />)
            )}
          </div>
          {summary.data?.coverageNote ? (
            <div className="card__body" style={{ paddingTop: 0 }}>
              <Note>{summary.data.coverageNote}</Note>
            </div>
          ) : null}
        </Card>
      </div>
    </>
  );
}

/* ═════════════════════════════════════════════════════════════════ the top */

/**
 * The one thing that is actually wrong, as a sentence.
 *
 * A red dot in a grid of printers is a puzzle; a line saying which machine,
 * what it needs and what happens next is an instruction. Only ever the first
 * one — a banner that lists four problems is a list, and lists get skimmed.
 */
function AttentionBanner({ printer }: { printer: Printer }): ReactElement {
  return (
    <div className="attention" role="status">
      <div className="attention__icon" aria-hidden="true">
        !
      </div>
      <div style={{ flexGrow: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700 }}>
          {printer.name}: {printerCondition(printer).text.toLowerCase()}
        </div>
        <div className="dim" style={{ fontSize: 'var(--text-sm)', marginTop: 2 }}>
          Anything waiting for it will print by itself once someone sorts it out.
        </div>
      </div>
      <Link to="/fleet" className="btn btn--secondary btn--sm">
        See the printer
      </Link>
    </div>
  );
}

function BigStat({
  label,
  count,
  meta,
  loading,
}: {
  label: string;
  count: { value: number; capped: boolean } | undefined;
  meta?: string | undefined;
  loading: boolean;
}): ReactElement {
  return (
    <Card>
      <div className="card__body">
        <div style={{ fontWeight: 600, fontSize: 'var(--text-base)' }}>{label}</div>
        {loading ? (
          <Skeleton height={38} width="50%" />
        ) : (
          <div className="big-stat">
            {(count?.value ?? 0).toLocaleString()}
            {count?.capped ? '+' : ''}
          </div>
        )}
        {meta ? (
          <div className="dim" style={{ fontSize: 'var(--text-sm)' }}>
            {meta}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function Legend({ colour, label }: { colour: string; label: string }): ReactElement {
  return (
    <span className="row" style={{ gap: 'var(--space-2)', fontSize: 'var(--text-sm)' }}>
      <span
        aria-hidden="true"
        style={{ width: 10, height: 10, borderRadius: 3, background: colour }}
      />
      <span className="dim">{label}</span>
    </span>
  );
}

/* ═══════════════════════════════════════════════════════════════════ chart */

/**
 * Two smooth areas, drawn by hand rather than with a chart library.
 *
 * Recharts is already a dependency and is used on the reports screen, but it is
 * ~90 KB and this is the first screen anyone sees. A path and two `<path>`
 * elements cost nothing and load with the shell.
 *
 * The curve is a cardinal-style smoothing over daily points. Smoothing is
 * honest here because the underlying quantity is continuous — pages per day —
 * and nobody reads an individual day off this chart; the shape is the message.
 */
function TrendChart({
  app,
  walkup,
}: {
  app: readonly TimeSeriesPoint[];
  walkup: readonly TimeSeriesPoint[];
}): ReactElement {
  const width = 720;
  const height = 170;
  const floor = height - 26;

  const days = Math.max(app.length, walkup.length, 2);
  const peak = Math.max(
    1,
    ...app.map((point) => point.impressions),
    ...walkup.map((point) => point.impressions),
  );

  const toPoints = (series: readonly TimeSeriesPoint[]): Array<[number, number]> =>
    series.map((point, index) => [
      (index / Math.max(1, days - 1)) * width,
      floor - (point.impressions / peak) * (floor - 14),
    ]);

  const appPoints = toPoints(app);
  const walkPoints = toPoints(walkup);

  if (appPoints.length === 0 && walkPoints.length === 0) {
    return <p className="dim">Nothing has been printed in the last month.</p>;
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ display: 'block', width: '100%', height }}
      role="img"
      aria-label={`Pages printed each day over the last month. Highest day, ${peak} pages.`}
    >
      <defs>
        <linearGradient id="trend-app" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--kode-blue)" stopOpacity="0.2" />
          <stop offset="100%" stopColor="var(--kode-blue)" stopOpacity="0.02" />
        </linearGradient>
      </defs>

      {[0.25, 0.5, 0.75].map((fraction) => (
        <line
          key={fraction}
          x1={0}
          x2={width}
          y1={14 + (floor - 14) * fraction}
          y2={14 + (floor - 14) * fraction}
          stroke="var(--border-subtle)"
          strokeWidth={1}
        />
      ))}
      <line
        x1={0}
        x2={width}
        y1={floor}
        y2={floor}
        stroke="var(--border-default)"
        strokeWidth={1}
      />

      {walkPoints.length > 1 ? (
        <path
          d={smooth(walkPoints)}
          fill="none"
          stroke="var(--surface-4)"
          strokeWidth={2.5}
          strokeLinecap="round"
        />
      ) : null}

      {appPoints.length > 1 ? (
        <>
          <path
            d={`${smooth(appPoints)} L ${width} ${floor} L 0 ${floor} Z`}
            fill="url(#trend-app)"
          />
          <path
            d={smooth(appPoints)}
            fill="none"
            stroke="var(--kode-blue)"
            strokeWidth={2.8}
            strokeLinecap="round"
          />
        </>
      ) : null}
    </svg>
  );
}

/**
 * A smooth path through points, using horizontal control handles.
 *
 * Deliberately not a spline that can overshoot: pages printed cannot be
 * negative, and a curve that dips below the axis between two low days would be
 * drawing something that did not happen.
 */
function smooth(points: ReadonlyArray<readonly [number, number]>): string {
  if (points.length === 0) return '';
  const [first, ...rest] = points;
  if (!first) return '';

  let path = `M ${first[0]} ${first[1]}`;
  let previous = first;

  for (const point of rest) {
    const midpoint = (previous[0] + point[0]) / 2;
    path += ` C ${midpoint} ${previous[1]} ${midpoint} ${point[1]} ${point[0]} ${point[1]}`;
    previous = point;
  }
  return path;
}

/* ════════════════════════════════════════════════════════════════════ rows */

function ActivityRow({ job }: { job: Job }): ReactElement {
  const status = jobStatus(job);
  const tone = badgeToneFor(status.tone);

  return (
    <div className="list-row">
      <div style={{ flexGrow: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 500 }} className="truncate">
          {jobHeadline(job)}
        </div>
        <div className="dim" style={{ fontSize: 'var(--text-sm)', marginTop: 2 }}>
          {job.printerNameSnapshot} · {pageCount(job)} · {friendlyTime(job.createdAt)}
        </div>
      </div>
      <span className={`badge${tone ? ` badge--${tone}` : ''}`}>{status.text}</span>
    </div>
  );
}

function PrinterRow({ printer }: { printer: Printer }): ReactElement {
  const condition = printerCondition(printer);
  // The same ink-bearing supply `inkPhrase` describes, so the bar and the
  // sentence above it are about the same cartridge rather than two different
  // consumables that happened to be first in the list.
  const supply = printer.supplies.find(
    (entry) => entry.colorant !== null && supplyGaugePercent(entry) !== null,
  );
  const supplyPercent = supply ? supplyGaugePercent(supply) : null;
  const ink = inkPhrase(printer);

  const colour =
    condition.kind === 'stopped'
      ? 'var(--status-offline)'
      : condition.kind === 'attention'
        ? 'var(--status-degraded)'
        : undefined;

  return (
    <div className="list-row">
      <StatusDot status={printer.status} />
      <div style={{ flexGrow: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }} className="truncate">
          {printer.name}
        </div>
        <div
          className="dim truncate"
          style={{ fontSize: 'var(--text-sm)', marginTop: 2, color: colour }}
        >
          {condition.kind === 'ready' && ink
            ? `Ready · ${ink}`
            : printer.walkupTrackingUnavailable && condition.kind !== 'stopped'
              ? 'Not counted in the totals'
              : condition.text}
        </div>
        {supplyPercent !== null && condition.kind !== 'stopped' ? (
          <div className="meter" aria-hidden="true">
            <span
              className="meter__fill"
              style={{
                width: `${Math.max(2, supplyPercent)}%`,
                background: supplyPercent <= 10 ? 'var(--status-degraded)' : 'var(--status-online)',
              }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════ helpers */

/**
 * How many rows a page holds, and whether that is the whole story.
 *
 * These counters ask for a bounded page rather than a total, because the API
 * has no count endpoint and a `COUNT(*)` on the jobs table is not something a
 * dashboard should trigger every thirty seconds. When the page is full the
 * figure is a floor, and the card says so rather than quietly under-reporting.
 */
function countOf(
  page: Paginated<unknown> | undefined,
): { value: number; capped: boolean } | undefined {
  if (!page) return undefined;
  return { value: page.items.length, capped: page.hasMore };
}

function firstName(name: string): string {
  return name.split(/[\s._-]+/)[0] ?? name;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
