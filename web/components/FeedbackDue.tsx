'use client';
import { useCallback, useEffect, useState } from 'react';
import { supabase, errorText } from '@/lib/supabase';
import { fmtDate } from '@/lib/dates';

type Row = { player_id: string; name: string; period_start: string; period_end: string; sessions: number };
type Note = { session_date: string; topic: string | null; observations: string | null };

export const periodLabel = (start: string, end: string) => {
  const m = (d: string) => new Date(`${d}T12:00:00`).toLocaleString('en-AU', { month: 'long' });
  return `${m(start)} to ${m(end)}`;
};
export const FEEDBACK_CHANGED = 'eleade:feedback-changed';

/** Every two months: three short dot-point fields per player, for Jan to send to the parents. */
export function FeedbackDue({ coachId }: { coachId: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => {
    supabase.rpc('feedback_due', { p_coach_id: coachId }).then(({ data }) => setRows((data as Row[]) ?? []));
  }, [coachId]);
  useEffect(() => { load(); }, [load]);
  if (rows.length === 0) return null;
  return (
    <section className="panel todo mt" aria-label="Player feedback due">
      <h2 style={{ marginTop: 0 }}>Player feedback due ({rows.length})</h2>
      <p className="hint">Every two months, a short update for each of your players: two or three dot points per heading. Jan sends it to the parents. Their session notes are shown to help you.</p>
      <ul className="list">{rows.map((r) => {
        const k = `${r.player_id}:${r.period_start}`;
        return (
          <li key={k}>
            <button type="button" className="todo-row" aria-expanded={open === k} onClick={() => setOpen(open === k ? null : k)}>
              <span><strong>{r.name}</strong><br /><span className="hint">{periodLabel(r.period_start, r.period_end)} · {r.sessions} session{Number(r.sessions) === 1 ? '' : 's'}</span></span>
              <span className="tag amber">{open === k ? 'Close' : 'Write'}</span>
            </button>
            {open === k && <FeedbackForm r={r} onSaved={() => { setOpen(null); load(); window.dispatchEvent(new Event(FEEDBACK_CHANGED)); }} />}
          </li>
        );
      })}</ul>
    </section>
  );
}

function FeedbackForm({ r, onSaved }: { r: Row; onSaved: () => void }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [progress, setProgress] = useState('• ');
  const [focus, setFocus] = useState('• ');
  const [homework, setHomework] = useState('• ');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
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
  async function save() {
    setBusy(true); setErr('');
    const { error } = await supabase.rpc('save_feedback', { p_player_id: r.player_id, p_period_start: r.period_start,
      p_progress: clean(progress), p_focus: clean(focus), p_homework: clean(homework) });
    setBusy(false);
    if (error) setErr(errorText(error)); else onSaved();
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
      <p className="hint">Two or three points each, one line per point. Tap Enter for the next point.</p>
      {err && <div className="notice err" role="alert">{err}</div>}
      <button type="button" className="btn small" disabled={busy} onClick={save}>{busy ? 'Saving' : 'Save feedback'}</button>
    </div>
  );
}
