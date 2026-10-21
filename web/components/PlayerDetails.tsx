'use client';
import { useState } from 'react';
import { supabase, errorText } from '@/lib/supabase';
import { fmtDate } from '@/lib/dates';
import { ageGroupLabel, ageYears } from '@/lib/age';

type P = { id: string; parent_name?: string | null; dob?: string | null; email?: string | null; phone?: string | null; club?: string | null };

/** Parent, date of birth (with age group), email, phone and club. Any coach can update them. */
export function PlayerDetails({ p, onSaved }: { p: P; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [parent, setParent] = useState(p.parent_name ?? '');
  const [dob, setDob] = useState(p.dob ?? '');
  const [email, setEmail] = useState(p.email ?? '');
  const [phone, setPhone] = useState(p.phone ?? '');
  const [club, setClub] = useState(p.club ?? '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const missing = !p.parent_name || !p.dob || !p.email || !p.club;

  async function save() {
    setBusy(true); setErr('');
    const { error } = await supabase.rpc('save_player_details', { p_player_id: p.id, p_parent_name: parent, p_dob: dob || null, p_email: email, p_phone: phone, p_club: club });
    setBusy(false);
    if (error) setErr(errorText(error)); else { setEditing(false); onSaved(); }
  }

  if (editing) {
    return (
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Player details</h3>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <label className="field" style={{ flex: '1 1 180px' }}><span>Parent&apos;s name</span><input type="text" value={parent} onChange={(e) => setParent(e.target.value)} /></label>
          <label className="field" style={{ flex: '1 1 150px' }}><span>Date of birth</span><input type="date" value={dob} onChange={(e) => setDob(e.target.value)} /></label>
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <label className="field" style={{ flex: '1 1 200px' }}><span>Email</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label className="field" style={{ flex: '1 1 150px' }}><span>Phone</span><input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
        </div>
        <label className="field"><span>Club</span><input type="text" value={club} onChange={(e) => setClub(e.target.value)} placeholder="e.g. UNSW FC" /></label>
        {dob && <p className="hint">Age group: {ageGroupLabel(dob)}</p>}
        {err && <div className="notice err" role="alert">{err}</div>}
        <div className="row">
          <button type="button" className="btn small" disabled={busy} onClick={save}>{busy ? 'Saving' : 'Save details'}</button>
          <button type="button" className="btn small ghost" onClick={() => setEditing(false)}>Cancel</button>
        </div>
      </div>
    );
  }
  return (
    <div className="panel">
      <dl className="details">
        <dt>Age group</dt><dd>{p.dob ? <>{ageGroupLabel(p.dob)} <span className="hint">(born {fmtDate(p.dob)}, {ageYears(p.dob)} years)</span></> : <span className="hint">Date of birth missing</span>}</dd>
        <dt>Club</dt><dd>{p.club ?? <span className="hint">Missing</span>}</dd>
        <dt>Parent</dt><dd>{p.parent_name ?? <span className="hint">Missing</span>}</dd>
        <dt>Email</dt><dd>{p.email ? <a href={`mailto:${p.email}`}>{p.email}</a> : <span className="hint">Missing</span>}</dd>
        {p.phone && <><dt>Phone</dt><dd><a href={`tel:${p.phone.replace(/\s/g, '')}`}>{p.phone}</a></dd></>}
      </dl>
      <button type="button" className="linkbtn" onClick={() => setEditing(true)}>{missing ? 'Add missing details' : 'Edit details'}</button>
    </div>
  );
}
