'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { fmtDate, money } from '@/lib/dates';

type StripePay = { id: string; amount_total: number; paid_at: string; applied_session_id: string | null };

/** Send the Stripe assessment link tagged with this player, and show what has been paid. */
export function AssessmentPayment({ playerId, playerName }: { playerId: string; playerName: string }) {
  const [link, setLink] = useState('');
  const [pays, setPays] = useState<StripePay[]>([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    supabase.from('settings').select('value').eq('key', 'stripe_assessment_link').maybeSingle()
      .then(({ data }) => setLink(((data?.value as string) ?? '').trim()));
    supabase.from('stripe_payments').select('id, amount_total, paid_at, applied_session_id')
      .eq('player_id', playerId).order('paid_at', { ascending: false })
      .then(({ data }) => setPays((data as StripePay[]) ?? []));
  }, [playerId]);

  if (!link && pays.length === 0) return null;
  const url = link ? `${link}${link.includes('?') ? '&' : '?'}client_reference_id=assessment_${playerId}` : '';
  const first = playerName.split(' ')[0];
  const message = `Hi 👋 Here is the payment link for ${first}'s Eleade assessment ($130 + GST):\n${url}\nThank you! ⚽`;

  async function copy() {
    await navigator.clipboard.writeText(url);
    setCopied(true); setTimeout(() => setCopied(false), 2500);
  }

  return (
    <details className="panel">
      <summary>Assessment payment{pays.length ? ` (${pays.length} paid by Stripe)` : ''}</summary>
      {pays.map((p) => (
        <p key={p.id} style={{ margin: '0 0 8px' }}>
          <span className="tag turf">Paid</span> {money(p.amount_total)} by Stripe on {fmtDate(p.paid_at.slice(0, 10))}.{' '}
          <span className="hint">{p.applied_session_id ? 'The assessment is marked as paid.' : 'The assessment will be marked as paid as soon as it is logged.'}</span>
        </p>
      ))}
      {url && (
        <>
          <p className="hint">This link is tagged with {first}, so the payment is matched to the assessment automatically. No need to check it on Monday.</p>
          <div className="row" style={{ flexWrap: 'wrap', marginBottom: 14 }}>
            <a className="btn small" href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noreferrer">Send on WhatsApp</a>
            <button type="button" className="btn small ghost" onClick={copy}>{copied ? 'Copied' : 'Copy link'}</button>
          </div>
        </>
      )}
    </details>
  );
}
