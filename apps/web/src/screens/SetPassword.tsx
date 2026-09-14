import { useState, type FormEvent, type ReactElement } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { LoginResult, SetupLinkSubject } from '@kode/shared';
import { api, ApiError, setAccessToken } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { Button, Field, Input, KodeMark, Note, Spinner } from '../components/ui.js';

/**
 * Choosing a password from a set-up link.
 *
 * The public end of the flow an administrator starts on the People screen. It
 * is reachable signed-out by necessity — the whole point is that this person
 * has no way in yet — and the token in the URL is the only thing authorising
 * anything here.
 *
 * The page greets them by name before they type anything. That is not
 * decoration: a link arriving in a chat window with no context is
 * indistinguishable from a phishing attempt, and showing that the server knows
 * who the link was minted for is the cheapest way to make it trustworthy. The
 * server returns nothing else — no email, no role, no permissions — because
 * whoever holds the link is not yet known to be its intended owner.
 */
export function SetPassword(): ReactElement {
  const { token = '' } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { adoptSession } = useAuth();

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const subject = useQuery<SetupLinkSubject, ApiError>({
    queryKey: ['setup-link', token],
    queryFn: () => api.get<SetupLinkSubject>(`/auth/set-password/${encodeURIComponent(token)}`),
    // A dead link is dead. Retrying it just burns the rate limit that protects
    // this endpoint from being used to guess tokens.
    retry: false,
    enabled: token.length > 0,
  });

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError('The two passwords do not match.');
      return;
    }

    setBusy(true);
    try {
      /* Redeeming signs them straight in — they proved possession of a
       * single-use secret and chose this password seconds ago, and sending
       * them back to the sign-in form to type it again is the step where
       * people give up and telephone the office. */
      const result = await api.post<LoginResult>('/auth/set-password', {
        token,
        password,
        confirmPassword,
      });

      setAccessToken(result.accessToken);
      adoptSession(result);
      void navigate('/', { replace: true });
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.',
      );
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="auth__ground" />
      <div className="auth__drift auth__drift--a" aria-hidden="true">
        <KodeMark size={300} />
      </div>
      <div className="auth__drift auth__drift--b" aria-hidden="true">
        <KodeMark size={230} />
      </div>

      <div className="auth__panel">
        <div className="auth__mark">
          <KodeMark size={44} title="KODE Printer" />
        </div>

        <div className="auth__card">
          {subject.isPending ? (
            <div style={{ display: 'grid', placeItems: 'center', padding: 'var(--space-7) 0' }}>
              <Spinner size={22} />
            </div>
          ) : subject.isError ? (
            <Expired message={subject.error.message} />
          ) : (
            <>
              <h1 className="auth__title">
                {subject.data.purpose === 'reset'
                  ? 'Choose a new password'
                  : `Welcome, ${firstName(subject.data)}`}
              </h1>
              <p className="auth__lede">
                {subject.data.purpose === 'reset'
                  ? 'Pick a new one and you are back in.'
                  : 'Choose a password and you are in. Nobody else will ever see it.'}
              </p>

              <form onSubmit={(event) => void onSubmit(event)} className="stack" noValidate>
                <Field
                  label="New password"
                  hint="At least 12 characters — a short sentence works well and is easier to remember."
                >
                  {(id) => (
                    <Input
                      id={id}
                      name="password"
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete="new-password"
                      minLength={12}
                      required
                      autoFocus
                    />
                  )}
                </Field>

                <Field label="Type it once more">
                  {(id) => (
                    <Input
                      id={id}
                      name="confirmPassword"
                      type="password"
                      value={confirmPassword}
                      onChange={(event) => setConfirm(event.target.value)}
                      autoComplete="new-password"
                      required
                    />
                  )}
                </Field>

                {error ? <Note severity="critical">{error}</Note> : null}

                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  block
                  loading={busy}
                  disabled={password.length < 12}
                >
                  Save and sign in
                </Button>
              </form>

              <div style={{ marginTop: 'var(--space-5)' }}>
                <Note>
                  This link works once, and stops working on{' '}
                  <strong>{formatExpiry(subject.data.expiresAt)}</strong>. Ask an administrator for
                  a new one if it expires.
                </Note>
              </div>
            </>
          )}
        </div>

        <div className="auth__foot">KODE Sports Club · Technology</div>
      </div>
    </div>
  );
}

/**
 * The dead-link state.
 *
 * Deliberately not a form. Someone whose link has expired cannot fix it here,
 * so offering them fields to fill in would be a small cruelty; what they need
 * is to know who to ask.
 */
function Expired({ message }: { message: string }): ReactElement {
  return (
    <div style={{ textAlign: 'center' }}>
      <h1 className="auth__title">This link no longer works</h1>
      <p className="auth__lede">{message}</p>
      <div style={{ marginTop: 'var(--space-6)' }}>
        <Button
          variant="secondary"
          size="lg"
          block
          onClick={() => {
            window.location.href = '/signin';
          }}
        >
          Go to sign in
        </Button>
      </div>
    </div>
  );
}

/** "Sara Kamal" → "Sara". Falls back to the username when there is no name. */
function firstName(subject: SetupLinkSubject): string {
  const display = subject.displayName?.trim();
  if (!display) return subject.username;
  return display.split(/\s+/)[0] ?? display;
}

function formatExpiry(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}
