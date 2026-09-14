import type { CSSProperties, ReactElement } from 'react';
import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { describePrintOptions, type Job, type JobStatus, type Paginated } from '@kode/shared';
import { api, ApiError, qs } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  HistoryIcon,
  Input,
  PageHeader,
  Skeleton,
  useToast,
} from '../components/ui.js';

/**
 * Job history.
 *
 * Infinite scroll over keyset pages — §B5.4 forbids offset pagination, and the
 * cursor the server returns is threaded straight back, so scrolling to the
 * bottom of a year of history stays an index seek rather than a table walk.
 *
 * Walk-up rows are labelled honestly. A job with `jobType: 'unknown'` came from
 * a device with no vendor counter, where a print and a photocopy are
 * indistinguishable — DEC-06 settles that these are "device activity", not
 * prints, and the row says so rather than leaving the reader to assume.
 */
export function Jobs(): ReactElement {
  const { isAdmin } = useAuth();
  const [status, setStatus] = useState<JobStatus | ''>('');
  const [search, setSearch] = useState('');

  const query = useInfiniteQuery({
    queryKey: ['jobs', { status, search }],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.get<Paginated<Job>>(`/jobs${qs({ status, search, cursor: pageParam, limit: 40 })}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const jobs = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <>
      <PageHeader
        title={isAdmin ? 'All activity' : 'Your activity'}
        subtitle="Everything this system sent, plus anything started at a device."
        actions={
          <>
            <Input
              placeholder="Search documents…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              style={{ width: 'min(240px, 50vw)' }}
              aria-label="Search jobs"
            />
            <select
              className="select"
              style={{ width: 'auto', minWidth: 150 }}
              value={status}
              onChange={(event) => setStatus(event.target.value as JobStatus | '')}
              aria-label="Filter by status"
            >
              <option value="">Any status</option>
              <option value="queued">Queued</option>
              <option value="held">Held</option>
              <option value="processing">Processing</option>
              <option value="sent">Sent</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </>
        }
      />

      {query.isLoading ? (
        <div className="stack">
          {[0, 1, 2, 3, 4].map((index) => (
            <Skeleton key={index} height={72} />
          ))}
        </div>
      ) : jobs.length === 0 ? (
        <Card>
          <EmptyState
            icon={<HistoryIcon />}
            title="Nothing here yet"
            body={
              search || status
                ? 'No jobs match those filters.'
                : 'Once something is printed or scanned, it will appear here.'
            }
          />
        </Card>
      ) : (
        <div className="stack" style={{ gap: 'var(--space-2)' }}>
          {/* `layout` went with framer-motion. It animated rows sliding to new
              positions when the list reordered, which on an append-only job
              history happens only when a page is prepended — a case the
              entrance animation already covers. It was not worth 115 kB. */}
          <div className="kp-stagger stack" style={{ gap: 'var(--space-2)' }}>
            {jobs.map((job, index) => (
              <div key={job.id} style={{ '--kp-index': index } as CSSProperties}>
                <JobRow job={job} />
              </div>
            ))}
          </div>

          {query.hasNextPage ? (
            <Button
              variant="secondary"
              block
              loading={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
              style={{ marginTop: 'var(--space-3)' }}
            >
              Load more
            </Button>
          ) : (
            <p
              className="dim"
              style={{ textAlign: 'center', fontSize: 'var(--text-xs)', padding: 'var(--space-4)' }}
            >
              That is everything.
            </p>
          )}
        </div>
      )}
    </>
  );
}

const STATUS_TONE: Record<
  JobStatus,
  'default' | 'accent' | 'info' | 'online' | 'degraded' | 'offline'
> = {
  queued: 'info',
  held: 'accent',
  processing: 'info',
  sent: 'online',
  completed: 'online',
  failed: 'offline',
  cancelled: 'default',
};

function JobRow({ job }: { job: Job }): ReactElement {
  const queryClient = useQueryClient();
  const toast = useToast();

  const act = useMutation({
    mutationFn: (action: 'release' | 'retry' | 'cancel') => api.post(`/jobs/${job.id}/${action}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
      toast.push({ tone: 'success', title: 'Done' });
    },
    onError: (error) =>
      toast.push({
        tone: 'error',
        title: 'Could not do that',
        body: error instanceof ApiError ? error.message : 'Something went wrong.',
      }),
  });

  const isWalkup = job.source === 'walkup';
  const impressions = job.impressions ?? job.pages * job.copies;

  return (
    <Card>
      <div
        className="card__body row row--wrap"
        style={{ gap: 'var(--space-4)', padding: 'var(--space-4) var(--space-5)' }}
      >
        <div style={{ minWidth: 0, flex: '1 1 260px' }}>
          <div className="row" style={{ gap: 'var(--space-2)' }}>
            <span className="truncate" style={{ fontWeight: 700 }}>
              {job.documentName ?? (isWalkup ? 'Activity at the device' : 'Untitled')}
            </span>
            {job.pageCountEstimated ? (
              <span title="The page count for this job is an estimate, not a parsed figure.">
                <Badge>estimated</Badge>
              </span>
            ) : null}
          </div>
          <div className="dim truncate" style={{ fontSize: 'var(--text-xs)' }}>
            {job.printerNameSnapshot} · {job.usernameSnapshot} ·{' '}
            {new Date(job.createdAt).toLocaleString()}
          </div>
        </div>

        <div style={{ flex: '0 0 auto', textAlign: 'right', minWidth: 92 }}>
          <div style={{ fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
            {impressions.toLocaleString()}
          </div>
          <div className="dim" style={{ fontSize: 'var(--text-2xs)' }}>
            {impressions === 1 ? 'page' : 'pages'}
          </div>
        </div>

        <div className="row row--wrap" style={{ gap: 'var(--space-2)', flex: '0 0 auto' }}>
          {/* DEC-06 — an untyped walk-up row is device activity, and calling it
              anything else would overstate what the club printed. */}
          {isWalkup && job.jobType === 'unknown' ? (
            <span title="This device has no vendor counter, so prints and photocopies cannot be told apart.">
              <Badge>device activity</Badge>
            </span>
          ) : isWalkup ? (
            <Badge>at the device · {job.jobType}</Badge>
          ) : null}

          {job.transportUsed ? <Badge tone="info">{job.transportUsed}</Badge> : null}
          <Badge tone={STATUS_TONE[job.status]}>{job.status}</Badge>
        </div>

        <div className="row" style={{ gap: 'var(--space-2)', flex: '0 0 auto' }}>
          {job.status === 'held' ? (
            <Button
              variant="accent"
              size="sm"
              loading={act.isPending}
              onClick={() => act.mutate('release')}
            >
              Release
            </Button>
          ) : null}
          {job.status === 'failed' ? (
            <Button
              variant="secondary"
              size="sm"
              loading={act.isPending}
              onClick={() => act.mutate('retry')}
            >
              Retry
            </Button>
          ) : null}
          {job.status === 'queued' || job.status === 'held' ? (
            <Button
              variant="ghost"
              size="sm"
              loading={act.isPending}
              onClick={() => act.mutate('cancel')}
            >
              Cancel
            </Button>
          ) : null}
        </div>
      </div>

      {job.status === 'failed' && job.notes ? (
        <div
          style={{
            padding: 'var(--space-3) var(--space-5)',
            borderTop: '1px solid var(--border-subtle)',
            fontSize: 'var(--text-xs)',
            color: 'var(--text-secondary)',
            background: 'var(--surface-inset)',
          }}
        >
          {job.notes}
        </div>
      ) : job.printOptions && Object.keys(job.printOptions).length > 0 ? (
        <div
          style={{
            padding: 'var(--space-2) var(--space-5)',
            borderTop: '1px solid var(--border-subtle)',
            fontSize: 'var(--text-2xs)',
            color: 'var(--text-tertiary)',
          }}
        >
          {describePrintOptions(job.printOptions)}
        </div>
      ) : null}
    </Card>
  );
}
