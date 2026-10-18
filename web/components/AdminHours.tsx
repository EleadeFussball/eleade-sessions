'use client';
import { useState } from 'react';
import { supabase, errorText } from '@/lib/supabase';
import { todayISO } from '@/lib/dates';

/** Add admin hours ($30 an hour) to the next invoice. */
export function AdminHours({ coachId, onChanged }: { coachId: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(todayISO());
  const [hours, setHours] = useState('1');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function add() {
    const h = Number(hours.replace(',', '.'));
    if (!(h > 0) || h > 12 || Math.round(h * 4) !== h * 4) { setErr('Hours in quarter steps, for example 1, 1.5 or 2.25.'); return; }
    setBusy(true); setErr('');
    const { error } = await supabase.rpc('add_admin_hours', { p_work_date: date, p_hours: h, p_note: note, p_coach_id: coachId });
    setBusy(false);
    if (error) { setErr(errorText(error)); return; }
    setHours('1'); setNote(''); setOpen(false); onChanged();
  }

  if (!open) return <button type="button" className="btn small ghost mt" onClick={() => setOpen(true)}>Add admin hours</button>;
  return (
    <div className="panel mt">
      <h3 style={{ marginTop: 0 }}>Admin hours</h3>
      <p className="hint">Paid at $30 an hour on your next invoice. Use quarter hours, for example 1, 1.5 or 0.75.</p>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <label className="field" style={{ flex: '1 1 150px' }}><span>Day</span>
          <input type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="field" style={{ flex: '0 0 110px' }}><span>Hours</span>
          <input type="text" inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} /></label>
      </div>
      <label className="field"><span>What you did</span>
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Session plans, parent calls, video editing" /></label>
      {err && <div className="notice err" role="alert">{err}</div>}
      <div className="row">
        <button type="button" className="btn small" disabled={busy} onClick={add}>{busy ? 'Adding' : 'Add to invoice'}</button>
        <button type="button" className="btn small ghost" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

export async function removeAdminHours(id: string) {
  return supabase.rpc('remove_admin_hours', { p_id: id });
}
