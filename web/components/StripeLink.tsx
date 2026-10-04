'use client';
import { useEffect, useState } from 'react';
import { supabase, errorText } from '@/lib/supabase';
import { fmtDate, money } from '@/lib/dates';
import { useUnusedPayments } from '@/components/StripeNote';

/** On a session that waits for payment: use a Stripe payment that has already arrived. */
export function StripeLink({ sessionId, onLinked }: { sessionId: string; onLinked: () => void }) {
  const [playerIds, setPlayerIds] = useState<string[]>([]);
  useEffect(() => {
    supabase.from('session_players').select('player_id').eq('session_id', sessionId)
      .then(({ data }) => setPlayerIds(((data as { player_id: string }[]) ?? []).map((r) => r.player_id)));
  }, [sessionId]);
  const pays = useUnusedPayments(playerIds);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  if (pays.length === 0) return null;

  async function link(id: string) {
    setBusy(id); setErr('');
    const { error } = await supabase.rpc('link_stripe_payment', { p_payment_id: id, p_session_id: sessionId });
    setBusy('');
    if (error) setErr(errorText(error)); else onLinked();
  }

  return (
    <div className="notice ok" style={{ marginTop: 8 }}>
      <strong>Stripe payment received.</strong> Use it for this session?
      {pays.map((p) => (
        <div key={p.id} className="row" style={{ marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ flex: '1 1 auto' }}>{money(p.amount_total)} on {fmtDate(p.paid_at.slice(0, 10))}{p.customer_name ? `, ${p.customer_name}` : ''}</span>
          <button type="button" className="btn small" disabled={!!busy} onClick={() => link(p.id)}>{busy === p.id ? 'Linking' : 'Use for this session'}</button>
        </div>
      ))}
      {err && <div className="notice err" role="alert">{err}</div>}
    </div>
  );
}
