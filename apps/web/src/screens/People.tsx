import { useState, type FormEvent, type ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Paginated, Printer, SetupLink, User } from '@kode/shared';
import { api, ApiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Modal,
  Note,
  PageHeader,
  Skeleton,
  useToast,
} from '../components/ui.js';

/**
 * People — accounts, and the links that let someone into one.
 *
 * The flow this screen exists to make ordinary: an administrator creates an
 * account, gets a single-use link, presses Copy, and sends it however they
 * already reach that person. Nobody types a password for anybody else, and no
 * password travels over WhatsApp.
 *
 * A forgotten password is deliberately the *same* three moves rather than a
 * separate feature — Make a reset link, copy, send. One mechanism, learned
 * once, and the audit log records both the same way.
 */
export function People(): ReactElement {
  const { user: me } = useAuth();
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<SetupLink | null>(null);

  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<Paginated<User>>('/users?limit=200&includeInactive=true'),
  });

  const everyone = users.data?.items ?? [];

  /* Two lists, split on whether the person can actually get in yet.
   *
   * "Waiting" is not a status the backend stores — it is the absence of a
   * password, which is exactly what `hasPassword` reports. Deriving it here
   * rather than adding a state column keeps one fact in one place. */
  const waiting = everyone.filter((person) => !person.hasPassword);
  const settled = everyone.filter((person) => person.hasPassword);

  return (
    <>
      <PageHeader
        title="People"
        subtitle="Who can sign in, and which printers they are allowed to use."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            Create an account
          </Button>
        }
      />

      {users.isPending ? (
        <Card>
          <div className="card__body stack">
            <Skeleton height={56} />
            <Skeleton height={56} />
            <Skeleton height={56} />
          </div>
        </Card>
      ) : (
        <div className="stack" style={{ gap: 'var(--space-5)' }}>
          {waiting.length > 0 ? (
            <Card>
              <div className="card__header">
                <div>
                  <div className="card__title">Waiting to set a password</div>
                  <div className="dim" style={{ fontSize: 'var(--text-sm)' }}>
                    Their account exists. Send them their link and they are in.
                  </div>
                </div>
                <Badge tone="degraded">{waiting.length}</Badge>
              </div>
              <div className="card__body stack" style={{ gap: 0 }}>
                {waiting.map((person) => (
                  <PersonRow key={person.id} person={person} onLink={setIssued} waiting />
                ))}
              </div>
            </Card>
          ) : null}

          <Card>
            <div className="card__header">
              <div>
                <div className="card__title">Everyone at the club</div>
                <div className="dim" style={{ fontSize: 'var(--text-sm)' }}>
                  Turning someone off stops them signing in straight away.
                </div>
              </div>
              <Badge>{settled.length}</Badge>
            </div>
            <div className="card__body stack" style={{ gap: 0 }}>
              {settled.map((person) => (
                <PersonRow
                  key={person.id}
                  person={person}
                  onLink={setIssued}
                  isSelf={person.id === me?.id}
                />
              ))}
            </div>
          </Card>
        </div>
      )}

      <CreateAccountModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(link) => {
          setCreating(false);
          setIssued(link);
        }}
      />

      <LinkModal
        link={issued}
        onClose={() => setIssued(null)}
        onCreateAnother={() => {
          setIssued(null);
          setCreating(true);
        }}
      />
    </>
  );
}

/* ══════════════════════════════════════════════════════════════════════ row */

function PersonRow({
  person,
  onLink,
  waiting,
  isSelf,
}: {
  person: User;
  onLink: (link: SetupLink) => void;
  waiting?: boolean | undefined;
  isSelf?: boolean | undefined;
}): ReactElement {
  const queryClient = useQueryClient();
  const toast = useToast();

  const mintLink = useMutation({
    mutationFn: (purpose: 'setup' | 'reset') =>
      api.post<SetupLink>(`/users/${person.id}/setup-link`, { purpose }),
    onSuccess: (link) => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      onLink(link);
    },
    onError: (error: ApiError) =>
      toast.push({ tone: 'error', title: 'Could not make a link', body: error.message }),
  });

  const setActive = useMutation({
    mutationFn: (isActive: boolean) => api.put(`/users/${person.id}/active`, { isActive }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (error: ApiError) =>
      toast.push({ tone: 'error', title: 'Could not change that', body: error.message }),
  });

  return (
    <div
      className="row row--between"
      style={{
        gap: 'var(--space-4)',
        padding: 'var(--space-4) 0',
        borderBottom: '1px solid var(--border-subtle)',
        opacity: person.isActive ? 1 : 0.6,
      }}
    >
      <div className="row" style={{ gap: 'var(--space-4)', minWidth: 0 }}>
        <Avatar person={person} waiting={waiting} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>
            {person.displayName ?? person.username}
            {isSelf ? (
              <span className="dim" style={{ fontWeight: 400 }}>
                {' '}
                — you
              </span>
            ) : null}
          </div>
          <div className="dim" style={{ fontSize: 'var(--text-sm)' }}>
            {describe(person)}
          </div>
        </div>
      </div>

      <div className="row row--wrap" style={{ gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
        {person.role === 'admin' ? <Badge tone="info">Administrator</Badge> : <Badge>Staff</Badge>}
        <Badge>
          {person.printerIds?.length
            ? `${person.printerIds.length} printer${person.printerIds.length === 1 ? '' : 's'}`
            : person.role === 'admin'
              ? 'Every printer'
              : 'No printers yet'}
        </Badge>

        {person.isActive ? (
          <Button
            size="sm"
            variant={waiting ? 'primary' : 'ghost'}
            loading={mintLink.isPending}
            onClick={() => mintLink.mutate(waiting ? 'setup' : 'reset')}
          >
            {waiting ? 'Get the link' : 'Make a reset link'}
          </Button>
        ) : null}

        {isSelf ? null : (
          <Button
            size="sm"
            variant="ghost"
            loading={setActive.isPending}
            onClick={() => setActive.mutate(!person.isActive)}
          >
            {person.isActive ? 'Turn off' : 'Turn back on'}
          </Button>
        )}
      </div>
    </div>
  );
}

function Avatar({
  person,
  waiting,
}: {
  person: User;
  waiting?: boolean | undefined;
}): ReactElement {
  const initials = (person.displayName ?? person.username)
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <div
      aria-hidden="true"
      style={{
        width: 40,
        height: 40,
        borderRadius: 'var(--radius-pill)',
        display: 'grid',
        placeItems: 'center',
        flexShrink: 0,
        fontSize: 'var(--text-sm)',
        fontWeight: 700,
        background: waiting
          ? 'color-mix(in srgb, var(--status-degraded) 14%, transparent)'
          : 'color-mix(in srgb, var(--kode-blue) 10%, transparent)',
        color: waiting ? 'var(--status-degraded)' : 'var(--kode-blue)',
      }}
    >
      {initials || '?'}
    </div>
  );
}

/** The one line under a name. Says the most useful thing, not every thing. */
function describe(person: User): string {
  if (!person.isActive) return 'Turned off — their history is still here';
  if (!person.hasPassword) {
    return person.setupLinkExpiresAt
      ? `Signs in as ${person.username} · link good until ${shortDate(person.setupLinkExpiresAt)}`
      : `Signs in as ${person.username} · no link out — make one`;
  }
  return person.lastLoginAt
    ? `${person.username} · last signed in ${shortDate(person.lastLoginAt)}`
    : `${person.username} · has never signed in`;
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/* ═════════════════════════════════════════════════════════════ create modal */

function CreateAccountModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (link: SetupLink) => void;
}): ReactElement {
  const queryClient = useQueryClient();
  const toast = useToast();

  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<'user' | 'admin'>('user');
  const [printerIds, setPrinterIds] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);

  const printers = useQuery({
    queryKey: ['printers', 'all'],
    queryFn: () => api.get<Paginated<Printer>>('/printers?limit=200'),
    enabled: open,
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<{ user: User; setupLink: SetupLink | null }>('/users', {
        username: username.trim().toLowerCase(),
        displayName: displayName.trim() || null,
        role,
        printerIds,
        // Deliberately no password. The server mints a link instead.
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      reset();
      if (result.setupLink) onCreated(result.setupLink);
      else toast.push({ tone: 'success', title: `${result.user.username} was created` });
    },
    onError: (caught: ApiError) => setError(caught.message),
  });

  function reset(): void {
    setDisplayName('');
    setUsername('');
    setRole('user');
    setPrinterIds([]);
    setError(null);
  }

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    setError(null);
    create.mutate();
  }

  /* A username people can actually type, suggested from the name.
   * "Sara Kamal" → "s.kamal". Only ever a suggestion — it stops filling in the
   * moment the administrator edits the field themselves. */
  function suggestUsername(name: string): void {
    setDisplayName(name);
    if (username !== '' && username !== suggestionFor(displayName)) return;
    setUsername(suggestionFor(name));
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Create an account"
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={create.isPending}
            disabled={username.trim().length < 2}
            onClick={() => create.mutate()}
          >
            Create and get a link
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit} className="stack">
        <Note>
          You will not be asked for a password. The next screen gives you a link to send them, and
          they choose their own.
        </Note>

        <Field label="Their name">
          {(id) => (
            <Input
              id={id}
              value={displayName}
              onChange={(event) => suggestUsername(event.target.value)}
              placeholder="Sara Kamal"
              autoFocus
            />
          )}
        </Field>

        <Field
          label="Username"
          hint="What they type to sign in. Letters, numbers, dots and dashes."
        >
          {(id) => (
            <Input
              id={id}
              value={username}
              onChange={(event) => setUsername(event.target.value.toLowerCase())}
              placeholder="s.kamal"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
            />
          )}
        </Field>

        <Field label="What they can do">
          {(id) => (
            <div id={id} className="row" style={{ gap: 'var(--space-2)' }}>
              <Button
                type="button"
                size="sm"
                variant={role === 'user' ? 'primary' : 'secondary'}
                onClick={() => setRole('user')}
              >
                Staff
              </Button>
              <Button
                type="button"
                size="sm"
                variant={role === 'admin' ? 'primary' : 'secondary'}
                onClick={() => setRole('admin')}
              >
                Administrator
              </Button>
            </div>
          )}
        </Field>

        {role === 'user' ? (
          <Field
            label="Printers they may use"
            hint="This is the only thing that grants access — not their department, not their building."
          >
            {(id) => (
              <div id={id} className="row row--wrap" style={{ gap: 'var(--space-2)' }}>
                {(printers.data?.items ?? []).map((printer) => {
                  const on = printerIds.includes(printer.id);
                  return (
                    <Button
                      key={printer.id}
                      type="button"
                      size="sm"
                      variant={on ? 'primary' : 'secondary'}
                      onClick={() =>
                        setPrinterIds((current) =>
                          on
                            ? current.filter((entry) => entry !== printer.id)
                            : [...current, printer.id],
                        )
                      }
                    >
                      {printer.name}
                    </Button>
                  );
                })}
                {printers.data && printers.data.items.length === 0 ? (
                  <span className="dim">No printers have been added yet.</span>
                ) : null}
              </div>
            )}
          </Field>
        ) : (
          <Note>An administrator can use every printer, so there is nothing to tick.</Note>
        )}

        {error ? <Note severity="critical">{error}</Note> : null}
      </form>
    </Modal>
  );
}

function suggestionFor(name: string): string {
  const parts = name.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return (parts[0] ?? '').replace(/[^a-z0-9._-]/g, '');
  const first = parts[0] ?? '';
  const last = parts[parts.length - 1] ?? '';
  return `${first.slice(0, 1)}.${last}`.replace(/[^a-z0-9._-]/g, '');
}

/* ═══════════════════════════════════════════════════════════════ link modal */

/**
 * The link, shown once.
 *
 * There is no route that can show it again — only its hash is stored — so this
 * dialog says so plainly rather than letting an administrator close it and
 * discover that later. Losing it is recoverable (make another) but the moment
 * to know that is now.
 */
function LinkModal({
  link,
  onClose,
  onCreateAnother,
}: {
  link: SetupLink | null;
  onClose: () => void;
  onCreateAnother: () => void;
}): ReactElement {
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  const name = link?.user.displayName ?? link?.user.username ?? 'They';
  const firstName = name.split(/\s+/)[0] ?? name;

  const message =
    link === null
      ? ''
      : link.purpose === 'reset'
        ? `Hi ${firstName}, here is a link to set a new KODE Printer password. It only works once: ${link.url}`
        : `Hi ${firstName}, your KODE Printer account is ready. Open this link to choose a password: ${link.url}`;

  async function copy(text: string, what: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.push({ tone: 'success', title: `${what} copied` });
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      /* Clipboard access is refused on an insecure origin and in some locked
       * down browsers. Selecting the text is a worse experience than the copy
       * button but it is not a dead end, so say which one happened. */
      toast.push({
        tone: 'warning',
        title: 'Could not copy automatically',
        body: 'Select the link above and copy it by hand.',
      });
    }
  }

  return (
    <Modal
      open={link !== null}
      onClose={onClose}
      title={
        link?.purpose === 'reset' ? `A new password link for ${firstName}` : `${firstName} is ready`
      }
      footer={
        <>
          <Button variant="ghost" onClick={onCreateAnother}>
            Create another
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      {link === null ? null : (
        <div className="stack">
          <p style={{ color: 'var(--text-secondary)' }}>
            Send {firstName} the link below. They choose their own password — you never have to type
            one for them.
          </p>

          <div className="link-box">
            <div className="link-box__label">Set-up link</div>
            <span>{link.url}</span>
          </div>

          <div className="row" style={{ gap: 'var(--space-2)' }}>
            <Button variant="primary" onClick={() => void copy(link.url, 'Link')}>
              {copied ? 'Copied' : 'Copy link'}
            </Button>
            <Button variant="secondary" onClick={() => void copy(message, 'Message')}>
              Copy with a message
            </Button>
          </div>

          <Note>
            Works once, and expires {expiryPhrase(link.expiresAt)}. This is the only time it can be
            shown — if you lose it, make a new one.
          </Note>
        </div>
      )}
    </Modal>
  );
}

function expiryPhrase(iso: string): string {
  const hours = Math.round((Date.parse(iso) - Date.now()) / 3_600_000);
  if (hours <= 1) return 'within the hour';
  if (hours < 36) return `in about ${hours} hours`;
  return `on ${new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}`;
}
