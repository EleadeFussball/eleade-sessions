'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { fmtDate, money } from '@/lib/dates';

export type UnusedPayment = { id: string; player_id: string; amount_total: number; paid_at: string; customer_name: string | null; for_what: string | null };

/** Stripe payments that have arrived for these players and are not used for a session yet. */
export function useUnusedPayments(playerIds: string[]): UnusedPayment[] {
  const [pays, setPays] = useState<UnusedPayment[]>([]);
  const key = playerIds.join(',');
  useEffect(() => {
    if (!key) { setPays([]); return; }
    let alive = true;
    supabase.from('stripe_payments').select('id, player_id, amount_total, paid_at, customer_name, for_what')
      .in('player_id', key.split(',')).is('applied_session_id', null).order('paid_at')
      .then(({ data }) => { if (alive) setPays((data as UnusedPayment[]) ?? []); });
    return () => { alive = false; };
  }, [key]);
  return pays;
}

/** One line under the "Paid by Stripe" button saying what will happen. */
export function StripeNote({ playerIds }: { playerIds: string[] }) {
  const pays = useUnusedPayments(playerIds);
  if (pays.length === 0) {
    return <p className="hint mt">No Stripe payment from this player has arrived yet. The session is marked as paid by Stripe, and Jan matches the payment when it comes in.</p>;
  }
  const p = pays[0];
  return (
    <p className="hint mt">
      Stripe payment received: {money(p.amount_total)} on {fmtDate(p.paid_at.slice(0, 10))}. It is matched to this session when you save, and the session counts as paid.
      {pays.length > 1 && ` (${pays.length - 1} more waiting.)`}
    </p>
  );
}
