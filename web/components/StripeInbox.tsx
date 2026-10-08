'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase, errorText } from '@/lib/supabase';
import { fmtDate, money } from '@/lib/dates';
import { FORMAT_LABEL, type Format } from '@/lib/types';
import { PaymentRow, type StripePay } from '@/components/AssessmentPayment';

type Row = StripePay & {
  customer_name: string | null; customer_email: string | null; player_id: string | null; player_name_entered: string | null;
  players: { name: string } | null;
};
type PlayerOption = { player_id: string; name: string };

/** Jan's view of Stripe: who paid, what is waiting for a session, and what has been used. */
export function StripeInbox({ players, onChanged }: { players: PlayerOption[]; onChanged: () => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [err, setErr] = useState('');
  const [who, setWho] = useState<Record<string, string>>({});
  const [kind, setKind] = useState<Record<string, 'session' | 'assessment'>>({});

  const load = useCallback(async () => {
    const { data } = await supabase.from('stripe_payments')
      .select('id, amount_total, paid_at, customer_name, customer_email, player_id, player_name_entered, for_what, applied_session_id, players(name), sessions(session_date, format)')
      .order('paid_at', { ascending: false }).limit(100);
    setRows((data as unknown as Row[]) ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);

  const changed = () => { load(); onChanged(); };
  const nobody = rows.filter((r) => !r.player_id);
  const waiting = rows.filter((r) => r.player_id && !r.applied_session_id);
  const used = rows.filter((r) => r.applied_session_id).slice(0, 8);

  // the name typed on the payment link, matched loosely to a player (all words found in the player's name)
  function guess(r: Row): string | undefined {
    const words = (r.player_name_entered ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return undefined;
    const hits = players.filter((pl) => words.every((w) => pl.name.toLowerCase().includes(w)));
    return hits.length === 1 ? hits[0].player_id : undefined;
  }

  async function assign(r: Row) {
    const pid = who[r.id] ?? guess(r);
    if (!pid) { setErr('Choose the player this payment is from.'); return; }
    setErr('');
    const { error } = await supabase.rpc('assign_stripe_payment_for', {
      p_payment_id: r.id, p_player_id: pid, p_for: kind[r.id] ?? (r.amount_total >= 140 ? 'assessment' : 'session'),
    });
    if (error) setErr(errorText(error)); else changed();
  }

  async function undo(r: Row) {
    if (!window.confirm('Take this payment off the session? The session goes back to waiting for a payment check.')) return;
    const { error } = await supabase.rpc('unlink_stripe_payment', { p_payment_id: r.id });
    if (error) setErr(errorText(error)); else changed();
  }

  if (rows.length === 0) return null;
  return (
    <>
      <h2>Stripe payments{nobody.length + waiting.length > 0 ? ` (${nobody.length + waiting.length} to sort)` : ''}</h2>
      {err && <div className="notice err" role="alert">{err}</div>}

      {nobody.length > 0 && (
        <>
          <h3>1. Who paid? ({nobody.length})</h3>
          <table className="t">
            <tbody>{nobody.map((r) => (
              <tr key={r.id}>
                <td>{money(r.amount_total)}<br /><span className="hint">{fmtDate(r.paid_at.slice(0, 10))}</span></td>
                <td>{r.customer_name ?? 'No name'}<br /><span className="hint">{r.customer_email ?? ''}</span>
                  {r.player_name_entered && <><br /><span className="hint">Player on the link: <strong>{r.player_name_entered}</strong></span></>}</td>
                <td>
                  <select value={who[r.id] ?? guess(r) ?? ''} onChange={(e) => setWho({ ...who, [r.id]: e.target.value })} aria-label="Player">
                    <option value="">Choose player</option>
                    {players.map((pl) => <option key={pl.player_id} value={pl.player_id}>{pl.name}</option>)}
                  </select>
                  <select className="mt" value={kind[r.id] ?? (r.amount_total >= 140 ? 'assessment' : 'session')}
                          onChange={(e) => setKind({ ...kind, [r.id]: e.target.value as 'session' | 'assessment' })} aria-label="What it was for">
                    <option value="session">Single session</option>
                    <option value="assessment">Assessment</option>
                  </select>
                  <button className="btn small ghost mt" type="button" onClick={() => assign(r)}>Assign</button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </>
      )}

      {waiting.length > 0 && (
        <>
          <h3>2. Which session was it for? ({waiting.length})</h3>
          {waiting.map((r) => (
            <PaymentRow key={r.id} p={r} onChanged={changed}
                        who={<Link href={`/players/${r.player_id}`}>{r.players?.name ?? 'Player'}</Link>} />
          ))}
        </>
      )}

      {used.length > 0 && (
        <details className="panel">
          <summary>3. Used for a session ({used.length} most recent)</summary>
          <table className="t"><tbody>
            {used.map((r) => (
              <tr key={r.id}>
                <td><Link href={`/players/${r.player_id}`}>{r.players?.name ?? 'Player'}</Link><br /><span className="hint">{money(r.amount_total)} on {fmtDate(r.paid_at.slice(0, 10))}</span></td>
                <td>{r.sessions ? `${FORMAT_LABEL[r.sessions.format as Format]} on ${fmtDate(r.sessions.session_date)}` : ''}</td>
                <td className="n"><button className="linkbtn" type="button" onClick={() => undo(r)}>Undo</button></td>
              </tr>
            ))}
          </tbody></table>
        </details>
      )}
    </>
  );
}
