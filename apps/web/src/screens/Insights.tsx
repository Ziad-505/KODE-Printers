import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { LeaderboardRow, TimeSeriesPoint, UsageSummary } from '@kode/shared';
import { api, qs } from '../lib/api.js';
import {
  Card,
  EmptyState,
  InsightIcon,
  Note,
  PageHeader,
  Segmented,
  Skeleton,
  Stat,
} from '../components/ui.js';

/**
 * Insights.
 *
 * Every figure on this screen carries its caveats with it. §A7.1 and §B8.5 each
 * describe a way this system can produce a confident wrong number — a printer
 * with SNMP disabled reports nothing at all, and a device without vendor
 * counters cannot distinguish a photocopy from a print — and DEC-06 settles
 * that such totals are labelled "device activity" rather than "prints".
 *
 * The notes are rendered above the charts, not in a footnote, because a number
 * read without its boundary is a number that will be quoted without it.
 */

type Range = '7d' | '30d' | '90d';

const RANGE_DAYS: Record<Range, number> = { '7d': 7, '30d': 30, '90d': 90 };

export function Insights(): ReactElement {
  const [range, setRange] = useState<Range>('30d');
  const [dimension, setDimension] = useState<'user' | 'printer' | 'department'>('printer');

  const { from, to } = useMemo(() => {
    const end = new Date();
    const start = new Date(end.getTime() - RANGE_DAYS[range] * 86_400_000);
    return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
  }, [range]);

  const bucket = range === '7d' ? 'day' : range === '30d' ? 'day' : 'week';

  const summary = useQuery({
    queryKey: ['stats', 'summary', from, to],
    queryFn: () =>
      api.get<
        UsageSummary & { walkupLabel: string; coverageNote: string | null; typeNote: string | null }
      >(`/stats/summary${qs({ from, to })}`),
  });

  const series = useQuery({
    queryKey: ['stats', 'series', from, to, bucket],
    queryFn: () => api.get<TimeSeriesPoint[]>(`/stats/series${qs({ from, to, bucket })}`),
  });

  const leaderboard = useQuery({
    queryKey: ['stats', 'leaderboard', from, to, dimension],
    queryFn: () =>
      api.get<LeaderboardRow[]>(`/stats/leaderboard${qs({ from, to, dimension, limit: 8 })}`),
  });

  const data = summary.data;

  return (
    <>
      <PageHeader
        title="What the club printed"
        subtitle={`${from} to ${to}`}
        actions={
          <>
            <div style={{ minWidth: 220 }}>
              <Segmented
                label="Date range"
                value={range}
                onChange={setRange}
                options={[
                  { value: '7d', label: '7 days' },
                  { value: '30d', label: '30 days' },
                  { value: '90d', label: '90 days' },
                ]}
              />
            </div>
            <a
              className="btn btn--secondary"
              href={`/api/jobs/export${qs({ from, to, format: 'csv' })}`}
              download
            >
              Export CSV
            </a>
          </>
        }
      />

      {/* The caveats come first. */}
      {data?.coverageNote || data?.typeNote ? (
        <div className="stack" style={{ gap: 'var(--space-3)', marginBottom: 'var(--space-5)' }}>
          {data.coverageNote ? <Note severity="warning">{data.coverageNote}</Note> : null}
          {data.typeNote ? <Note>{data.typeNote}</Note> : null}
        </div>
      ) : null}

      {summary.isLoading ? (
        <div className="stat-grid">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} height={104} />
          ))}
        </div>
      ) : data ? (
        <div className="stat-grid">
          <Stat
            label="Pages printed"
            value={data.totalImpressions.toLocaleString()}
            meta={`${data.totalJobs.toLocaleString()} job${data.totalJobs === 1 ? '' : 's'}`}
          />
          <Stat
            label="Colour"
            value={`${percent(data.colorImpressions, data.totalImpressions)}%`}
            meta={`${data.colorImpressions.toLocaleString()} pages`}
            tone="var(--accent-orange)"
          />
          <Stat
            label="Estimated cost"
            value={data.estimatedCost.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            meta={data.currency}
          />
          <Stat
            label="Sheets saved"
            value={data.sheetsSavedByDuplex.toLocaleString()}
            meta="by double-sided printing"
            tone="var(--status-online)"
          />
        </div>
      ) : null}

      {/* Sustainability panel. The factor is configurable precisely because it
          is an estimate, and the label says so rather than presenting a
          modelled figure as measured. */}
      {data && data.totalImpressions > 0 ? (
        <Card style={{ marginTop: 'var(--space-5)' }}>
          <div className="card__body row row--wrap row--between" style={{ gap: 'var(--space-5)' }}>
            <div>
              <div className="kode-eyebrow">Estimated footprint</div>
              <div
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 'var(--text-2xl)',
                  fontWeight: 900,
                  letterSpacing: '-0.03em',
                  marginTop: 'var(--space-2)',
                }}
              >
                {(data.co2Grams / 1000).toFixed(1)} kg CO₂e
              </div>
              <div className="dim" style={{ fontSize: 'var(--text-xs)' }}>
                A modelled estimate from paper and toner, not a measurement.
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="kode-eyebrow">Scans logged</div>
              <div
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 'var(--text-2xl)',
                  fontWeight: 900,
                  letterSpacing: '-0.03em',
                  marginTop: 'var(--space-2)',
                }}
              >
                {data.scanCount.toLocaleString()}
              </div>
            </div>
          </div>
        </Card>
      ) : null}

      <div className="split" style={{ marginTop: 'var(--space-5)' }}>
        <Card>
          <div className="card__header">
            <h2 className="card__title">Volume over time</h2>
          </div>
          <div className="card__body" style={{ height: 300 }}>
            {series.isLoading ? (
              <Skeleton height={260} />
            ) : !series.data?.length ? (
              <EmptyState icon={<InsightIcon />} title="No activity in this period" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={series.data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                  <defs>
                    <linearGradient id="fillTotal" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#2150A0" stopOpacity={0.22} />
                      <stop offset="100%" stopColor="#2150A0" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="fillColor" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#B0764F" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="#B0764F" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="var(--border-subtle)" vertical={false} />
                  <XAxis
                    dataKey="bucket"
                    tickFormatter={(value: string) =>
                      new Date(value).toLocaleDateString(undefined, {
                        day: 'numeric',
                        month: 'short',
                      })
                    }
                    tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }}
                    axisLine={false}
                    tickLine={false}
                    minTickGap={24}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }}
                    axisLine={false}
                    tickLine={false}
                    width={48}
                  />
                  <Tooltip content={<ChartTooltip />} />
                  <Area
                    type="monotone"
                    dataKey="impressions"
                    name="All pages"
                    stroke="#2150A0"
                    strokeWidth={2}
                    fill="url(#fillTotal)"
                  />
                  <Area
                    type="monotone"
                    dataKey="colorImpressions"
                    name="Colour"
                    stroke="#B0764F"
                    strokeWidth={2}
                    fill="url(#fillColor)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        <Card>
          <div className="card__header">
            <h2 className="card__title">Top consumers</h2>
          </div>
          <div className="card__body">
            <div style={{ marginBottom: 'var(--space-4)' }}>
              <Segmented
                label="Group by"
                value={dimension}
                onChange={setDimension}
                options={[
                  { value: 'printer', label: 'Printer' },
                  { value: 'user', label: 'Person' },
                  { value: 'department', label: 'Team' },
                ]}
              />
            </div>

            {leaderboard.isLoading ? (
              <Skeleton height={220} />
            ) : !leaderboard.data?.length ? (
              <EmptyState title="Nothing to rank yet" />
            ) : (
              <div style={{ height: 260 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={leaderboard.data}
                    layout="vertical"
                    margin={{ top: 0, right: 12, left: 0, bottom: 0 }}
                  >
                    <XAxis type="number" hide />
                    <YAxis
                      type="category"
                      dataKey="label"
                      width={110}
                      tick={{ fontSize: 11, fill: 'var(--text-secondary)' }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--surface-3)' }} />
                    <Bar dataKey="impressions" name="Pages" radius={[0, 4, 4, 0]}>
                      {leaderboard.data.map((row, index) => (
                        <Cell
                          key={row.key}
                          /* The leader is the brand blue at full strength and
                             every row below it steps down. Ranking should be
                             readable without reading the numbers, and a second
                             hue for first place would be one loud colour more
                             than this palette allows. */
                          fill={`rgba(33, 80, 160, ${Math.max(0.28, 1 - index * 0.11)})`}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; color?: string }>;
  label?: string | number;
}): ReactElement | null {
  if (!active || !payload?.length) return null;

  return (
    <div
      style={{
        background: 'var(--surface-4)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-3)',
        boxShadow: 'var(--shadow-md)',
        fontSize: 'var(--text-xs)',
      }}
    >
      {label !== undefined ? (
        <div style={{ fontWeight: 700, marginBottom: 4 }}>
          {typeof label === 'string' && label.includes('T')
            ? new Date(label).toLocaleDateString()
            : label}
        </div>
      ) : null}
      {payload.map((entry) => (
        <div key={entry.name} className="row" style={{ gap: 'var(--space-2)' }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 2,
              background: entry.color,
              flexShrink: 0,
            }}
          />
          <span className="dim">{entry.name}</span>
          <strong style={{ marginLeft: 'auto' }}>{entry.value?.toLocaleString()}</strong>
        </div>
      ))}
    </div>
  );
}

function percent(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}
