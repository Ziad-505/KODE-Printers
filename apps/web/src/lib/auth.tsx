import type { ReactElement, ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { LoginResult, Role, User } from '@kode/shared';
import { api, onAuthEvent, setAccessToken } from './api.js';

/**
 * Session state.
 *
 * The bootstrap on mount is the piece worth explaining. There is no token in
 * storage to read — it lives in memory and died with the last page load — so
 * the app opens by attempting a refresh against the httpOnly cookie. Success
 * restores the session silently; failure lands on the sign-in screen. That is
 * what makes "reload the page" not log everyone out, without ever putting a
 * token somewhere script can read it.
 */

interface AuthState {
  user: User | null;
  mustChangePassword: boolean;
  pushPublicKey: string | null;
  status: 'loading' | 'authenticated' | 'anonymous';
}

interface AuthContextValue extends AuthState {
  signIn: (username: string, password: string, rememberMe: boolean) => Promise<LoginResult>;
  /** Adopts a session established by redeeming a set-password link. */
  adoptSession: (result: LoginResult) => void;
  signOut: () => Promise<void>;
  refreshUser: () => Promise<void>;
  isAdmin: boolean;
  can: (role: Role) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): ReactElement {
  const [state, setState] = useState<AuthState>({
    user: null,
    mustChangePassword: false,
    pushPublicKey: null,
    status: 'loading',
  });

  const loadMe = useCallback(async () => {
    const me = await api.get<{
      user: User;
      mustChangePassword: boolean;
      pushPublicKey: string | null;
    }>('/auth/me');
    setState({
      user: me.user,
      mustChangePassword: me.mustChangePassword,
      pushPublicKey: me.pushPublicKey,
      status: 'authenticated',
    });
  }, []);

  // Silent restore on first paint.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch('/api/auth/refresh', {
          method: 'POST',
          credentials: 'same-origin',
        });
        if (!response.ok) throw new Error('no session');

        const data = (await response.json()) as LoginResult;
        if (cancelled) return;

        setAccessToken(data.accessToken);
        setState({
          user: data.user,
          mustChangePassword: data.mustChangePassword,
          pushPublicKey: null,
          status: 'authenticated',
        });

        // `/auth/me` also returns the VAPID key, which the push registration
        // needs. Fetched after the session exists rather than inlined into the
        // refresh response, so refresh stays a pure token endpoint.
        await loadMe().catch(() => undefined);
      } catch {
        if (!cancelled) setState((prev) => ({ ...prev, status: 'anonymous' }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadMe]);

  // The API client emits this when a refresh fails mid-session — an expired
  // refresh token, or a family revoked because a token was replayed.
  useEffect(
    () =>
      onAuthEvent((event) => {
        if (event !== 'signed-out') return;
        setAccessToken(null);
        setState({
          user: null,
          mustChangePassword: false,
          pushPublicKey: null,
          status: 'anonymous',
        });
      }),
    [],
  );

  const signIn = useCallback(
    async (username: string, password: string, rememberMe: boolean) => {
      const result = await api.post<LoginResult>('/auth/login', {
        username,
        password,
        rememberMe,
      });
      setAccessToken(result.accessToken);
      setState({
        user: result.user,
        mustChangePassword: result.mustChangePassword,
        pushPublicKey: null,
        status: 'authenticated',
      });
      void loadMe().catch(() => undefined);
      return result;
    },
    [loadMe],
  );

  /**
   * Takes a session that was established somewhere other than the sign-in form.
   *
   * Redeeming a set-password link returns exactly what `/auth/login` returns —
   * the server puts it through the same path deliberately — but the response
   * arrives on a screen that has no session to update through `signIn`. This is
   * the seam for that, and it is the only other way a session begins.
   */
  const adoptSession = useCallback(
    (result: LoginResult) => {
      setAccessToken(result.accessToken);
      setState({
        user: result.user,
        mustChangePassword: result.mustChangePassword,
        pushPublicKey: null,
        status: 'authenticated',
      });
      void loadMe().catch(() => undefined);
    },
    [loadMe],
  );

  const signOut = useCallback(async () => {
    // The server call clears the cookie and revokes the token; local state is
    // cleared regardless, so a network failure still signs you out here.
    await api.post('/auth/logout').catch(() => undefined);
    setAccessToken(null);
    setState({ user: null, mustChangePassword: false, pushPublicKey: null, status: 'anonymous' });
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      signIn,
      adoptSession,
      signOut,
      refreshUser: loadMe,
      isAdmin: state.user?.role === 'admin',
      can: (role: Role) => (role === 'admin' ? state.user?.role === 'admin' : Boolean(state.user)),
    }),
    [state, signIn, adoptSession, signOut, loadMe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
