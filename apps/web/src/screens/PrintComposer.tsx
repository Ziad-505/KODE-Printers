import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  computeImpressions,
  computeSheets,
  DEFAULT_PRINT_OPTIONS,
  formatBytes,
  parsePageRanges,
  type AppSettings,
  type Paginated,
  type Printer,
  type PrintOptions,
  type PrintTemplate,
} from '@kode/shared';
import { api, ApiError } from '../lib/api.js';
import { printerCondition } from '../lib/plain.js';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Modal,
  Note,
  PageHeader,
  PrintIcon,
  Segmented,
  Skeleton,
  StatusBadge,
  Switch,
  UploadIcon,
  useToast,
} from '../components/ui.js';

/**
 * The print composer — the screen this system exists for.
 *
 * Three decisions shape it:
 *
 *   1. **The printer is chosen first, the file second.** Options depend on what
 *      the device can actually do, and offering duplex before knowing whether
 *      the printer supports it means either lying or re-rendering the form.
 *
 *   2. **Unverified options are disabled, not hidden.** §B7.3 is blunt: showing
 *      a duplex toggle that silently does nothing is worse than not showing it.
 *      So where the capability probe returned nothing, the control is disabled
 *      with an explanation rather than quietly absent — which also tells an
 *      admin that device needs a probe.
 *
 *   3. **The impression count is live and prominent.** It is the number the
 *      printer will actually mark, and seeing "312 pages" before pressing Print
 *      is what stops the whole staff handbook coming out of the reception
 *      printer.
 */
export function PrintComposer(): ReactElement {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [options, setOptions] = useState<PrintOptions>(DEFAULT_PRINT_OPTIONS);
  const [pageRangeText, setPageRangeText] = useState('');
  const [confirmLarge, setConfirmLarge] = useState<{ impressions: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const printerId = Number(searchParams.get('printer') ?? 0) || null;

  const { data: printers, isLoading: printersLoading } = useQuery({
    queryKey: ['printers', 'list'],
    queryFn: () => api.get<Paginated<Printer>>('/printers?limit=200'),
  });

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<AppSettings>('/settings'),
    staleTime: 5 * 60_000,
  });

  const { data: templates } = useQuery({
    queryKey: ['templates'],
    queryFn: () => api.get<PrintTemplate[]>('/templates'),
    staleTime: 5 * 60_000,
  });

  const selected = useMemo(
    () => printers?.items.find((printer) => printer.id === printerId) ?? null,
    [printers, printerId],
  );

  // Arriving from a QR sticker with ?printer=N and nothing selected yet is the
  // common case; a single permitted printer is also worth pre-selecting rather
  // than asking a question with one answer.
  useEffect(() => {
    if (printerId || !printers) return;
    if (printers.items.length === 1 && printers.items[0]) {
      setSearchParams({ printer: String(printers.items[0].id) }, { replace: true });
    }
  }, [printerId, printers, setSearchParams]);

  const capabilities = selected?.capabilities;
  const probed = capabilities?.probedVia !== 'none' && capabilities?.probedVia !== undefined;

  const supportsDuplex = !probed || (capabilities?.sides.length ?? 0) > 1;
  const supportsColor = !probed || (capabilities?.colorModes.includes('color') ?? false);

  /* ── the live impression figure ───────────────────────────────────────── */

  const estimatedPages = useEstimatedPages(file);
  const selectedPageCount = useMemo(() => {
    if (options.pageRanges.length === 0) return estimatedPages;
    const count = options.pageRanges.reduce(
      (total, [from, to]) => total + Math.max(0, Math.min(to, estimatedPages) - from + 1),
      0,
    );
    return count > 0 ? count : estimatedPages;
  }, [options.pageRanges, estimatedPages]);

  const impressions = computeImpressions({
    pages: selectedPageCount,
    copies: options.copies,
    sides: options.sides,
  });
  const sheets = computeSheets({
    pages: selectedPageCount,
    copies: options.copies,
    sides: options.sides,
  });

  const warnAt = settings?.largeJobWarnImpressions ?? 100;
  const ceiling = selected?.maxJobImpressions ?? settings?.maxJobImpressions ?? 2000;
  const overCeiling = impressions > ceiling;

  /* ── submission ───────────────────────────────────────────────────────── */

  const submit = useMutation({
    mutationFn: async (input: { confirmLargeJob: boolean }) => {
      if (!file || !selected) throw new Error('Choose a printer and a file first.');
      const form = new FormData();
      form.append('file', file);
      form.append('options', JSON.stringify(options));
      form.append('confirmLargeJob', String(input.confirmLargeJob));
      return api.upload<{ jobId: number; status: string; message: string }>(
        `/printers/${selected.id}/print-file`,
        form,
      );
    },
    onSuccess: (result) => {
      toast.push({
        tone: 'success',
        title: result.status === 'held' ? 'Held for release' : 'Sent to the queue',
        body: result.message,
      });
      setFile(null);
      setConfirmLarge(null);
      setOptions((current) => ({ ...current, pageRanges: [] }));
      setPageRangeText('');
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (error) => {
      // The server asks for confirmation rather than refusing when a job is
      // merely large. That is a dialog, not an error message.
      if (error instanceof ApiError && error.needsConfirmation) {
        setConfirmLarge({ impressions: Number(error.details?.['impressions'] ?? impressions) });
        return;
      }
      toast.push({
        tone: 'error',
        title: 'Could not send that',
        body: error instanceof ApiError ? error.message : 'Something went wrong.',
      });
    },
  });

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files[0];
    if (dropped) setFile(dropped);
  }, []);

  const ready = Boolean(file && selected && !overCeiling && !selected.isDraining);

  return (
    <>
      <PageHeader
        title="Send something to a printer"
        subtitle="Upload a document, choose how it should come out, and it goes straight to the device."
      />

      <div className="split">
        {/* ── left: file and printer ─────────────────────────────────────── */}
        <div className="stack">
          <Card>
            <div className="card__header">
              <h2 className="card__title">1 · Choose a printer</h2>
              {selected ? (
                <StatusBadge status={selected.status} label={printerCondition(selected).text} />
              ) : null}
            </div>
            <div className="card__body">
              {printersLoading ? (
                <div className="stack">
                  <Skeleton height={64} />
                  <Skeleton height={64} />
                </div>
              ) : !printers?.items.length ? (
                <EmptyState
                  title="No printers available to you"
                  body="An administrator needs to grant you access to at least one printer before you can print."
                />
              ) : (
                <PrinterPicker
                  printers={printers.items}
                  selectedId={printerId}
                  onSelect={(id) => setSearchParams({ printer: String(id) }, { replace: true })}
                />
              )}
            </div>
          </Card>

          <Card>
            <div className="card__header">
              <h2 className="card__title">2 · Add your document</h2>
              {file ? (
                <Button variant="ghost" size="sm" onClick={() => setFile(null)}>
                  Remove
                </Button>
              ) : null}
            </div>
            <div className="card__body">
              {file ? (
                <div
                  key="file"
                  className="row kp-rise"
                  style={{
                    gap: 'var(--space-4)',
                    padding: 'var(--space-4)',
                    background: 'var(--surface-inset)',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--border-default)',
                  }}
                >
                  <div
                    style={{
                      display: 'grid',
                      placeItems: 'center',
                      width: 44,
                      height: 44,
                      borderRadius: 'var(--radius-md)',
                      background: 'var(--kode-blue)',
                      color: '#fff',
                      fontSize: 10,
                      fontWeight: 800,
                      letterSpacing: '0.04em',
                      flexShrink: 0,
                    }}
                  >
                    {(file.name.split('.').pop() ?? '?').slice(0, 4).toUpperCase()}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div className="truncate" style={{ fontWeight: 600 }}>
                      {file.name}
                    </div>
                    <div className="dim" style={{ fontSize: 'var(--text-xs)' }}>
                      {formatBytes(file.size)}
                      {estimatedPages > 0
                        ? ` · about ${estimatedPages} page${estimatedPages === 1 ? '' : 's'}`
                        : ''}
                    </div>
                  </div>
                </div>
              ) : (
                <div
                  key="drop"
                  className={`dropzone kp-fade${dragging ? ' dropzone--active' : ''}`}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={onDrop}
                  onClick={() => inputRef.current?.click()}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click();
                  }}
                >
                  <span style={{ color: 'var(--kode-blue-bright)' }}>
                    <UploadIcon />
                  </span>
                  <div style={{ fontWeight: 700 }}>Drop a file here, or tap to browse</div>
                  <div className="dim" style={{ fontSize: 'var(--text-xs)', maxWidth: '38ch' }}>
                    PDF, Word, Excel, PowerPoint, images and plain text. Office files are converted
                    for you.
                  </div>
                  <input
                    ref={inputRef}
                    type="file"
                    className="kode-visually-hidden"
                    accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.rtf,.csv,.txt,.png,.jpg,.jpeg"
                    onChange={(event) => {
                      const chosen = event.target.files?.[0];
                      if (chosen) setFile(chosen);
                    }}
                  />
                </div>
              )}

              {templates && templates.length > 0 && !file ? (
                <div style={{ marginTop: 'var(--space-5)' }}>
                  <div className="kode-eyebrow" style={{ marginBottom: 'var(--space-3)' }}>
                    Or print something the club uses often
                  </div>
                  <div className="row row--wrap" style={{ gap: 'var(--space-2)' }}>
                    {templates.slice(0, 6).map((template) => (
                      <TemplateChip
                        key={template.id}
                        template={template}
                        disabled={!selected}
                        printerId={selected?.id ?? null}
                      />
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </Card>
        </div>

        {/* ── right: options and the send button ─────────────────────────── */}
        <div className="stack" style={{ position: 'sticky', top: 'var(--space-5)' }}>
          <Card>
            <div className="card__header">
              <h2 className="card__title">3 · How should it print?</h2>
            </div>
            <div className="card__body stack" style={{ gap: 'var(--space-5)' }}>
              {selected && !probed ? (
                <Note>
                  This printer has not been probed, so its exact capabilities are unknown. Options
                  below are offered but may not take effect — ask an administrator to run a
                  capability probe.
                </Note>
              ) : null}

              <Field label="Copies">
                {(id) => (
                  <Input
                    id={id}
                    type="number"
                    min={1}
                    max={capabilities?.maxCopies ?? 999}
                    value={options.copies}
                    onChange={(event) =>
                      setOptions((current) => ({
                        ...current,
                        copies: Math.max(1, Number(event.target.value) || 1),
                      }))
                    }
                  />
                )}
              </Field>

              <div className="field">
                <span className="field__label">Colour</span>
                <Segmented
                  label="Colour mode"
                  value={options.colorMode}
                  onChange={(colorMode) => setOptions((current) => ({ ...current, colorMode }))}
                  options={[
                    { value: 'grayscale', label: 'Black & white' },
                    {
                      value: 'color',
                      label: 'Colour',
                      ...(supportsColor
                        ? {}
                        : { unavailable: 'This printer does not report colour support.' }),
                    },
                  ]}
                />
                {options.colorMode === 'color' ? (
                  <span className="field__hint">
                    Colour costs roughly ten times as much per page.
                  </span>
                ) : null}
              </div>

              <div className="field">
                <span className="field__label">Sides</span>
                <Segmented
                  label="Sides"
                  value={options.sides}
                  onChange={(sides) => setOptions((current) => ({ ...current, sides }))}
                  options={[
                    { value: 'one-sided', label: 'Single' },
                    {
                      value: 'two-sided-long-edge',
                      label: 'Double',
                      ...(supportsDuplex
                        ? {}
                        : { unavailable: 'This printer does not report duplex support.' }),
                    },
                  ]}
                />
              </div>

              <Field label="Pages" hint="Leave blank for the whole document. e.g. 1-3, 7, 11-12">
                {(id) => (
                  <Input
                    id={id}
                    value={pageRangeText}
                    placeholder="All pages"
                    onChange={(event) => {
                      setPageRangeText(event.target.value);
                      setOptions((current) => ({
                        ...current,
                        pageRanges: parsePageRanges(event.target.value),
                      }));
                    }}
                  />
                )}
              </Field>

              <Switch
                checked={options.watermark}
                onChange={(watermark) => setOptions((current) => ({ ...current, watermark }))}
                label="Stamp my name and the time"
                hint="Adds a small footer to every page. For confidential documents."
              />

              <Switch
                checked={options.holdForRelease}
                onChange={(holdForRelease) =>
                  setOptions((current) => ({ ...current, holdForRelease }))
                }
                label="Hold until I'm at the printer"
                hint="Nothing prints until you release it from your phone."
              />
            </div>
          </Card>

          {/* The number that stops accidents. */}
          <Card>
            <div className="card__body">
              <div className="row row--between" style={{ alignItems: 'flex-start' }}>
                <div>
                  <div className="kode-eyebrow">This will print</div>
                  <div
                    style={{
                      fontFamily: 'var(--font-display)',
                      fontSize: 'var(--text-3xl)',
                      fontWeight: 900,
                      letterSpacing: '-0.03em',
                      lineHeight: 1.05,
                      marginTop: 'var(--space-2)',
                      color: overCeiling
                        ? 'var(--status-offline)'
                        : impressions > warnAt
                          ? 'var(--kode-gold)'
                          : 'var(--text-primary)',
                    }}
                  >
                    {impressions.toLocaleString()}
                  </div>
                  <div className="dim" style={{ fontSize: 'var(--text-xs)' }}>
                    {impressions === 1 ? 'page' : 'pages'} · {sheets.toLocaleString()}{' '}
                    {sheets === 1 ? 'sheet' : 'sheets'} of paper
                  </div>
                </div>
                {options.sides !== 'one-sided' && sheets < impressions ? (
                  <Badge tone="online">saves {impressions - sheets} sheets</Badge>
                ) : null}
              </div>

              {overCeiling ? (
                <div style={{ marginTop: 'var(--space-4)' }}>
                  <Note severity="critical">
                    This is above the {ceiling.toLocaleString()}-page limit for{' '}
                    {selected?.name ?? 'this printer'}. Narrow the page range, reduce the copies, or
                    ask an administrator to raise the limit.
                  </Note>
                </div>
              ) : null}

              {selected?.isDraining ? (
                <div style={{ marginTop: 'var(--space-4)' }}>
                  <Note severity="critical">
                    {selected.name} is in maintenance and is not accepting new jobs.
                  </Note>
                </div>
              ) : null}

              <Button
                variant="accent"
                size="lg"
                block
                icon={<PrintIcon />}
                style={{ marginTop: 'var(--space-5)' }}
                disabled={!ready}
                loading={submit.isPending}
                onClick={() => submit.mutate({ confirmLargeJob: false })}
              >
                {options.holdForRelease ? 'Hold at the printer' : 'Print'}
              </Button>

              {!file ? (
                <p
                  className="dim"
                  style={{
                    marginTop: 'var(--space-3)',
                    fontSize: 'var(--text-xs)',
                    textAlign: 'center',
                  }}
                >
                  Add a document to continue.
                </p>
              ) : null}
            </div>
          </Card>
        </div>
      </div>

      {/* Large-job confirmation. Not an error — a speed bump. */}
      <Modal
        open={confirmLarge !== null}
        onClose={() => setConfirmLarge(null)}
        title="That is a large job"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmLarge(null)}>
              Cancel
            </Button>
            <Button
              variant="accent"
              loading={submit.isPending}
              onClick={() => submit.mutate({ confirmLargeJob: true })}
            >
              Yes, print {confirmLarge?.impressions.toLocaleString()} pages
            </Button>
          </>
        }
      >
        <p>
          This will print <strong>{confirmLarge?.impressions.toLocaleString()} pages</strong> on{' '}
          <strong>{selected?.name}</strong>.
        </p>
        <p className="muted" style={{ marginTop: 'var(--space-3)' }}>
          That is more than the club normally sends in one go. If you meant to print only part of
          the document, close this and set a page range.
        </p>
      </Modal>
    </>
  );
}

/* ─────────────────────────────────────────────────────────── printer picker ── */

function PrinterPicker({
  printers,
  selectedId,
  onSelect,
}: {
  printers: readonly Printer[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}): ReactElement {
  // Grouped by zone, because "which printer is near me" is the question being
  // answered and a flat list of fifty names answers nothing.
  const byZone = useMemo(() => {
    const groups = new Map<string, Printer[]>();
    for (const printer of printers) {
      const key = printer.zoneLabel ?? 'Unassigned';
      const bucket = groups.get(key);
      if (bucket) bucket.push(printer);
      else groups.set(key, [printer]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [printers]);

  return (
    <div className="stack" style={{ gap: 'var(--space-5)' }}>
      {byZone.map(([zone, group]) => (
        <div key={zone}>
          <div className="kode-eyebrow" style={{ marginBottom: 'var(--space-3)' }}>
            {zone}
          </div>
          <div className="stack" style={{ gap: 'var(--space-2)' }}>
            {group.map((printer) => {
              const active = printer.id === selectedId;
              const unavailable = printer.status === 'offline' || printer.isDraining;
              return (
                <button
                  key={printer.id}
                  type="button"
                  onClick={() => onSelect(printer.id)}
                  aria-pressed={active}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-4)',
                    width: '100%',
                    textAlign: 'left',
                    padding: 'var(--space-3) var(--space-4)',
                    borderRadius: 'var(--radius-md)',
                    border: `1px solid ${active ? 'var(--kode-blue-bright)' : 'var(--border-subtle)'}`,
                    background: active
                      ? 'color-mix(in srgb, var(--kode-blue) 12%, transparent)'
                      : 'var(--surface-2)',
                    opacity: unavailable ? 0.6 : 1,
                    transition: 'all var(--duration-fast) var(--ease-out)',
                  }}
                >
                  <StatusBadge status={printer.status} label={printerCondition(printer).text} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="truncate" style={{ fontWeight: 700 }}>
                      {printer.name}
                    </div>
                    <div className="dim truncate" style={{ fontSize: 'var(--text-xs)' }}>
                      {[printer.area, printer.model].filter(Boolean).join(' · ') ||
                        printer.ipAddress}
                    </div>
                  </div>
                  {printer.isDraining ? <Badge tone="degraded">maintenance</Badge> : null}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function TemplateChip({
  template,
  printerId,
  disabled,
}: {
  template: PrintTemplate;
  printerId: number | null;
  disabled: boolean;
}): ReactElement {
  const toast = useToast();
  const print = useMutation({
    mutationFn: () => api.post(`/templates/${template.id}/print`, { printerId, options: {} }),
    onSuccess: () =>
      toast.push({ tone: 'success', title: 'Queued', body: `${template.name} is on its way.` }),
    onError: (error) =>
      toast.push({
        tone: 'error',
        title: 'Could not print that',
        body: error instanceof ApiError ? error.message : 'Something went wrong.',
      }),
  });

  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={disabled || print.isPending}
      loading={print.isPending}
      onClick={() => print.mutate()}
      title={template.description ?? undefined}
    >
      {template.name}
      {template.pageCount ? (
        <span className="dim" style={{ fontWeight: 500 }}>
          {template.pageCount}p
        </span>
      ) : null}
    </Button>
  );
}

/**
 * A rough page count for the live figure, before the file reaches the server.
 *
 * PDFs are counted properly by scanning for page objects. Everything else gets
 * a size heuristic, and both are deliberately *under*-estimates: the number
 * shown here only drives the warning, and the server recomputes it from the
 * converted document before anything is sent. Over-estimating would nag people
 * about jobs that are fine.
 */
function useEstimatedPages(file: File | null): number {
  const [pages, setPages] = useState(0);

  useEffect(() => {
    if (!file) {
      setPages(0);
      return;
    }

    let cancelled = false;

    void (async () => {
      if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        try {
          const buffer = await file.slice(0, 4 * 1024 * 1024).arrayBuffer();
          const text = new TextDecoder('latin1').decode(buffer);
          const matches = text.match(/\/Type\s*\/Page[^s]/g);
          if (!cancelled) setPages(Math.max(1, matches?.length ?? 1));
        } catch {
          if (!cancelled) setPages(1);
        }
        return;
      }

      if (/\.(png|jpe?g)$/i.test(file.name)) {
        if (!cancelled) setPages(1);
        return;
      }

      if (!cancelled) setPages(Math.max(1, Math.round(file.size / 3072)));
    })();

    return () => {
      cancelled = true;
    };
  }, [file]);

  return pages;
}
