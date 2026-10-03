'use client';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import type { Coach } from './types';

type AuthState = {
  loading: boolean;
  session: Session | null;
  coach: Coach | null;      // the logged-in person's coach record (null = not a coach)
  coaches: Coach[];         // the whole team, for names
  isAdmin: boolean;
  refreshCoaches: () => Promise<void>;
};

const Ctx = createContext<AuthState>({
  loading: true, session: null, coach: null, coaches: [], isAdmin: false, refreshCoaches: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [coaches, setCoaches] = useState<Coach[]>([]);

  async function loadCoaches() {
    const { data } = await supabase.from('coaches').select('*').order('name');
    setCoaches((data as Coach[]) ?? []);
  }

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!alive) return;
      setSession(data.session);
      if (data.session) await loadCoaches();
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange(async (_e, s) => {
      setSession(s);
      if (s) await loadCoaches();
      else setCoaches([]);
    });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, []);

  const uid = session?.user?.id;
  const coach = coaches.find((c) => c.user_id === uid) ?? null;
  return (
    <Ctx.Provider value={{ loading, session, coach, coaches, isAdmin: !!coach?.is_admin, refreshCoaches: loadCoaches }}>
      {children}
    </Ctx.Provider>
  );
}

export const useAuth = () => useContext(Ctx);
