import { useState, type FormEvent, type ReactElement } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { Button, Field, Input, KodeMark, Note, Switch } from '../components/ui.js';

/**
 * Sign in.
 *
 * There is no sign-up link and no "create an account", because nobody signs
 * themselves up: an administrator creates the account and sends a set-up link.
 * Saying that plainly at the bottom of the card is worth more than a dead link
 * to a page that would only tell someone to go and ask.
 *
 * The floating mark is the one piece of motion in the interface. It sits above
 * the card rather than inside it so the card reads as lifted off the page, and
 * two more drift far back in the ground at 5% opacity.
 */
export function SignIn(): ReactElement {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const from = (location.state as { from?: string } | null)?.from;

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      await signIn(username.trim(), password, rememberMe);
      void navigate(from && from !== '/signin' ? from : '/', { replace: true });
    } catch (caught) {
      /* The server deliberately gives the same answer for an unknown username
       * and a wrong password, so the client must not embellish it into
       * something more specific. A lockout is different — that one the person
       * genuinely needs to understand, and it names the wait. */
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="auth__ground" />
      <DriftMark className="auth__drift auth__drift--a" size={300} />
      <DriftMark className="auth__drift auth__drift--b" size={230} />

      <div className="auth__panel">
        <div className="auth__mark">
          <KodeMark size={44} title="KODE Printer" />
        </div>

        <div className="auth__card">
          <div className="auth__eyebrow">KODE PRINTER</div>
          <h1 className="auth__title" style={{ marginTop: 'var(--space-3)' }}>
            Welcome back
          </h1>
          <p className="auth__lede">Sign in to print, scan and pick things up.</p>

          <form onSubmit={(event) => void onSubmit(event)} className="stack" noValidate>
            <Field label="Username">
              {(id) => (
                <Input
                  id={id}
                  name="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  required
                  autoFocus
                />
              )}
            </Field>

            <Field label="Password">
              {(id) => (
                <Input
                  id={id}
                  name="password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  required
                />
              )}
            </Field>

            <div className="row row--between" style={{ marginTop: 'var(--space-1)' }}>
              <Switch checked={rememberMe} onChange={setRememberMe} label="Keep me signed in" />
            </div>

            {error ? <Note severity="critical">{error}</Note> : null}

            <Button type="submit" variant="primary" size="lg" block loading={busy}>
              Sign in
            </Button>
          </form>

          <p
            className="dim"
            style={{
              marginTop: 'var(--space-5)',
              fontSize: 'var(--text-xs)',
              textAlign: 'center',
              textWrap: 'pretty',
            }}
          >
            No account yet, or forgotten your password? Ask an administrator — they will send you a
            link to set a new one.
          </p>
        </div>

        <div className="auth__foot">KODE Sports Club · Technology</div>
      </div>
    </div>
  );
}

/** A mark sitting far back in the ground. Decorative, so hidden from readers. */
function DriftMark({ className, size }: { className: string; size: number }): ReactElement {
  return (
    <div className={className} aria-hidden="true">
      <KodeMark size={size} />
    </div>
  );
}
