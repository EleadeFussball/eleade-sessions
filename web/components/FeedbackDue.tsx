'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase, errorText } from '@/lib/supabase';
import { fmtDate, todayISO } from '@/lib/dates';

type Row = { player_id: string; name: string; period_start: string; period_end: string; sessions?: number; due_on?: string;
  progress?: string | null; focus?: string | null; homework?: string | null };
type Note = { session_date: string; topic: string | null; observations: string | null };

export const periodLabel = (start: string, end: string) => {
  const m = (d: string) => new Date(`${d}T12:00:00`).toLocaleString('en-AU', { month: 'long' });
  return `${m(start)} to ${m(end)}`;
};
export const FEEDBACK_CHANGED = 'eleade:feedback-changed';

/** Every two months: three short dot-point fields per player, for Jan to send to the parents. */
export function FeedbackDue({ coachId }: { coachId: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [drafts, setDrafts] = useState<Row[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => {
    supabase.rpc('feedback_due', { p_coach_id: coachId }).then(({ data }) => setRows((data as Row[]) ?? []));
    supabase.rpc('feedback_drafts', { p_coach_id: coachId }).then(({ data }) => setDrafts((data as Row[]) ?? []));
  }, [coachId]);
  useEffect(() => { load(); }, [load]);
  if (rows.length === 0 && drafts.length === 0) return null;
  const today = todayISO();
  const laterDue = rows.length > 0 && rows.every((r) => (r.due_on ?? '') > today) ? rows[0].due_on : null;
  const list = (items: Row[], saved: boolean) => items.map((r) => {
    const k = `${saved ? 's' : 'w'}:${r.player_id}:${r.period_start}`;
    return (
      <li key={k}>
        <button type="button" className="todo-row" aria-expanded={open === k} onClick={() => { if (open === k) { setTimeout(() => { load(); window.dispatchEvent(new Event(FEEDBACK_CHANGED)); }, 800); } setOpen(open === k ? null : k); }}>
          <span><strong>{r.name}</strong><br /><span className="hint">{periodLabel(r.period_start, r.period_end)}{r.sessions ? ` · ${r.sessions} session${Number(r.sessions) === 1 ? '' : 's'}` : ''}</span></span>
          <span className={`tag ${saved ? 'turf' : 'amber'}`}>{open === k ? 'Close' : saved ? 'Saved, edit' : 'Write'}</span>
        </button>
        {open === k && <FeedbackForm r={r} onSaved={() => { load(); window.dispatchEvent(new Event(FEEDBACK_CHANGED)); }} onDone={() => setOpen(null)} />}
      </li>
    );
  });
  return (
    <section className="panel todo mt" aria-label="Player feedback due">
      <h2 style={{ marginTop: 0 }}>Player feedback {laterDue ? 'to write' : 'due'} ({rows.length})</h2>
      <p className="hint">Every two months, a short update for each of your players: two or three dot points per heading. Jan sends it to the parents. Their session notes are shown to help you.
        {laterDue ? ` The reviews are not due until ${fmtDate(laterDue)}, but you can start now. Everything you type is saved automatically.` : ' Everything you type is saved automatically.'}</p>
      <ul className="list">{list(rows, false)}</ul>
      {drafts.length > 0 && (
        <>
          <h3>Saved, not sent yet ({drafts.length})</h3>
          <ul className="list">{list(drafts, true)}</ul>
        </>
      )}
    </section>
  );
}

const draftKey = (r: Row) => `eleade:feedback-draft:${r.player_id}:${r.period_start}`;
const readDraft = (r: Row) => { try { const v = localStorage.getItem(draftKey(r)); return v ? JSON.parse(v) as { progress: string; focus: string; homework: string } : null; } catch { return null; } };

function FeedbackForm({ r, onSaved, onDone }: { r: Row; onSaved: () => void; onDone: () => void }) {
  const [notes, setNotes] = useState<Note[]>([]);
  // what is already saved, otherwise what was typed on this phone but not saved, otherwise an empty dot point
  const backup = readDraft(r);
  const [progress, setProgress] = useState(r.progress || backup?.progress || '• ');
  const [focus, setFocus] = useState(r.focus || backup?.focus || '• ');
  const [homework, setHomework] = useState(r.homework || backup?.homework || '• ');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [status, setStatus] = useState('');
  useEffect(() => {
    supabase.from('sessions').select('session_date, topic, observations, session_players!inner(player_id)')
      .eq('session_players.player_id', r.player_id).gte('session_date', r.period_start).lte('session_date', r.period_end)
      .eq('outcome', 'attended').order('session_date')
      .then(({ data }) => setNotes(((data as Note[]) ?? []).filter((n) => n.topic || n.observations)));
  }, [r]);
  const clean = (t: string) => t.split('\n').map((l) => l.trim()).filter((l) => l && l !== '•').join('\n');
  // Enter starts a new dot point
  const bullets = (set: (v: string) => void) => (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const t = e.currentTarget; set(`${t.value}\n• `); }
  };

  const latest = useRef({ progress, focus, homework });
  latest.current = { progress, focus, homework };
  const savedText = useRef(JSON.stringify([clean(r.progress ?? ''), clean(r.focus ?? ''), clean(r.homework ?? '')]));
  const saving = useRef(false);

  // Save to the server; returns true when the text is safe there (or there is nothing to save).
  const persist = useCallback(async (quiet: boolean): Promise<boolean> => {
    const t = latest.current;
    const c = [clean(t.progress), clean(t.focus), clean(t.homework)];
    const key = JSON.stringify(c);
    if (key === savedText.current) return true;
    if (!c.some(Boolean)) return true;
    if (saving.current) return false;
    saving.current = true;
    if (!quiet) setBusy(true);
    const { error } = await supabase.rpc('save_feedback', { p_player_id: r.player_id, p_period_start: r.period_start,
      p_progress: c[0], p_focus: c[1], p_homework: c[2] });
    saving.current = false;
    if (!quiet) setBusy(false);
    if (error) { setErr(errorText(error)); setStatus('Not saved yet. Your text is kept on this phone, tap Save feedback to try again.'); return false; }
    savedText.current = key; setErr('');
    setStatus(`Saved ${new Date().toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })}`);
    try { localStorage.removeItem(draftKey(r)); } catch { /* ignore */ }
    return true;
  }, [r]);

  // Keep a copy on this phone while typing, and save to the server a moment after typing stops.
  useEffect(() => {
    try { localStorage.setItem(draftKey(r), JSON.stringify({ progress, focus, homework })); } catch { /* ignore */ }
    const id = setTimeout(() => { persist(true); }, 1500);
    return () => clearTimeout(id);
  }, [progress, focus, homework]); // eslint-disable-line react-hooks/exhaustive-deps

  // Closing the form or leaving the page saves what is typed.
  useEffect(() => {
    const flush = () => { persist(true); };
    const hidden = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', hidden);
    return () => { window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', hidden); persist(true); };
  }, [persist]);

  async function save() {
    setErr('');
    const ok = await persist(false);
    if (ok) { onSaved(); onDone(); }
  }
  return (
    <div className="mt">
      {notes.length > 0 && (
        <details>
          <summary>Session notes for this period ({notes.length})</summary>
          <ul className="list">{notes.map((n, i) => <li key={i}><span className="hint">{fmtDate(n.session_date, true)}</span><br />{n.topic}{n.observations ? <><br /><span className="hint">{n.observations}</span></> : null}</li>)}</ul>
        </details>
      )}
      <label className="field"><span>✅ Progress</span><textarea value={progress} onChange={(e) => setProgress(e.target.value)} onKeyDown={bullets(setProgress)} placeholder="• First touch under pressure much cleaner" /></label>
      <label className="field"><span>🎯 Focus for the next two months</span><textarea value={focus} onChange={(e) => setFocus(e.target.value)} onKeyDown={bullets(setFocus)} /></label>
      <label className="field"><span>🏠 Homework</span><textarea value={homework} onChange={(e) => setHomework(e.target.value)} onKeyDown={bullets(setHomework)} style={{ minHeight: 64 }} /></label>
      <p className="hint">Two or three points each, one line per point. Tap Enter for the next point. Your text is saved automatically.{status ? ` ${status}` : ''}</p>
      {err && <div className="notice err" role="alert">{err}</div>}
      <button type="button" className="btn small" disabled={busy} onClick={save}>{busy ? 'Saving' : 'Save feedback'}</button>
    </div>
  );
}
