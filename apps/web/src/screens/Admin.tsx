import type { ReactElement } from 'react';
import { useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AppSettings, AuditEntry, Paginated, Printer, Zone, User } from '@kode/shared';
import { api, ApiError, qs } from '../lib/api.js';
import { printerCondition } from '../lib/plain.js';
import {
  Badge,
  Button,
  buttonClasses,
  Card,
  EmptyState,
  Field,
  Input,
  Modal,
  Note,
  PageHeader,
  Skeleton,
  StatusBadge,
  useToast,
} from '../components/ui.js';

/**
 * Administration.
 *
 * Sub-routes rather than tabs holding local state, so a link to
 * `/admin/permissions` is shareable and the back button behaves. Everything
 * here is already gated server-side; the client gate in `App.tsx` exists so a
 * non-admin never sees a door they cannot open.
 */
export function Admin(): ReactElement {
  return (
    <>
      <PageHeader title="Settings" subtitle="Printers, zones, access and the audit trail." />

      <nav
        className="row row--wrap"
        style={{ gap: 'var(--space-2)', marginBottom: 'var(--space-5)' }}
        aria-label="Admin sections"
      >
        {[
          { to: 'printers', label: 'Printers' },
          // Accounts and set-password links live on People. This tab is only
          // for changing who may use which printer after the fact, so it says
          // that rather than competing for the same name.
          { to: 'users', label: 'Printer access' },
          { to: 'zones', label: 'Zones' },
          { to: 'settings', label: 'Settings' },
          { to: 'audit', label: 'Audit log' },
        ].map((tab) => (
          <NavLink
            key={tab.to}
            to={`/admin/${tab.to}`}
            className={({ isActive }) => buttonClasses(isActive ? 'primary' : 'ghost', 'sm')}
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <Routes>
        <Route index element={<Navigate to="printers" replace />} />
        <Route path="printers" element={<AdminPrinters />} />
        <Route path="users" element={<AdminUsers />} />
        <Route path="zones" element={<AdminZones />} />
        <Route path="settings" element={<AdminSettings />} />
        <Route path="audit" element={<AdminAudit />} />
      </Routes>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════ printers ══ */

function AdminPrinters(): ReactElement {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['printers', 'admin'],
    queryFn: () => api.get<Paginated<Printer>>('/printers?limit=200&includeInactive=true'),
  });

  const { data: zones } = useQuery({
    queryKey: ['zones'],
    queryFn: () => api.get<Zone[]>('/zones'),
  });

  const mutate = useMutation({
    mutationFn: ({ id, action, body }: { id: number; action: string; body?: unknown }) =>
      action === 'probe'
        ? api.post(`/printers/${id}/probe`)
        : api.put(`/printers/${id}/${action}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['printers'] });
      toast.push({ tone: 'success', title: 'Updated' });
    },
    onError: (error) =>
      toast.push({
        tone: 'error',
        title: 'Could not update',
        body: error instanceof ApiError ? error.message : 'Something went wrong.',
      }),
  });

  return (
    <>
      <div className="row row--between" style={{ marginBottom: 'var(--space-4)' }}>
        <h2 className="section-title kode-slash" style={{ margin: 0 }}>
          Printers
        </h2>
        <Button variant="primary" onClick={() => setAdding(true)}>
          Add a printer
        </Button>
      </div>

      {isLoading ? (
        <Skeleton height={280} />
      ) : !data?.items.length ? (
        <Card>
          <EmptyState
            title="No printers yet"
            body="Add one by IP address. Serial, model and capabilities are discovered automatically."
            action={
              <Button variant="primary" onClick={() => setAdding(true)}>
                Add the first printer
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Printer</th>
                <th>Zone / area</th>
                <th>Address</th>
                <th>Transport</th>
                <th>Tracking</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {data.items.map((printer) => (
                <tr key={printer.id} style={{ opacity: printer.isActive ? 1 : 0.5 }}>
                  <td>
                    <div style={{ fontWeight: 700 }}>{printer.name}</div>
                    <div className="dim" style={{ fontSize: 'var(--text-2xs)' }}>
                      {printer.vendor} {printer.model}
                      {printer.serialNumber ? ` · ${printer.serialNumber}` : ''}
                    </div>
                  </td>
                  <td>
                    {printer.zoneLabel ?? '—'}
                    {printer.area ? <span className="dim"> · {printer.area}</span> : null}
                  </td>
                  <td className="mono">{printer.ipAddress}</td>
                  <td>
                    {printer.capabilities.ipp.supported === true ? (
                      <Badge tone="info">IPP</Badge>
                    ) : printer.capabilities.ipp.supported === false ? (
                      <Badge>RAW 9100</Badge>
                    ) : (
                      <Badge tone="degraded">not probed</Badge>
                    )}
                  </td>
                  <td>
                    {/* §B8.5 — the gap has to be visible in the one place an
                        admin would look to close it. */}
                    {printer.walkupTrackingUnavailable ? (
                      <Badge tone="degraded">walk-up off</Badge>
                    ) : (
                      <Badge tone="online">tracked</Badge>
                    )}
                  </td>
                  <td>
                    <StatusBadge status={printer.status} label={printerCondition(printer).text} />
                  </td>
                  <td>
                    <div
                      className="row"
                      style={{ gap: 'var(--space-2)', justifyContent: 'flex-end' }}
                    >
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={mutate.isPending && mutate.variables?.id === printer.id}
                        onClick={() => mutate.mutate({ id: printer.id, action: 'probe' })}
                        title="Re-read capabilities from the device"
                      >
                        Probe
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          mutate.mutate({
                            id: printer.id,
                            action: 'drain',
                            body: { isDraining: !printer.isDraining },
                          })
                        }
                        title="Finish queued jobs, accept nothing new"
                      >
                        {printer.isDraining ? 'Resume' : 'Drain'}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          mutate.mutate({
                            id: printer.id,
                            action: 'active',
                            body: { isActive: !printer.isActive },
                          })
                        }
                      >
                        {printer.isActive ? 'Disable' : 'Enable'}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AddPrinterModal open={adding} onClose={() => setAdding(false)} zones={zones ?? []} />
    </>
  );
}

function AddPrinterModal({
  open,
  onClose,
  zones,
}: {
  open: boolean;
  onClose: () => void;
  zones: readonly Zone[];
}): ReactElement {
  const queryClient = useQueryClient();
  const toast = useToast();

  const [form, setForm] = useState({
    name: '',
    ipAddress: '',
    zoneId: '',
    area: '',
    snmpCommunity: 'public',
    scanFolder: '',
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<Printer>('/printers', {
        name: form.name,
        ipAddress: form.ipAddress,
        zoneId: form.zoneId ? Number(form.zoneId) : null,
        area: form.area || null,
        snmpCommunity: form.snmpCommunity || null,
        scanFolder: form.scanFolder || null,
        probeNow: true,
      }),
    onSuccess: (printer) => {
      void queryClient.invalidateQueries({ queryKey: ['printers'] });
      toast.push({
        tone: 'success',
        title: `${printer.name} added`,
        body: 'Probing the device now — serial, model and capabilities will fill in shortly.',
      });
      setForm({
        name: '',
        ipAddress: '',
        zoneId: '',
        area: '',
        snmpCommunity: 'public',
        scanFolder: '',
      });
      onClose();
    },
    onError: (error) =>
      toast.push({
        tone: 'error',
        title: 'Could not add that printer',
        body: error instanceof ApiError ? error.message : 'Something went wrong.',
      }),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a printer"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={create.isPending}
            disabled={!form.name || !form.ipAddress}
            onClick={() => create.mutate()}
          >
            Add and probe
          </Button>
        </>
      }
    >
      <div className="stack">
        <Note>
          Only the address is required. Serial number, vendor, model, IPP support and capabilities
          are discovered from the device — you should not have to type them.
        </Note>

        <Field label="Name" hint="What staff will see. e.g. Reception MFP">
          {(id) => (
            <Input
              id={id}
              value={form.name}
              onChange={(event) => setForm((f) => ({ ...f, name: event.target.value }))}
            />
          )}
        </Field>

        <Field label="IP address" hint="Must be a private address. Give it a DHCP reservation.">
          {(id) => (
            <Input
              id={id}
              value={form.ipAddress}
              placeholder="10.20.3.14"
              inputMode="decimal"
              onChange={(event) => setForm((f) => ({ ...f, ipAddress: event.target.value }))}
            />
          )}
        </Field>

        <Field label="Zone">
          {(id) => (
            <select
              id={id}
              className="select"
              value={form.zoneId}
              onChange={(event) => setForm((f) => ({ ...f, zoneId: event.target.value }))}
            >
              <option value="">Unassigned</option>
              {zones.map((zone) => (
                <option key={zone.id} value={zone.id}>
                  {zone.label}
                </option>
              ))}
            </select>
          )}
        </Field>

        {/* No `floor` field: every KODE building is single-storey, so it would
            be a column of nulls that no report could group by. */}
        <Field label="Area" hint="Where it physically sits. e.g. Reception, Back office">
          {(id) => (
            <Input
              id={id}
              value={form.area}
              onChange={(event) => setForm((f) => ({ ...f, area: event.target.value }))}
            />
          )}
        </Field>

        <Field
          label="SNMP community"
          hint="Needed to track walk-up activity. Leave blank if SNMP is disabled on the device."
        >
          {(id) => (
            <Input
              id={id}
              type="password"
              value={form.snmpCommunity}
              onChange={(event) => setForm((f) => ({ ...f, snmpCommunity: event.target.value }))}
            />
          )}
        </Field>

        <Field
          label="Scan folder"
          hint="The share this printer writes scans into. Configure Scan to Network Folder on the device to match."
        >
          {(id) => (
            <Input
              id={id}
              value={form.scanFolder}
              placeholder="/data/scans/reception"
              onChange={(event) => setForm((f) => ({ ...f, scanFolder: event.target.value }))}
            />
          )}
        </Field>
      </div>
    </Modal>
  );
}

/* ══════════════════════════════════════════════════════════════════ users ══ */

function AdminUsers(): ReactElement {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<User | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<Paginated<User>>('/users?limit=200&includeInactive=true'),
  });

  const { data: printers } = useQuery({
    queryKey: ['printers', 'all'],
    queryFn: () => api.get<Paginated<Printer>>('/printers?limit=200'),
  });

  const setPrinters = useMutation({
    mutationFn: ({ userId, printerIds }: { userId: number; printerIds: number[] }) =>
      api.put(`/users/${userId}/printers`, { printerIds }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      toast.push({ tone: 'success', title: 'Access updated' });
      setEditing(null);
    },
    onError: (error) =>
      toast.push({
        tone: 'error',
        title: 'Could not update access',
        body: error instanceof ApiError ? error.message : 'Something went wrong.',
      }),
  });

  return (
    <>
      <h2 className="section-title kode-slash">People and printer access</h2>

      <Note>
        Printer access is granted here and nowhere else. A person&apos;s department is used for
        reporting only and never affects what they can print to.
      </Note>

      {isLoading ? (
        <Skeleton height={280} />
      ) : (
        <div className="table-wrap" style={{ marginTop: 'var(--space-4)' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Person</th>
                <th>Role</th>
                <th>Department</th>
                <th>Printers</th>
                <th>Last sign-in</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {data?.items.map((user) => (
                <tr key={user.id} style={{ opacity: user.isActive ? 1 : 0.5 }}>
                  <td>
                    <div style={{ fontWeight: 700 }}>{user.displayName ?? user.username}</div>
                    <div className="dim" style={{ fontSize: 'var(--text-2xs)' }}>
                      {user.username}
                      {user.mustChangePassword ? ' · must change password' : ''}
                    </div>
                  </td>
                  <td>
                    <Badge tone={user.role === 'admin' ? 'accent' : 'default'}>{user.role}</Badge>
                  </td>
                  <td className="dim">{user.department ?? '—'}</td>
                  <td className="table__numeric">
                    {user.role === 'admin' ? (
                      <span className="dim">all</span>
                    ) : (
                      (user.printerIds?.length ?? 0)
                    )}
                  </td>
                  <td className="dim">
                    {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleDateString() : 'never'}
                  </td>
                  <td>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={user.role === 'admin'}
                      onClick={() => setEditing(user)}
                    >
                      Edit access
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <PermissionsModal
        user={editing}
        printers={printers?.items ?? []}
        onClose={() => setEditing(null)}
        onSave={(printerIds) => {
          if (editing) setPrinters.mutate({ userId: editing.id, printerIds });
        }}
        saving={setPrinters.isPending}
      />
    </>
  );
}

function PermissionsModal({
  user,
  printers,
  onClose,
  onSave,
  saving,
}: {
  user: User | null;
  printers: readonly Printer[];
  onClose: () => void;
  onSave: (printerIds: number[]) => void;
  saving: boolean;
}): ReactElement {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [initialised, setInitialised] = useState<number | null>(null);

  // Seeded from the user's current grants when the modal opens for a new person.
  if (user && initialised !== user.id) {
    setSelected(new Set(user.printerIds ?? []));
    setInitialised(user.id);
  }

  return (
    <Modal
      open={user !== null}
      onClose={onClose}
      title={user ? `Printer access for ${user.displayName ?? user.username}` : 'Printer access'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={() => onSave([...selected])}>
            Save access
          </Button>
        </>
      }
    >
      <div className="stack" style={{ gap: 'var(--space-2)' }}>
        {printers.map((printer) => (
          <label
            key={printer.id}
            className="row"
            style={{
              gap: 'var(--space-3)',
              padding: 'var(--space-3)',
              borderRadius: 'var(--radius-md)',
              background: selected.has(printer.id)
                ? 'color-mix(in srgb, var(--kode-blue) 10%, transparent)'
                : 'var(--surface-2)',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={selected.has(printer.id)}
              onChange={(event) => {
                setSelected((current) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(printer.id);
                  else next.delete(printer.id);
                  return next;
                });
              }}
            />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{printer.name}</div>
              <div className="dim" style={{ fontSize: 'var(--text-xs)' }}>
                {[printer.zoneLabel, printer.area].filter(Boolean).join(' · ')}
              </div>
            </div>
          </label>
        ))}
      </div>
    </Modal>
  );
}

/* ══════════════════════════════════════════════════════════════════ zones ══ */

function AdminZones(): ReactElement {
  const { data, isLoading } = useQuery({
    queryKey: ['zones', 'admin'],
    queryFn: () => api.get<Zone[]>('/zones?includeInactive=true'),
  });

  return (
    <>
      <h2 className="section-title kode-slash">Zones</h2>
      <Note>
        One row per area. There is no floor field — every KODE building is single-storey, so a
        printer&apos;s <strong>area</strong> (Reception, Back office) is what actually helps someone
        find it.
      </Note>

      {isLoading ? (
        <Skeleton height={200} />
      ) : (
        <div className="grid-cards" style={{ marginTop: 'var(--space-4)' }}>
          {data?.map((zone) => (
            <Card key={zone.id}>
              <div className="card__body">
                <div className="row row--between">
                  <div>
                    <div style={{ fontWeight: 800, fontSize: 'var(--text-lg)' }}>{zone.label}</div>
                    <div className="kode-eyebrow">{zone.code}</div>
                  </div>
                  <Badge tone={zone.isActive ? 'online' : 'default'}>
                    {zone.isActive ? 'active' : 'inactive'}
                  </Badge>
                </div>
                <div
                  className="dim"
                  style={{ marginTop: 'var(--space-3)', fontSize: 'var(--text-sm)' }}
                >
                  {zone.printerCount ?? 0} printer{zone.printerCount === 1 ? '' : 's'}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════ settings ══ */

function AdminSettings(): ReactElement {
  const queryClient = useQueryClient();
  const toast = useToast();

  const { data, isLoading } = useQuery({
    queryKey: ['settings', 'admin'],
    queryFn: () => api.get<AppSettings>('/settings'),
  });

  const [draft, setDraft] = useState<Partial<AppSettings>>({});

  const save = useMutation({
    mutationFn: () => api.put<AppSettings>('/settings', draft),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      setDraft({});
      toast.push({ tone: 'success', title: 'Settings saved' });
    },
    onError: (error) =>
      toast.push({
        tone: 'error',
        title: 'Could not save',
        body: error instanceof ApiError ? error.message : 'Something went wrong.',
      }),
  });

  if (isLoading || !data) return <Skeleton height={400} />;

  const value = { ...data, ...draft };
  const dirty = Object.keys(draft).length > 0;

  const numberField = (key: keyof AppSettings, label: string, hint: string): ReactElement => (
    <Field label={label} hint={hint}>
      {(id) => (
        <Input
          id={id}
          type="number"
          value={String(value[key])}
          onChange={(event) =>
            setDraft((current) => ({ ...current, [key]: Number(event.target.value) }))
          }
        />
      )}
    </Field>
  );

  return (
    <>
      <div className="row row--between" style={{ marginBottom: 'var(--space-4)' }}>
        <h2 className="section-title kode-slash" style={{ margin: 0 }}>
          Settings
        </h2>
        <Button
          variant="primary"
          disabled={!dirty}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          Save changes
        </Button>
      </div>

      <div className="split">
        <div className="stack">
          <Card>
            <div className="card__header">
              <h3 className="card__title">Printer safety</h3>
            </div>
            <div className="card__body stack">
              {numberField(
                'maxJobImpressions',
                'Hard page limit per job',
                'Jobs above this are refused outright. A per-printer override can raise it.',
              )}
              {numberField(
                'largeJobWarnImpressions',
                'Warn above',
                'The user must confirm before a job this size is accepted.',
              )}
              {numberField(
                'maxConcurrentJobsPerPrinter',
                'Concurrent jobs per printer',
                'One is safest. Some devices interleave two jobs into one document.',
              )}
              {numberField(
                'printerCooldownSeconds',
                'Cooldown between jobs (seconds)',
                'A short gap protects older fusers on back-to-back runs.',
              )}
            </div>
          </Card>

          <Card>
            <div className="card__header">
              <h3 className="card__title">Retention</h3>
            </div>
            <div className="card__body stack">
              <Note>
                These govern uploaded <em>files</em> only. Job records are kept for reporting and
                audit regardless — a purged job keeps its user, printer, page count and cost, it
                just can no longer be reprinted from the original.
              </Note>
              {numberField(
                'uploadRetentionDays',
                'Keep uploaded documents (days)',
                'Zero deletes the original as soon as it prints successfully.',
              )}
              {numberField(
                'scanRetentionDays',
                'Keep scans (days)',
                'Scans are member documents — be generous.',
              )}
              {numberField(
                'notificationRetentionDays',
                'Keep notifications (days)',
                'Critical alerts are never purged automatically.',
              )}
            </div>
          </Card>
        </div>

        <div className="stack">
          <Card>
            <div className="card__header">
              <h3 className="card__title">Cost and reporting</h3>
            </div>
            <div className="card__body stack">
              <Field label="Currency">
                {(id) => (
                  <Input
                    id={id}
                    maxLength={3}
                    value={value.currency}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        currency: event.target.value.toUpperCase(),
                      }))
                    }
                  />
                )}
              </Field>
              <Field label="Cost per mono page">
                {(id) => (
                  <Input
                    id={id}
                    type="number"
                    step="0.0001"
                    value={String(value.costPerPageMono)}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        costPerPageMono: Number(event.target.value),
                      }))
                    }
                  />
                )}
              </Field>
              <Field label="Cost per colour page">
                {(id) => (
                  <Input
                    id={id}
                    type="number"
                    step="0.0001"
                    value={String(value.costPerPageColor)}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        costPerPageColor: Number(event.target.value),
                      }))
                    }
                  />
                )}
              </Field>

              {/* DEC-06. Changing this label away from "device activity" while
                  vendor counters are absent would overstate what the club
                  printed, so the hint says so plainly. */}
              <Field
                label="Label for walk-up totals"
                hint="Until every printer has a vendor print counter, walk-up figures include photocopies and should not be called prints."
              >
                {(id) => (
                  <Input
                    id={id}
                    value={value.walkupReportLabel}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        walkupReportLabel: event.target.value,
                      }))
                    }
                  />
                )}
              </Field>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

/* ══════════════════════════════════════════════════════════════════ audit ══ */

function AdminAudit(): ReactElement {
  const [action, setAction] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['audit', action],
    queryFn: () => api.get<Paginated<AuditEntry>>(`/audit${qs({ action, limit: 60 })}`),
  });

  const { data: actions } = useQuery({
    queryKey: ['audit', 'actions'],
    queryFn: () => api.get<string[]>('/audit/actions'),
    staleTime: 5 * 60_000,
  });

  return (
    <>
      <div className="row row--between" style={{ marginBottom: 'var(--space-4)' }}>
        <h2 className="section-title kode-slash" style={{ margin: 0 }}>
          Audit log
        </h2>
        <select
          className="select"
          style={{ width: 'auto', minWidth: 200 }}
          value={action}
          onChange={(event) => setAction(event.target.value)}
          aria-label="Filter by action"
        >
          <option value="">Every action</option>
          {actions?.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </select>
      </div>

      <Note>
        Append-only. Every administrative change is written inside the same database transaction as
        the change itself, so a recorded action definitely happened and an unrecorded one definitely
        did not.
      </Note>

      {isLoading ? (
        <Skeleton height={320} />
      ) : !data?.items.length ? (
        <Card style={{ marginTop: 'var(--space-4)' }}>
          <EmptyState title="Nothing recorded yet" />
        </Card>
      ) : (
        <div className="table-wrap" style={{ marginTop: 'var(--space-4)' }}>
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Action</th>
                <th>Entity</th>
                <th>From</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((entry) => (
                <tr key={entry.id}>
                  <td className="dim" style={{ whiteSpace: 'nowrap' }}>
                    {new Date(entry.createdAt).toLocaleString()}
                  </td>
                  <td style={{ fontWeight: 600 }}>{entry.actorUsername}</td>
                  <td>
                    <span className="mono">{entry.action}</span>
                  </td>
                  <td className="dim">
                    {entry.entityType}
                    {entry.entityId ? ` #${entry.entityId}` : ''}
                  </td>
                  <td className="dim mono">{entry.ipAddress ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
