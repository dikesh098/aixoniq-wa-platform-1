import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type { Role } from '../types';

interface AuthState {
  session: Session | null; role: Role | null; name: string | null; loading: boolean;
  canEdit: boolean; isAdmin: boolean; signOut: () => Promise<void>;
}
const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); if (!data.session) setLoading(false); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const uid = session?.user.id;
  useEffect(() => {
    if (!uid) { setRole(null); setName(null); return; }
    setLoading(true);
    supabase.from('staff').select('role, full_name').eq('user_id', uid).maybeSingle().then(({ data }) => {
      setRole((data?.role as Role) ?? null);
      setName(data?.full_name ?? null);
      setLoading(false);
    });
  }, [uid]);

  const value: AuthState = {
    session, role, name, loading,
    canEdit: role === 'admin' || role === 'editor', isAdmin: role === 'admin',
    signOut: async () => { await supabase.auth.signOut(); },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}
