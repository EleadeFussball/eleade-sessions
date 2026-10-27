'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase, errorText } from '@/lib/supabase';
import { periodLabel } from '@/components/FeedbackDue';
import { useAdminTask } from '@/components/AdminFold';

type Row = { player_id: string; name: string; period_start: string; period_end: string; coach_name: string | null;
  parent_name: string | null; email: string | null; phone: string | null; feedback_id: string | null;
  progress: string | null; focus: string | null; homework: string | null; sent_at: string | null; status: 'waiting' | 'ready' | 'sent' };

function waNumber(phone: string): string {
  const d = phone.replace(/\D/g, '');
  if (phone.trim().startsWith('+')) return d;
  if (d.startsWith('0')) return `61${d.slice(1)}`;
  return d;
}

export function feedbackMessage(r: Row) {
  const first = r.name.split(' ')[0];
  const parent = (r.parent_name ?? '').split(' ')[0];
  const [y, m] = r.period_end.split('-').map(Number); // month after the period, and the one after that
  const mn = (k: number) => new Date(y, m - 1 + k, 15).toLocaleString('en-AU', { month: 'long' });
  const nextLabel = `${mn(1)} and ${mn(2)}`;
  const block = (title: string, t: string | null) => t ? `${title}\n${t.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => (l.startsWith('•') ? l : `• ${l}`)).join('\n')}` : '';
  return [
    `Hi${parent ? ` ${parent}` : ''} 👋 Here is ${first}'s update from Eleade (${periodLabel(r.period_start, r.period_end)}):`,
    block('✅ Progress', r.progress),
    block(`🎯 Focus for ${nextLabel}`, r.focus),
    block('🏠 Homework', r.homework),
    `Any questions, just reply here. ${r.coach_name ? `${r.coach_name.split(' ')[0]} & the Eleade team` : 'The Eleade team'} ⚽`,
  ].filter(Boolean).join('\n\n');
}

/** Jan: feedback every two months, ready to copy and send to the parents. */
export function FeedbackAdmin() {
  const [rows, setRows] = useState<Row[]>([]);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState('');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const load = useCallback(() => {
    supabase.rpc('feedback_overview').then(({ data, error }) => { if (error) setErr(errorText(error)); else setRows((data as Row[]) ?? []); });
  }, []);
  useEffect(() => { load(); }, [load]);
  const periods = useMemo(() => [...new Set(rows.map((r) => r.period_start))], [rows]);
  const [period, setPeriod] = useState('');
  const cur = period || periods[0] || '';
  const list = rows.filter((r) => r.period_start === cur);
  const ready = list.filter((r) => r.status === 'ready');
  useAdminTask('feedback', 'fold-feedback', 'Player feedback ready to send', ready.length, 35);
  if (rows.length === 0) return null;
  const waiting = list.filter((r) => r.status === 'waiting');
  const sent = list.filter((r) => r.status === 'sent');
  const byCoach = waiting.reduce<Record<string, number>>((a, r) => { const k = r.coach_name ?? 'No coach'; a[k] = (a[k] ?? 0) + 1; return a; }, {});

  async function markSent(r: Row, sentNow: boolean) {
    const { error } = await supabase.rpc('feedback_sent', { p_id: r.feedback_id, p_sent: sentNow });
    if (error) setErr(errorText(error)); else load();
  }
  async function copy(r: Row) { try { await navigator.clipboard.writeText(feedbackMessage(r)); setCopied(r.player_id); setTimeout(() => setCopied(''), 2000); } catch { /* ignore */ } }

  const last = list[0];
  return (
    <section>
      <h2>Player feedback ({ready.length} ready to send)</h2>
      {periods.length > 1 && (
        <select value={cur} onChange={(e) => setPeriod(e.target.value)} aria-label="Period" style={{ width: 'auto' }}>
          {periods.map((p) => { const r = rows.find((x) => x.period_start === p)!; return <option key={p} value={p}>{periodLabel(r.period_start, r.period_end)}</option>; })}
        </select>
      )}
      {last && <p className="hint">{periodLabel(last.period_start, last.period_end)}: {sent.length} sent, {ready.length} ready, {waiting.length} waiting for the coach{waiting.length ? ` (${Object.entries(byCoach).map(([c, n]) => `${c} ${n}`).join(', ')})` : ''}.</p>}
      {err && <div className="notice err">{err}</div>}
      <ul className="list">{ready.map((r) => {
        const msg = feedbackMessage(r);
        return (
          <li key={r.player_id} className="session">
            <div className="head"><span><Link href={`/players/${r.player_id}`}>{r.name}</Link> · {r.coach_name}</span><span className="tag turf">Ready</span></div>
            <button type="button" className="linkbtn" onClick={() => setOpenKey(openKey === r.player_id ? null : r.player_id)}>{openKey === r.player_id ? 'Hide message' : 'Show message'}</button>
            {openKey === r.player_id && <pre className="msg">{msg}</pre>}
            {!r.parent_name && <p className="hint">Parent&apos;s name missing on the player page.</p>}
            <div className="row mt" style={{ flexWrap: 'wrap' }}>
              <button type="button" className="btn small ghost" onClick={() => copy(r)}>{copied === r.player_id ? 'Copied' : 'Copy message'}</button>
              {r.phone && <a className="btn small ghost" target="_blank" rel="noreferrer" href={`https://wa.me/${waNumber(r.phone)}?text=${encodeURIComponent(msg)}`}>WhatsApp</a>}
              {r.email && <a className="btn small ghost" href={`mailto:${r.email}?subject=${encodeURIComponent(`${r.name.split(' ')[0]}'s update from Eleade`)}&body=${encodeURIComponent(msg)}`}>Email</a>}
              <button type="button" className="btn small" onClick={() => markSent(r, true)}>Sent</button>
            </div>
          </li>
        );
      })}</ul>
      {sent.length > 0 && (
        <details className="mt"><summary>Sent ({sent.length})</summary>
          <ul className="list">{sent.map((r) => <li key={r.player_id}>{r.name} <button type="button" className="linkbtn" onClick={() => markSent(r, false)}>Undo</button></li>)}</ul>
        </details>
      )}
    </section>
  );
}
