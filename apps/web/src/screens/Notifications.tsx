import type { CSSProperties, ReactElement } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDuration, type Notification, type Paginated } from '@kode/shared';
import { api, qs } from '../lib/api.js';
import {
  Badge,
  BellIcon,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Skeleton,
} from '../components/ui.js';

/**
 * The notification centre (ADR-011).
 *
 * Persisted, with per-user read state — the delivered build kept these in an
 * in-memory FIFO, so a restart lost them and one admin marking an alert read
 * hid it from every other admin.
 *
 * Repeats collapse. A printer polled every fifteen seconds while offline would
 * otherwise produce 240 rows an hour and make this screen useless at exactly
 * the moment it matters most.
 */
export function Notifications(): ReactElement {
  const queryClient = useQueryClient();

  const query = useInfiniteQuery({
    queryKey: ['notifications', 'list'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.get<Paginated<Notification>>(`/notifications${qs({ cursor: pageParam, limit: 40 })}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const markAll = useMutation({
    mutationFn: () => api.post('/notifications/read-all'),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const markOne = useMutation({
    mutationFn: (id: number) => api.post(`/notifications/${id}/read`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const unreadCount = items.filter((item) => !item.isRead).length;

  return (
    <>
      <PageHeader
        title="Notifications"
        subtitle={unreadCount > 0 ? `${unreadCount} unread` : 'Everything is read'}
        actions={
          unreadCount > 0 ? (
            <Button
              variant="secondary"
              loading={markAll.isPending}
              onClick={() => markAll.mutate()}
            >
              Mark all read
            </Button>
          ) : undefined
        }
      />

      {query.isLoading ? (
        <div className="stack">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} height={76} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<BellIcon />}
            title="Nothing to report"
            body="Printer problems, failed jobs and finished scans will show up here."
          />
        </Card>
      ) : (
        <div className="stack" style={{ gap: 'var(--space-2)' }}>
          {items.map((notification, index) => (
            <div key={notification.id} style={{ '--kp-index': index } as CSSProperties}>
              <Card>
                <button
                  type="button"
                  className="card__body row"
                  style={{
                    gap: 'var(--space-4)',
                    width: '100%',
                    textAlign: 'left',
                    padding: 'var(--space-4) var(--space-5)',
                    alignItems: 'flex-start',
                    opacity: notification.isRead ? 0.62 : 1,
                  }}
                  onClick={() => {
                    if (!notification.isRead) markOne.mutate(notification.id);
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 3,
                      alignSelf: 'stretch',
                      borderRadius: 'var(--radius-pill)',
                      flexShrink: 0,
                      background:
                        notification.severity === 'critical'
                          ? 'var(--severity-critical)'
                          : notification.severity === 'warning'
                            ? 'var(--severity-warning)'
                            : 'var(--severity-info)',
                    }}
                  />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: notification.isRead ? 500 : 700 }}>
                      {notification.message}
                    </div>
                    <div className="dim" style={{ fontSize: 'var(--text-xs)', marginTop: 2 }}>
                      {notification.printerName ? `${notification.printerName} · ` : ''}
                      {relativeTime(notification.createdAt)}
                    </div>
                  </div>
                  {!notification.isRead ? <Badge tone="info">new</Badge> : null}
                </button>
              </Card>
            </div>
          ))}

          {query.hasNextPage ? (
            <Button
              variant="secondary"
              block
              loading={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
              style={{ marginTop: 'var(--space-3)' }}
            >
              Load older
            </Button>
          ) : null}
        </div>
      )}
    </>
  );
}

function relativeTime(iso: string): string {
  const seconds = (Date.now() - Date.parse(iso)) / 1000;
  if (seconds < 60) return 'just now';
  if (seconds < 86_400) return `${formatDuration(seconds)} ago`;
  return new Date(iso).toLocaleString();
}
