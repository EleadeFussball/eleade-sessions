'use client';
import { useState } from 'react';
import { supabase, errorText } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/dates';
import { normaliseTime } from '@/lib/time';
import { hhmm, timeRange, type Meeting, type ScheduleEntry } from '@/lib/schedule';

const LENGTHS = [30, 45, 60, 90, 120];
const lengthLabel = (m: number) => (m < 60 ? `${m}m` : m % 60 === 0 ? `${m / 60}h` : `${Math.floor(m / 60)}h${m % 60}`);

/** Jan adds or changes a coach meeting: who is invited, when, and online (Zoom link) or in person (location). */
export function MeetingForm({ day, editing, onSaved, onCancel }: {
  day: string; editing?: ScheduleEntry; onSaved: () => void; onCancel: () => void;
}) {
  const { coaches } = useAuth();
  const m = editing?.meeting;
  const [title, setTitle] = useState(m?.title ?? '');
  const [date, setDate] = useState(editing?.session_date ?? day);
  const [time, setTime] = useState(editing ? hhmm(editing.start_time) : '09:00');
  const [minutes, setMinutes] = useState(editing?.minutes ?? 60);
  const [mode, setMode] = useState<'online' | 'in_person'>(m?.mode ?? 'online');
  const [link, setLink] = useState(m?.link ?? '');
  const [location, setLocation] = useState(m?.location ?? '');
  const [note, setNote] = useState(m?.note ?? '');
  const [ids, setIds] = useState<string[]>(m?.coach_ids ?? []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const active = coaches.filter((c) => c.active);

  const toggle = (id: string) => setIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  async function save(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    const t = normaliseTime(time);
    if (!title.trim()) { setErr('Give the meeting a name.'); return; }
    if (!t) { setErr('Add a start time, like 630, 6:30 or 1800.'); return; }
    if (ids.length === 0) { setErr('Invite at least one coach.'); return; }
    if (mode === 'online' && !link.trim()) { setErr('Add the Zoom link.'); return; }
    if (mode === 'in_person' && !location.trim()) { setErr('Add the location of the meeting.'); return; }
    setBusy(true);
    const args = {
      p_title: title, p_date: date, p_start: t, p_minutes: minutes, p_mode: mode,
      p_location: mode === 'in_person' ? location : null, p_link: mode === 'online' ? link : null, p_note: note, p_coach_ids: ids,
    };
    const { error } = editing && m ? await supabase.rpc('update_meeting', { p_id: m.id, ...args }) : await supabase.rpc('create_meeting', args);
    setBusy(false);
    if (error) { setErr(errorText(error)); return; }
    onSaved();
  }

  return (
    <form onSubmit={save} className="sheet-form">
      <h2 style={{ marginTop: 0 }}>{editing ? 'Change meeting' : 'New coach meeting'}</h2>
      <p className="hint" style={{ marginTop: -6 }}>Meetings use no credits. They show in the calendar of every invited coach.</p>
      <label className="field"><span>Meeting name</span>
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Coaches catch-up" /></label>
      <div className="field">
        <span className="fieldlabel">Invited coaches</span>
        <div className="seg" style={{ flexWrap: 'wrap' }}>
          <button type="button" aria-pressed={ids.length === active.length && active.length > 0} onClick={() => setIds(ids.length === active.length ? [] : active.map((c) => c.id))}>Everyone</button>
          {active.map((c) => <button key={c.id} type="button" aria-pressed={ids.includes(c.id)} onClick={() => toggle(c.id)}>{c.name}</button>)}
        </div>
        <span className="hint">{ids.length === 0 ? 'None selected: pick one coach for a one-to-one, several for a group meeting.' : ids.length === 1 ? 'Individual meeting' : `Group meeting, ${ids.length} coaches`}</span>
      </div>
      <div className="row">
        <label className="field"><span>Date</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="field" style={{ flex: '0 0 104px' }}><span>Start</span>
          <input type="text" inputMode="numeric" value={time} onChange={(e) => setTime(e.target.value)} onBlur={() => setTime(normaliseTime(time) || time)} /></label>
      </div>
      <div className="field">
        <span className="fieldlabel">Length</span>
        <div className="seg">
          {LENGTHS.map((l) => <button key={l} type="button" aria-pressed={minutes === l} onClick={() => setMinutes(l)}>{lengthLabel(l)}</button>)}
        </div>
      </div>
      <div className="field">
        <span className="fieldlabel">Where</span>
        <div className="seg">
          <button type="button" aria-pressed={mode === 'online'} onClick={() => setMode('online')}>Online</button>
          <button type="button" aria-pressed={mode === 'in_person'} onClick={() => setMode('in_person')}>In person</button>
        </div>
      </div>
      {mode === 'online' ? (
        <label className="field"><span>Zoom link</span>
          <input type="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://zoom.us/j/..." /></label>
      ) : (
        <label className="field"><span>Location</span>
          <input type="text" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Address or place" /></label>
      )}
      <label className="field"><span>Note <span className="hint">(optional)</span></span>
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Bring your session plans" /></label>
      {err && <div className="notice err" role="alert">{err}</div>}
      <div className="row">
        <button className="btn small" disabled={busy}>{busy ? 'Saving' : editing ? 'Save meeting' : 'Add meeting'}</button>
        <button type="button" className="btn small ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/** What a coach sees when they open a meeting; Jan can also change or delete it. */
export function MeetingDetail({ o, onChange, onDone }: { o: ScheduleEntry; onChange: () => void; onDone: () => void }) {
  const { coaches, isAdmin } = useAuth();
  const m = o.meeting as Meeting;
  const [edit, setEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const names = m.coach_ids.map((id) => coaches.find((c) => c.id === id)?.name).filter(Boolean).join(', ');

  async function remove() {
    if (!window.confirm(`Delete the meeting "${m.title}"? It is removed from every invited coach's calendar.`)) return;
    setBusy(true); setErr('');
    const { error } = await supabase.from('meetings').delete().eq('id', m.id);
    setBusy(false);
    if (error) setErr(errorText(error)); else onChange();
  }

  if (edit) return <MeetingForm day={o.session_date} editing={o} onSaved={onChange} onCancel={() => setEdit(false)} />;
  return (
    <div className="meet-card">
      <h2 style={{ margin: '0 0 4px', color: '#fff' }}>{m.title}</h2>
      <p style={{ margin: '0 0 8px' }}>{fmtDate(o.session_date, true)} · {timeRange(o.start_time, o.minutes)}</p>
      <p style={{ margin: '0 0 4px' }}><strong>{m.mode === 'online' ? 'Online' : 'In person'}:</strong>{' '}
        {m.mode === 'online' && m.link ? <a href={m.link} target="_blank" rel="noopener noreferrer">{m.link}</a> : m.location}</p>
      <p style={{ margin: '0 0 4px' }}><strong>{m.coach_ids.length > 1 ? 'Group meeting' : 'Individual meeting'}:</strong> {names}</p>
      {m.note && <p style={{ margin: '0 0 4px' }}>{m.note}</p>}
      <p className="hint" style={{ color: 'rgba(255,255,255,.7)', margin: '8px 0 0' }}>Meetings use no credits.</p>
      {err && <div className="notice err" role="alert">{err}</div>}
      <div className="row" style={{ marginTop: 10 }}>
        {m.mode === 'online' && m.link && <a className="btn small" href={m.link} target="_blank" rel="noopener noreferrer">Join Zoom</a>}
        {isAdmin && <button type="button" className="btn small ghost" onClick={() => setEdit(true)} disabled={busy}>Change</button>}
        {isAdmin && <button type="button" className="btn small ghost" onClick={remove} disabled={busy}>Delete</button>}
        <button type="button" className="btn small ghost" onClick={onDone}>Close</button>
      </div>
    </div>
  );
}
