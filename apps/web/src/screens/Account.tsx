import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { Badge, Button, Card, PageHeader, Segmented, Switch, useToast } from '../components/ui.js';
import { ChangePassword } from './ChangePassword.js';

/**
 * Account settings.
 *
 * Push registration lives here rather than as a prompt on first load. Browsers
 * suppress a permission request that arrives without a user gesture, and a
 * notification prompt on the first screen someone sees is the single most
 * reliable way to get permanently denied.
 */
export function Account(): ReactElement {
  const { user, signOut, pushPublicKey } = useAuth();
  const toast = useToast();

  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>(
    (localStorage.getItem('kode-theme') as 'light' | 'dark' | null) ?? 'system',
  );
  const [pushState, setPushState] = useState<'unsupported' | 'off' | 'on' | 'denied'>('off');
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset['theme'];
    else document.documentElement.dataset['theme'] = theme;

    if (theme === 'system') localStorage.removeItem('kode-theme');
    else localStorage.setItem('kode-theme', theme);
  }, [theme]);

  useEffect(() => {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) {
      setPushState('unsupported');
      return;
    }
    if (Notification.permission === 'denied') {
      setPushState('denied');
      return;
    }
    void navigator.serviceWorker.ready.then(async (registration) => {
      const existing = await registration.pushManager.getSubscription();
      setPushState(existing ? 'on' : 'off');
    });
  }, []);

  const enablePush = useMutation({
    mutationFn: async () => {
      if (!pushPublicKey) throw new Error('Push is not configured on this server.');

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setPushState(permission === 'denied' ? 'denied' : 'off');
        throw new Error('Notification permission was not granted.');
      }

      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(pushPublicKey),
      });

      await api.post('/auth/push-subscription', subscription.toJSON());
      setPushState('on');
    },
    onSuccess: () =>
      toast.push({
        tone: 'success',
        title: 'Notifications on',
        body: "You'll be told when a job finishes or a scan is ready.",
      }),
    onError: (error) =>
      toast.push({
        tone: 'warning',
        title: 'Could not enable notifications',
        body: error instanceof ApiError ? error.message : error.message,
      }),
  });

  if (showPassword) {
    return (
      <>
        <Button variant="ghost" onClick={() => setShowPassword(false)}>
          ← Back to account
        </Button>
        <ChangePassword />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={user?.displayName ?? user?.username ?? 'Your account'}
        subtitle={user?.department ?? undefined}
        actions={<Badge tone={user?.role === 'admin' ? 'accent' : 'default'}>{user?.role}</Badge>}
      />

      <div className="stack" style={{ maxWidth: 640 }}>
        <Card>
          <div className="card__header">
            <h2 className="card__title">Appearance</h2>
          </div>
          <div className="card__body">
            <Segmented
              label="Theme"
              value={theme}
              onChange={setTheme}
              options={[
                { value: 'system', label: 'System' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
            />
          </div>
        </Card>

        <Card>
          <div className="card__header">
            <h2 className="card__title">Notifications</h2>
          </div>
          <div className="card__body stack">
            {pushState === 'unsupported' ? (
              <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>
                This browser does not support push notifications. You will still see alerts inside
                the app.
              </p>
            ) : pushState === 'denied' ? (
              <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>
                Notifications are blocked for this site. Re-enable them in your browser settings if
                you want to be told when a job finishes.
              </p>
            ) : (
              <Switch
                checked={pushState === 'on'}
                onChange={(next) => {
                  if (next) enablePush.mutate();
                }}
                label="Tell me when a job finishes or a scan is ready"
                hint={
                  pushPublicKey
                    ? 'Works even when the app is closed, on phones that support it.'
                    : 'Push is not configured on this server yet.'
                }
              />
            )}
          </div>
        </Card>

        <Card>
          <div className="card__header">
            <h2 className="card__title">Security</h2>
          </div>
          <div className="card__body stack">
            <Button variant="secondary" onClick={() => setShowPassword(true)}>
              Change password
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                void (async () => {
                  await api.post('/auth/logout-all').catch(() => undefined);
                  await signOut();
                })();
              }}
            >
              Sign out everywhere
            </Button>
            <p className="dim" style={{ fontSize: 'var(--text-xs)' }}>
              Signing out everywhere ends every session for your account, including this one. Use it
              if you think someone else has access.
            </p>
          </div>
        </Card>

        <Button variant="danger" onClick={() => void signOut()}>
          Sign out
        </Button>
      </div>
    </>
  );
}

/**
 * VAPID keys are base64url; `PushManager.subscribe` wants raw bytes.
 * A small conversion, but a wrong one produces a subscription the server can
 * never deliver to, and the failure is silent until someone asks why they never
 * get notified.
 */
function urlBase64ToUint8Array(base64: string): BufferSource {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalised = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalised);

  // Backed by a plain ArrayBuffer rather than `Uint8Array.from`, whose type is
  // `ArrayBufferLike` and therefore not accepted as a `BufferSource`.
  const buffer = new ArrayBuffer(raw.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}
