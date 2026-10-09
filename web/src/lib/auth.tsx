import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { User } from '@shared';
import { getToken, setToken } from '../api/client';
import { authApi, type Account } from '../api/endpoints';
import { qk } from '../api/hooks';

interface AuthState {
  token: string | null;
  user: User | null;
  /** Sign-in source, admin flag and password expiry; null until /auth/me answers. */
  account: Account | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, name?: string) => Promise<void>;
  /** Replace the password of a local account (also an expired one) and sign in with the new one. */
  changePassword: (email: string, password: string, newPassword: string) => Promise<void>;
  /** Use a session issued elsewhere (Entra ID sign-in). */
  adoptSession: (token: string) => void;
  signOut: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [token, setTokenState] = useState<string | null>(() => getToken());

  useEffect(() => {
    const onAuth = (e: Event) => {
      const next = (e as CustomEvent<{ token: string | null }>).detail.token;
      setTokenState(next);
      if (!next) qc.clear();
    };
    const onStorage = () => setTokenState(getToken());
    window.addEventListener('inventorydb:auth', onAuth);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('inventorydb:auth', onAuth);
      window.removeEventListener('storage', onStorage);
    };
  }, [qc]);

  const me = useQuery({ queryKey: [...qk.me, token], queryFn: authApi.me, enabled: !!token, retry: false, staleTime: 5 * 60_000 });

  // The full /auth/me answer (with the account) is fetched right after; the user is known already.
  const start = useCallback((res: { user: User; token: string }) => {
    qc.setQueryData([...qk.me, res.token], { user: res.user });
    setToken(res.token);
    void qc.invalidateQueries({ queryKey: qk.me });
  }, [qc]);

  const signIn = useCallback(async (email: string, password: string) => start(await authApi.signIn({ email, password })), [start]);

  const signUp = useCallback(
    async (email: string, password: string, name?: string) => start(await authApi.signUp({ email, password, name })),
    [start],
  );

  const changePassword = useCallback(
    async (email: string, password: string, newPassword: string) => start(await authApi.changePassword({ email, password, newPassword })),
    [start],
  );

  const adoptSession = useCallback((next: string) => setToken(next), []);

  const signOut = useCallback(() => {
    setToken(null);
    qc.clear();
  }, [qc]);

  const value = useMemo<AuthState>(
    () => ({
      token,
      user: me.data?.user ?? null,
      account: me.data?.account ?? null,
      loading: !!token && me.isLoading,
      signIn,
      signUp,
      changePassword,
      adoptSession,
      signOut,
    }),
    [token, me.data, me.isLoading, signIn, signUp, changePassword, adoptSession, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
