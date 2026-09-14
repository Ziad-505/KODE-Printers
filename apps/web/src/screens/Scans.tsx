import type { CSSProperties, ReactElement } from 'react';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatBytes, type Paginated, type Printer, type Scan } from '@kode/shared';
import { api, ApiError, qs } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import {
  Badge,
  Button,
  Card,
  CheckIcon,
  EmptyState,
  Modal,
  Note,
  PageHeader,
  ScanIcon,
  Segmented,
  Skeleton,
  useToast,
} from '../components/ui.js';

/**
 * The scan hub.
 *
 * §B9 describes detection only — a watcher observes a folder and logs what
 * arrives. This screen is what makes that useful to a person: an inbox where a
 * scan is previewed in place, claimed, and downloaded.
 *
 * The design problem is ownership. A file dropped into an SMB share by printer
 * firmware carries no identity, so scans start unclaimed and visible to anyone
 * permitted to use that device — which mirrors the physical reality of paper
 * sitting in an output tray. Scan-to-me is the fix: reserve the printer before
 * walking over, and the next arrival is filed to you automatically.
 */
export function Scans(): ReactElement {
  const { isAdmin, user } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [scope, setScope] = useState<'unclaimed' | 'mine' | 'all'>('unclaimed');
  const [preview, setPreview] = useState<Scan | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['scans', scope],
    queryFn: () =>
      api.get<Paginated<Scan>>(
        `/scans${qs({
          limit: 60,
          ...(scope === 'unclaimed' ? { status: 'unclaimed' } : {}),
          ...(scope === 'mine' ? { mine: true } : {}),
        })}`,
      ),
    refetchInterval: 30_000,
  });

  const { data: printers } = useQuery({
    queryKey: ['printers', 'scan-capable'],
    queryFn: () => api.get<Paginated<Printer>>('/printers?limit=200'),
    staleTime: 5 * 60_000,
  });

  const scanCapable = printers?.items.filter((printer) => printer.scanFolder) ?? [];

  const claim = useMutation({
    mutationFn: (scanId: number) => api.post(`/scans/${scanId}/claim`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['scans'] });
      toast.push({ tone: 'success', title: 'Claimed', body: 'That scan is now yours.' });
    },
    onError: (error) =>
      toast.push({
        tone: 'error',
        title: 'Could not claim that',
        body: error instanceof ApiError ? error.message : 'Something went wrong.',
      }),
  });

  const reserve = useMutation({
    mutationFn: (printerId: number) =>
      api.post<{ message: string }>('/scans/reserve', { printerId }),
    onSuccess: (result) => toast.push({ tone: 'success', title: 'Reserved', body: result.message }),
    onError: (error) =>
      toast.push({
        tone: 'warning',
        title: 'Could not reserve',
        body: error instanceof ApiError ? error.message : 'Something went wrong.',
      }),
  });

  const scans = data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Scan inbox"
        subtitle="Scans arriving from club printers. Claim one to keep it."
        actions={
          <div style={{ minWidth: 260 }}>
            <Segmented
              label="Which scans"
              value={scope}
              onChange={setScope}
              options={[
                { value: 'unclaimed', label: 'Waiting' },
                { value: 'mine', label: 'Mine' },
                ...(isAdmin ? [{ value: 'all' as const, label: 'All' }] : []),
              ]}
            />
          </div>
        }
      />

      {scanCapable.length > 0 ? (
        <Card style={{ marginBottom: 'var(--space-5)' }}>
          <div className="card__body">
            <div className="kode-eyebrow" style={{ marginBottom: 'var(--space-3)' }}>
              About to scan something?
            </div>
            <p
              className="muted"
              style={{ fontSize: 'var(--text-sm)', marginBottom: 'var(--space-4)' }}
            >
              Reserve a printer and the next scan from it lands straight in your inbox instead of
              waiting to be claimed.
            </p>
            <div className="row row--wrap" style={{ gap: 'var(--space-2)' }}>
              {scanCapable.map((printer) => (
                <Button
                  key={printer.id}
                  variant="secondary"
                  size="sm"
                  icon={<ScanIcon />}
                  loading={reserve.isPending && reserve.variables === printer.id}
                  onClick={() => reserve.mutate(printer.id)}
                >
                  {printer.name}
                </Button>
              ))}
            </div>
          </div>
        </Card>
      ) : (
        <div style={{ marginBottom: 'var(--space-5)' }}>
          <Note>
            No printer available to you is set up for scan tracking. Scan-to-folder has to be
            configured on the device itself, once, by an administrator — devices that only support
            scan-to-USB or scan-to-email cannot be tracked at all.
          </Note>
        </div>
      )}

      {isLoading ? (
        <div className="grid-cards">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} height={150} />
          ))}
        </div>
      ) : scans.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ScanIcon />}
            title={scope === 'mine' ? 'You have no scans yet' : 'Nothing waiting'}
            body={
              scope === 'mine'
                ? 'Scans you claim will collect here.'
                : 'When someone scans at a tracked printer, it will appear here within a few seconds.'
            }
          />
        </Card>
      ) : (
        <div className="grid-cards">
          {scans.map((scan, index) => (
            <div key={scan.id} style={{ '--kp-index': index } as CSSProperties}>
              <ScanCard
                scan={scan}
                isMine={scan.userId === user?.id}
                onPreview={() => setPreview(scan)}
                onClaim={() => claim.mutate(scan.id)}
                claiming={claim.isPending && claim.variables === scan.id}
              />
            </div>
          ))}
        </div>
      )}

      <Modal
        open={preview !== null}
        onClose={() => setPreview(null)}
        title={preview?.originalFilename ?? 'Scan'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPreview(null)}>
              Close
            </Button>
            {preview ? (
              <a
                className="btn btn--primary"
                href={`/api/scans/${preview.id}/file`}
                download={preview.originalFilename}
              >
                Download
              </a>
            ) : null}
          </>
        }
      >
        {preview ? (
          preview.contentType === 'application/pdf' ? (
            // The server sends this inline with a locked-down CSP, so the
            // preview stays on our origin rather than pushing people through a
            // download and an external viewer.
            <object
              data={`/api/scans/${preview.id}/file`}
              type="application/pdf"
              style={{ width: '100%', height: '58vh', borderRadius: 'var(--radius-md)' }}
              aria-label={`Preview of ${preview.originalFilename}`}
            >
              <p className="muted">
                Your browser cannot preview PDFs inline. Use Download to open it.
              </p>
            </object>
          ) : (
            <img
              src={`/api/scans/${preview.id}/file`}
              alt={preview.originalFilename}
              style={{ width: '100%', borderRadius: 'var(--radius-md)' }}
            />
          )
        ) : null}
      </Modal>
    </>
  );
}

function ScanCard({
  scan,
  isMine,
  onPreview,
  onClaim,
  claiming,
}: {
  scan: Scan;
  isMine: boolean;
  onPreview: () => void;
  onClaim: () => void;
  claiming: boolean;
}): ReactElement {
  return (
    <Card interactive>
      <div className="card__body stack" style={{ gap: 'var(--space-3)' }}>
        <div className="row row--between" style={{ alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0 }}>
            <div className="truncate" style={{ fontWeight: 700 }}>
              {scan.originalFilename}
            </div>
            <div className="dim truncate" style={{ fontSize: 'var(--text-xs)' }}>
              {scan.printerNameSnapshot} · {new Date(scan.scannedAt).toLocaleString()}
            </div>
          </div>
          {scan.status === 'unclaimed' ? (
            <Badge tone="accent">waiting</Badge>
          ) : isMine ? (
            <Badge tone="online">yours</Badge>
          ) : (
            <Badge>{scan.usernameSnapshot}</Badge>
          )}
        </div>

        <div className="dim" style={{ fontSize: 'var(--text-xs)' }}>
          {formatBytes(scan.sizeBytes)}
          {scan.pageCount ? ` · ${scan.pageCount} page${scan.pageCount === 1 ? '' : 's'}` : ''}
          {scan.claimedVia === 'reservation' ? ' · claimed automatically' : ''}
        </div>

        <div className="row" style={{ gap: 'var(--space-2)' }}>
          <Button variant="secondary" size="sm" onClick={onPreview}>
            Preview
          </Button>
          {scan.status === 'unclaimed' ? (
            <Button
              variant="primary"
              size="sm"
              icon={<CheckIcon />}
              loading={claiming}
              onClick={onClaim}
            >
              This is mine
            </Button>
          ) : (
            <a
              className="btn btn--ghost btn--sm"
              href={`/api/scans/${scan.id}/file`}
              download={scan.originalFilename}
            >
              Download
            </a>
          )}
        </div>
      </div>
    </Card>
  );
}
