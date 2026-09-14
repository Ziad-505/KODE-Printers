import type { ReactElement } from 'react';
import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { Button, Card, Field, Input, KodeMark, Note, useToast } from '../components/ui.js';

/**
 * Change password.
 *
 * When `forced`, this is the only reachable screen — GAP-01's client-side face.
 * The server is the actual control (every other route returns
 * PASSWORD_CHANGE_REQUIRED), and this exists so the user meets a form instead
 * of a wall of errors. There is deliberately no "skip" affordance: §B12.4 says
 * an operational reminder is not a control, and a dismissible prompt is exactly
 * that.
 */
export function ChangePassword({ forced = false }: { forced?: boolean }): ReactElement {
  const { signOut, user } = useAuth();
  const toast = useToast();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const strength = scorePassword(next);

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);

    if (next !== confirm) {
      setError('The two new passwords do not match.');
      return;
    }

    setBusy(true);
    try {
      await api.post('/auth/change-password', {
        currentPassword: current,
        newPassword: next,
        confirmPassword: confirm,
      });

      toast.push({
        tone: 'success',
        title: 'Password changed',
        body: 'Every other session has been signed out. Sign in again with your new password.',
      });

      // The server revoked every refresh token, including this session's — a
      // password change that leaves an attacker's session alive defeats the
      // point of changing it. So the client signs out rather than pretending.
      await signOut();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not change your password.');
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        display: 'grid',
        placeItems: 'center',
        minHeight: '100dvh',
        padding: 'var(--space-5)',
      }}
    >
      <div className="kp-rise" style={{ width: 'min(460px, 100%)' }}>
        <div className="row" style={{ gap: 'var(--space-3)', marginBottom: 'var(--space-5)' }}>
          <span style={{ color: 'var(--kode-blue-bright)' }}>
            <KodeMark size={30} title="KODE" />
          </span>
          <div>
            <div style={{ fontWeight: 900, fontSize: 'var(--text-lg)', letterSpacing: '-0.02em' }}>
              {forced ? 'Choose a new password' : 'Change your password'}
            </div>
            <div className="kode-eyebrow">{user?.username}</div>
          </div>
        </div>

        <Card>
          <div className="card__body">
            {forced ? (
              <div style={{ marginBottom: 'var(--space-5)' }}>
                <Note>
                  This account is still using the password it was created with. Choose your own
                  before you can print anything.
                </Note>
              </div>
            ) : null}

            <form
              onSubmit={(event) => {
                void onSubmit(event);
              }}
              className="stack"
              noValidate
            >
              <Field label="Current password">
                {(id) => (
                  <Input
                    id={id}
                    type="password"
                    value={current}
                    onChange={(event) => setCurrent(event.target.value)}
                    autoComplete="current-password"
                    required
                    autoFocus
                  />
                )}
              </Field>

              <Field
                label="New password"
                hint="At least 12 characters. Length matters far more than symbols."
              >
                {(id) => (
                  <Input
                    id={id}
                    type="password"
                    value={next}
                    onChange={(event) => setNext(event.target.value)}
                    autoComplete="new-password"
                    required
                  />
                )}
              </Field>

              {next.length > 0 ? <StrengthMeter score={strength} /> : null}

              <Field label="Confirm new password">
                {(id) => (
                  <Input
                    id={id}
                    type="password"
                    value={confirm}
                    onChange={(event) => setConfirm(event.target.value)}
                    autoComplete="new-password"
                    required
                    aria-invalid={confirm.length > 0 && confirm !== next}
                  />
                )}
              </Field>

              {error ? (
                <div className="note note--critical" role="alert">
                  <span aria-hidden="true">⚠</span>
                  <span>{error}</span>
                </div>
              ) : null}

              <Button
                type="submit"
                variant="primary"
                size="lg"
                block
                loading={busy}
                disabled={next.length < 12 || next !== confirm}
              >
                Change password
              </Button>
            </form>

            {forced ? (
              <Button
                variant="ghost"
                block
                style={{ marginTop: 'var(--space-3)' }}
                onClick={() => void signOut()}
              >
                Sign out instead
              </Button>
            ) : null}
          </div>
        </Card>
      </div>
    </div>
  );
}

/**
 * A length-weighted strength hint.
 *
 * Deliberately does not demand symbols or mixed case. The server's policy is
 * twelve characters plus a denylist, and a meter that scolds a perfectly good
 * passphrase into `P@ssw0rd!` would be actively counterproductive.
 */
function scorePassword(password: string): number {
  if (password.length === 0) return 0;
  let score = Math.min(3, Math.floor(password.length / 6));
  const variety = [/[a-z]/, /[A-Z]/, /\d/, /[^\w\s]/].filter((pattern) =>
    pattern.test(password),
  ).length;
  if (variety >= 3) score += 1;
  if (password.length >= 20) score += 1;
  return Math.min(4, score);
}

function StrengthMeter({ score }: { score: number }): ReactElement {
  const labels = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'];
  const colors = [
    'var(--status-offline)',
    'var(--status-offline)',
    'var(--status-degraded)',
    'var(--kode-blue-bright)',
    'var(--status-online)',
  ];

  return (
    <div>
      <div className="row" style={{ gap: 4 }}>
        {[0, 1, 2, 3].map((index) => (
          <div
            key={index}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 'var(--radius-pill)',
              background: index < score ? colors[score] : 'var(--surface-4)',
              transition: 'background var(--duration-base) var(--ease-out)',
            }}
          />
        ))}
      </div>
      <span
        className="field__hint"
        style={{ display: 'block', marginTop: 6, color: colors[score] }}
      >
        {labels[score]}
      </span>
    </div>
  );
}
