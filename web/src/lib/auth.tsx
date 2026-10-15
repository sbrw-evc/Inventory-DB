import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { User } from '@shared';
import { getToken, setToken } from '../api/client';
import { authApi, spaUrls, type Account } from '../api/endpoints';
import { qk } from '../api/hooks';

interface AuthState {
  token: string | null;
  user: User | null;
  /** Role (from SPA), admin flag and SPA's account page; null until /auth/me answers. */
  account: Account | null;
  loading: boolean;
  /** Use the session Inventory DB started after the SPA callback. */
  adoptSession: (token: string) => void;
  /** Ends the session here, then SPA's (which returns to Inventory DB's address). */
  signOut: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

// After signing out, the sign-in page must not send the person straight back to SPA.
const SIGNED_OUT = 'idb_signed_out';
function markSignedOut() {
  try {
    sessionStorage.setItem(SIGNED_OUT, '1');
  } catch {
    /* ignore */
  }
}
/** Whether the person has just signed out (read once). */
export function takeSignedOut(): boolean {
  try {
    const v = sessionStorage.getItem(SIGNED_OUT) === '1';
    sessionStorage.removeItem(SIGNED_OUT);
    return v;
  } catch {
    return false;
  }
}

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

  const adoptSession = useCallback((next: string) => setToken(next), []);

  const signOut = useCallback(() => {
    markSignedOut();
    setToken(null);
    qc.clear();
    window.location.assign(spaUrls.logout);
  }, [qc]);

  const value = useMemo<AuthState>(
    () => ({
      token,
      user: me.data?.user ?? null,
      account: me.data?.account ?? null,
      loading: !!token && me.isLoading,
      adoptSession,
      signOut,
    }),
    [token, me.data, me.isLoading, adoptSession, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
