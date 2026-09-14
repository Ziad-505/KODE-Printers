import type { ReactElement, ReactNode } from 'react';
import type { LoginResult, Role, User } from '@kode/shared';
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
export declare function AuthProvider({ children }: {
    children: ReactNode;
}): ReactElement;
export declare function useAuth(): AuthContextValue;
export {};
//# sourceMappingURL=auth.d.ts.map