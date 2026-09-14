import type { ReactElement } from 'react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth.js';
import { useLiveUpdates } from './lib/live.js';
import { applyWaitingUpdate, UPDATE_READY_EVENT } from './lib/pwa.js';
import { Shell } from './components/Shell.js';
import { Button, KodeMark, Spinner } from './components/ui.js';
import { SignIn } from './screens/SignIn.js';
import { SetPassword } from './screens/SetPassword.js';
import { ChangePassword } from './screens/ChangePassword.js';
import { Home } from './screens/Home.js';
import { PrintComposer } from './screens/PrintComposer.js';
import { Fleet } from './screens/Fleet.js';

/**
 * Routing.
 *
 * The heavier screens are lazily loaded. Insights pulls in Recharts and Admin
 * pulls in several tables; neither is on the path a user takes to print
 * something, which is the journey the first paint should serve.
 */
const Scans = lazy(() => import('./screens/Scans.js').then((m) => ({ default: m.Scans })));
const Jobs = lazy(() => import('./screens/Jobs.js').then((m) => ({ default: m.Jobs })));
const Insights = lazy(() => import('./screens/Insights.js').then((m) => ({ default: m.Insights })));
const Admin = lazy(() => import('./screens/Admin.js').then((m) => ({ default: m.Admin })));
const Notifications = lazy(() =>
  import('./screens/Notifications.js').then((m) => ({ default: m.Notifications })),
);
const Account = lazy(() => import('./screens/Account.js').then((m) => ({ default: m.Account })));
const People = lazy(() => import('./screens/People.js').then((m) => ({ default: m.People })));
const FleetNext = lazy(() =>
  import('./screens/FleetNext.js').then((m) => ({ default: m.FleetNext })),
);

export function App(): ReactElement {
  const { status, user, mustChangePassword, isAdmin } = useAuth();
  const location = useLocation();

  useLiveUpdates(status === 'authenticated' && !mustChangePassword);

  if (status === 'loading') return <BootScreen />;

  if (status === 'anonymous' || !user) {
    return (
      <Routes>
        <Route path="/signin" element={<SignIn />} />
        {/* Reachable without a session by necessity: the whole point is that
            this person has no way in yet. */}
        <Route path="/set-password/:token" element={<SetPassword />} />
        <Route
          path="*"
          element={<Navigate to="/signin" replace state={{ from: location.pathname }} />}
        />
      </Routes>
    );
  }

  /**
   * GAP-01, client side.
   *
   * The server already refuses every other route with PASSWORD_CHANGE_REQUIRED
   * — that is the control. This redirect exists so the user meets a form rather
   * than a wall of errors, and it is deliberately unconditional: there is no
   * "remind me later" path, because §B12.4 is explicit that an operational
   * reminder is not a control.
   */
  if (mustChangePassword) {
    return (
      <Routes>
        <Route path="*" element={<ChangePassword forced />} />
      </Routes>
    );
  }

  return (
    <>
      <UpdatePrompt />
      <Routes>
        <Route path="/set-password/:token" element={<SetPassword />} />
        <Route element={<Shell />}>
          <Route index element={<Home />} />
          <Route path="/print" element={<PrintComposer />} />
          <Route path="/fleet" element={<Fleet />} />
          {/* The design proposal, side by side with the screen it proposes to
              replace. Lazy so it costs nothing until someone opens it, and it
              comes out with the decision rather than living here forever. */}
          <Route
            path="/fleet/next"
            element={
              <Lazy>
                <FleetNext />
              </Lazy>
            }
          />
          <Route
            path="/scans"
            element={
              <Lazy>
                <Scans />
              </Lazy>
            }
          />
          <Route
            path="/jobs"
            element={
              <Lazy>
                <Jobs />
              </Lazy>
            }
          />
          <Route
            path="/insights"
            element={
              <Lazy>
                <Insights />
              </Lazy>
            }
          />
          <Route
            path="/notifications"
            element={
              <Lazy>
                <Notifications />
              </Lazy>
            }
          />
          <Route
            path="/account"
            element={
              <Lazy>
                <Account />
              </Lazy>
            }
          />
          <Route
            path="/people"
            element={
              isAdmin ? (
                <Lazy>
                  <People />
                </Lazy>
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/admin/*"
            element={
              isAdmin ? (
                <Lazy>
                  <Admin />
                </Lazy>
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </>
  );
}

/**
 * "A new version is ready."
 *
 * Offered rather than applied. Reloading under someone who is half way through
 * choosing a document would throw the file away, so the decision stays theirs
 * — which is the whole reason the service worker registers in `prompt` mode.
 */
function UpdatePrompt(): ReactElement | null {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const onReady = (): void => setReady(true);
    window.addEventListener(UPDATE_READY_EVENT, onReady);
    return () => window.removeEventListener(UPDATE_READY_EVENT, onReady);
  }, []);

  if (!ready) return null;

  return (
    <div className="update-bar" role="status">
      <span>A new version of KODE Printer is ready.</span>
      <Button size="sm" variant="primary" onClick={() => void applyWaitingUpdate()}>
        Reload
      </Button>
    </div>
  );
}

function Lazy({ children }: { children: React.ReactNode }): ReactElement {
  return (
    <Suspense
      fallback={
        <div style={{ display: 'grid', placeItems: 'center', padding: 'var(--space-8)' }}>
          <Spinner size={22} />
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

function BootScreen(): ReactElement {
  return (
    <div
      style={{
        display: 'grid',
        placeItems: 'center',
        minHeight: '100dvh',
        color: 'var(--kode-blue-bright)',
      }}
    >
      <KodeMark size={44} title="KODE Printer" />
    </div>
  );
}
