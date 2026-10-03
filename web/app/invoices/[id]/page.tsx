'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { fmtDate, fromISO, money } from '@/lib/dates';

const longDate = (s: string) => (s.length > 10 ? new Date(s) : fromISO(s)).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
import { fmtAbn, fmtBsb } from '@/lib/bank';
import { invoiceNo, type CoachInvoice, type InvoiceLine } from '@/lib/types';

export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  const { isAdmin } = useAuth();
  const [inv, setInv] = useState<CoachInvoice | null>(null);
  const [lines, setLines] = useState<InvoiceLine[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    Promise.all([
      supabase.from('coach_invoices').select('*').eq('id', id).maybeSingle(),
      supabase.from('invoice_lines').select('*').eq('invoice_id', id).order('line_date'),
    ]).then(([a, b]) => {
      setInv(a.data as CoachInvoice | null);
      setLines((b.data as InvoiceLine[]) ?? []);
      setLoaded(true);
    });
  }, [id]);

  useEffect(() => {
    if (inv) document.title = `Invoice ${invoiceNo(inv)}`;
    return () => { document.title = 'Eleade sessions'; };
  }, [inv]);

  if (!loaded) return <p className="empty">Loading</p>;
  if (!inv) return <p className="empty">Invoice not found.</p>;

  return (
    <>
      <div className="row no-print" style={{ marginBottom: 16 }}>
        <Link href={isAdmin ? '/monday' : '/week'} className="btn small ghost">Back</Link>
        <button type="button" className="btn small" onClick={() => window.print()}>Download PDF</button>
      </div>
      <p className="hint no-print">Download PDF opens the print window. Choose &quot;Save as PDF&quot; to keep a copy for your tax records.</p>

      <article className="invoice">
        <header className="inv-head">
          <div>
            <h1 style={{ marginBottom: 4 }}>Invoice</h1>
            <div className="inv-no">No. {invoiceNo(inv)}</div>
          </div>
          <div className="inv-meta">
            <div>Issued {longDate(inv.issued_on)}</div>
            <div>Week {fmtDate(inv.period_start)} to {longDate(inv.period_end)}</div>
            <div className={inv.status === 'paid' ? 'inv-status paid' : 'inv-status'}>
              {inv.status === 'paid' && inv.paid_at ? `Paid ${longDate(inv.paid_at)}` : 'Awaiting payment'}
            </div>
          </div>
        </header>

        <div className="inv-parties">
          <div>
            <div className="inv-label">From</div>
            <strong>{inv.coach_legal_name}</strong>
            <div>ABN {fmtAbn(inv.coach_abn)}</div>
          </div>
          <div>
            <div className="inv-label">To</div>
            <strong>{inv.business_name || 'Eleade'}</strong>
            {inv.business_abn && <div>ABN {fmtAbn(inv.business_abn)}</div>}
          </div>
        </div>

        <table className="t inv-lines">
          <thead><tr><th>Date</th><th>Description</th><th className="n">Amount</th></tr></thead>
          <tbody>{lines.map((l, k) => (
            <tr key={k}><td>{fmtDate(l.line_date, true)}</td><td>{l.description}</td><td className="n">{money(l.amount)}</td></tr>
          ))}</tbody>
          <tfoot><tr><td></td><td>Total</td><td className="n">{money(inv.total)}</td></tr></tfoot>
        </table>
        <p className="hint">No GST has been charged. The supplier is not registered for GST.</p>

        <div className="inv-pay">
          <div className="inv-label">Payment by bank transfer to</div>
          <div>{inv.account_name}</div>
          <div>BSB {fmtBsb(inv.bsb)}, account {inv.account_number}</div>
          <div>Reference {invoiceNo(inv)}</div>
        </div>
      </article>
    </>
  );
}
