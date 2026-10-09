import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { User } from '@shared';
import { getToken, setToken } from '../api/client';
import { authApi } from '../api/endpoints';
import { qk } from '../api/hooks';

interface AuthState {
  token: string | null;
  user: User | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, name?: string) => Promise<void>;
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

  const signIn = useCallback(async (email: string, password: string) => {
    const res = await authApi.signIn({ email, password });
    qc.setQueryData([...qk.me, res.token], { user: res.user });
    setToken(res.token);
  }, [qc]);

  const signUp = useCallback(async (email: string, password: string, name?: string) => {
    const res = await authApi.signUp({ email, password, name });
    qc.setQueryData([...qk.me, res.token], { user: res.user });
    setToken(res.token);
  }, [qc]);

  const signOut = useCallback(() => {
    setToken(null);
    qc.clear();
  }, [qc]);

  const value = useMemo<AuthState>(
    () => ({
      token,
      user: me.data?.user ?? null,
      loading: !!token && me.isLoading,
      signIn,
      signUp,
      signOut,
    }),
    [token, me.data, me.isLoading, signIn, signUp, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
