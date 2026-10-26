'use client';
import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';
import type { PlayerBalance } from './types';

export function usePlayers(includeInactive = false) {
  const [players, setPlayers] = useState<PlayerBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    let q = supabase.from('player_balances').select('*').order('name');
    if (!includeInactive) q = q.eq('active', true);
    const { data, error } = await q;
    if (error) setError(error.message);
    setPlayers((data as PlayerBalance[]) ?? []);
    setLoading(false);
  }, [includeInactive]);

  useEffect(() => { load(); }, [load]);

  /** Add a player who isn't on the list yet, and return their id. */
  const createPlayer = useCallback(async (name: string, mainCoachId?: string | null) => {
    const { data, error: e } = await supabase.from('players')
      .insert({ name, main_coach_id: mainCoachId ?? null }).select('id').single();
    if (e) {
      throw new Error(e.message.includes('duplicate')
        ? `A player called ${name} already exists. Search for them instead.`
        : e.message);
    }
    await load();
    return (data as { id: string }).id;
  }, [load]);

  return { players, loading, error, reload: load, createPlayer };
}

export function creditClass(p: Pick<PlayerBalance, 'billing_model' | 'sessions_left'> & { pairs_left?: number | null }, threshold = 2): string {
  if (p.billing_model !== 'package' || p.sessions_left === null) return 'none';
  // A player with a separate 2:1 package: judge by the 2:1 sessions, plus the 1:1 sessions once they have any (or owe some).
  const hasPairs = p.pairs_left !== null && p.pairs_left !== undefined;
  const n = hasPairs ? (Number(p.sessions_left) === 0 ? Number(p.pairs_left) : Math.min(Number(p.sessions_left), Number(p.pairs_left))) : Number(p.sessions_left);
  if (n <= 0) return 'out';
  if (n <= threshold) return 'low';
  return '';
}
