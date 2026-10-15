'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase, errorText } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { fmtDate, isoWeek, money } from '@/lib/dates';
import { invoiceNo, type CoachInvoice } from '@/lib/types';

/** Jan only: every coach's invoices, newest first, open and paid. */
export function PastInvoices() {
  const { coaches } = useAuth();
  const [coachId, setCoachId] = useState('');
  const [rows, setRows] = useState<CoachInvoice[]>([]);
  const [limit, setLimit] = useState(20);
  const [err, setErr] = useState('');

  useEffect(() => {
    let q = supabase.from('coach_invoices').select('*').order('period_start', { ascending: false }).order('coach_name').limit(limit);
    if (coachId) q = q.eq('coach_id', coachId);
    q.then(({ data, error }) => { if (error) setErr(errorText(error)); else { setErr(''); setRows((data as CoachInvoice[]) ?? []); } });
  }, [coachId, limit]);

  const total = rows.reduce((t, i) => t + Number(i.total), 0);

  return (
    <section>
      <h2>Previous coach invoices</h2>
      <select value={coachId} onChange={(e) => { setCoachId(e.target.value); setLimit(20); }} aria-label="Coach" style={{ width: 'auto' }}>
        <option value="">All coaches</option>
        {coaches.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      {err && <div className="notice err" role="alert">{err}</div>}
      {rows.length === 0 ? <p className="empty">No invoices yet.</p> : (
        <table className="t mt">
          <thead><tr><th>Coach</th><th>Invoice</th><th className="n">Amount</th><th className="n">Status</th></tr></thead>
          <tbody>{rows.map((i) => (
            <tr key={i.id}>
              <td>{i.coach_name}</td>
              <td><Link href={`/invoices/${i.id}`}>{invoiceNo(i)}</Link><br /><span className="hint">Week {isoWeek(i.period_start)}, to {fmtDate(i.period_end)}</span></td>
              <td className="n">{money(Number(i.total))}</td>
              <td className="n"><span className={i.status === 'paid' ? 'tag turf' : 'tag amber'}>{i.status === 'paid' ? `Paid ${fmtDate(i.paid_at?.slice(0, 10) ?? null)}` : 'Open'}</span></td>
            </tr>
          ))}</tbody>
          {coachId && <tfoot><tr><td>Total shown</td><td></td><td className="n">{money(total)}</td><td></td></tr></tfoot>}
        </table>
      )}
      {rows.length === limit && <button type="button" className="btn small ghost mt" onClick={() => setLimit(limit + 40)}>Show older invoices</button>}
    </section>
  );
}
