'use client';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { supabase, errorText } from '@/lib/supabase';
import { fmtDate, money } from '@/lib/dates';
import { FORMAT_LABEL, type Format } from '@/lib/types';

export type StripePay = {
  id: string; amount_total: number; paid_at: string; applied_session_id: string | null; for_what: string | null;
  sessions: { session_date: string; format: Format } | null;
};
type Candidate = { session_id: string; session_date: string; format: Format; outcome: string; coach_name: string; payment_status: string | null };

/** Stripe on a player's page: payment links tagged with this player, and what has been paid. */
export function AssessmentPayment({ playerId, playerName }: { playerId: string; playerName: string }) {
  const [assessmentLink, setAssessmentLink] = useState('');
  const [sessionLink, setSessionLink] = useState('');
  const [pays, setPays] = useState<StripePay[]>([]);
  const [copied, setCopied] = useState('');

  const load = useCallback(async () => {
    const [l, p] = await Promise.all([
      supabase.from('settings').select('key, value').in('key', ['stripe_assessment_link', 'stripe_session_link']),
      supabase.from('stripe_payments').select('id, amount_total, paid_at, applied_session_id, for_what, sessions(session_date, format)')
        .eq('player_id', playerId).order('paid_at', { ascending: false }),
    ]);
    for (const r of (l.data as { key: string; value: string }[]) ?? []) {
      const v = (r.value ?? '').trim();
      if (r.key === 'stripe_assessment_link') setAssessmentLink(v); else setSessionLink(v);
    }
    setPays((p.data as unknown as StripePay[]) ?? []);
  }, [playerId]);
  useEffect(() => { load(); }, [load]);

  if (!assessmentLink && !sessionLink && pays.length === 0) return null;
  const first = playerName.split(' ')[0];
  const tag = (link: string, kind: string) => `${link}${link.includes('?') ? '&' : '?'}client_reference_id=${kind}_${playerId}`;
  const waiting = pays.filter((p) => !p.applied_session_id).length;

  async function copy(url: string, which: string) {
    await navigator.clipboard.writeText(url);
    setCopied(which); setTimeout(() => setCopied(''), 2500);
  }

  const links: { which: string; label: string; url: string; message: string }[] = [];
  if (assessmentLink) {
    const url = tag(assessmentLink, 'assessment');
    links.push({ which: 'assessment', label: 'Assessment link ($130 + GST)', url,
      message: `Hi 👋 Here is the payment link for ${first}'s Eleade assessment ($130 + GST):\n${url}\nThank you! ⚽` });
  }
  if (sessionLink) {
    const url = tag(sessionLink, 'session');
    links.push({ which: 'session', label: 'Session link', url,
      message: `Hi 👋 Here is the payment link for ${first}'s Eleade session:\n${url}\nThank you! ⚽` });
  }

  return (
    <details className="panel" open={waiting > 0}>
      <summary>Stripe payments{pays.length ? ` (${pays.length}${waiting ? `, ${waiting} waiting for a session` : ''})` : ''}</summary>
      {pays.map((p) => (
        <PaymentRow key={p.id} p={p} onChanged={load} />
      ))}
      {links.length > 0 && (
        <>
          <p className="hint">These links are tagged with {first}, so a payment is matched to {first} automatically.</p>
          {links.map((l) => (
            <div key={l.which} style={{ marginBottom: 12 }}>
              <div className="fieldlabel">{l.label}</div>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <a className="btn small" href={`https://wa.me/?text=${encodeURIComponent(l.message)}`} target="_blank" rel="noreferrer">Send on WhatsApp</a>
                <button type="button" className="btn small ghost" onClick={() => copy(l.url, l.which)}>{copied === l.which ? 'Copied' : 'Copy link'}</button>
              </div>
            </div>
          ))}
        </>
      )}
    </details>
  );
}

export function PaymentRow({ p, onChanged, who }: { p: StripePay; onChanged: () => void; who?: ReactNode }) {
  const [cands, setCands] = useState<Candidate[] | null>(null);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const used = !!p.applied_session_id;

  useEffect(() => {
    if (used) return;
    supabase.rpc('stripe_link_candidates', { p_payment_id: p.id }).then(({ data }) => {
      const list = (data as Candidate[]) ?? [];
      setCands(list);
      if (list.length === 1) setPick(list[0].session_id);
    });
  }, [p.id, used]);

  async function link() {
    if (!pick) { setErr('Choose the session.'); return; }
    setBusy(true); setErr('');
    const { error } = await supabase.rpc('link_stripe_payment', { p_payment_id: p.id, p_session_id: pick });
    setBusy(false);
    if (error) setErr(errorText(error)); else onChanged();
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <div>
        <span className={used ? 'tag turf' : 'tag amber'}>{used ? 'Used' : 'Waiting for a session'}</span>{' '}
        {who}{who ? ', ' : ''}{money(p.amount_total)} on {fmtDate(p.paid_at.slice(0, 10))}
        {used && p.sessions && <span className="hint"> · paid for the {FORMAT_LABEL[p.sessions.format]} on {fmtDate(p.sessions.session_date)}</span>}
      </div>
      {!used && cands !== null && (
        cands.length === 0 ? (
          <p className="hint">No logged session to match yet. When the session is logged with “Paid by Stripe”, this payment is used for it automatically.</p>
        ) : (
          <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
            <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Session this payment was for" style={{ flex: '1 1 220px' }}>
              <option value="">Which session was it for?</option>
              {cands.map((c) => (
                <option key={c.session_id} value={c.session_id}>
                  {fmtDate(c.session_date, true)} · {FORMAT_LABEL[c.format]} · {c.coach_name}
                </option>
              ))}
            </select>
            <button type="button" className="btn small" disabled={busy} onClick={link}>{busy ? 'Linking' : 'Link payment'}</button>
          </div>
        )
      )}
      {err && <div className="notice err" role="alert">{err}</div>}
    </div>
  );
}
