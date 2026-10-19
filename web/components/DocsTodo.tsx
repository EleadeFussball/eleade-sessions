'use client';
import { useCallback, useEffect, useState } from 'react';
import { supabase, errorText } from '@/lib/supabase';
import { fmtDate } from '@/lib/dates';
import { FORMAT_LABEL, FOCUS_LABEL, FOCUS_PLACEHOLDER, type Format } from '@/lib/types';

type Row = { session_id: string; session_date: string; start_time: string | null; format: Format; players: string | null };

export const DOCS_CHANGED = 'eleade:docs-changed';

/** Sessions still missing "What you worked on", documented right here. */
export function DocsTodo({ coachId, title = 'Documentation to do' }: { coachId: string; title?: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    supabase.rpc('undocumented_sessions', { p_coach_id: coachId }).then(({ data }) => setRows((data as Row[]) ?? []));
  }, [coachId]);
  useEffect(() => { load(); }, [load]);

  if (!rows || rows.length === 0) return null;
  return (
    <section className="panel todo mt" aria-label={title}>
      <h2 style={{ marginTop: 0 }}>{title} ({rows.length})</h2>
      <p className="hint">Add &quot;What you worked on&quot; (for a game analysis, the key focus points) for each session below. From Monday 19 October, an invoice can only be sent once every session on it is documented.</p>
      <ul className="list">
        {rows.map((r) => (
          <li key={r.session_id}>
            <button type="button" className="todo-row" aria-expanded={open === r.session_id} onClick={() => setOpen(open === r.session_id ? null : r.session_id)}>
              <span><strong>{r.players ?? 'Player'}</strong><br />
                <span className="hint">{fmtDate(r.session_date, true)}{r.start_time ? `, ${r.start_time.slice(0, 5)}` : ''} · {FORMAT_LABEL[r.format]}</span></span>
              <span className="tag amber">{open === r.session_id ? 'Close' : 'Add notes'}</span>
            </button>
            {open === r.session_id && (
              <NotesForm id={r.session_id} analysis={r.format === 'analysis'} onSaved={() => {
                setOpen(null); setRows((x) => (x ?? []).filter((y) => y.session_id !== r.session_id));
                window.dispatchEvent(new Event(DOCS_CHANGED));
              }} />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function NotesForm({ id, analysis, onSaved }: { id: string; analysis: boolean; onSaved: () => void }) {
  const [topic, setTopic] = useState('');
  const [obs, setObs] = useState('');
  const [improve, setImprove] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    supabase.from('sessions').select('observations, improve').eq('id', id).single()
      .then(({ data }) => { if (data) { setObs(data.observations ?? ''); setImprove(data.improve ?? ''); } });
  }, [id]);
  async function save() {
    if (!topic.trim()) { setErr(analysis ? 'Add the key focus points.' : 'Add what you worked on.'); return; }
    setBusy(true); setErr('');
    const { error } = await supabase.rpc('save_session_notes', { p_session_id: id, p_topic: topic, p_observations: obs, p_improve: improve });
    setBusy(false);
    if (error) setErr(errorText(error)); else onSaved();
  }
  return (
    <div className="mt">
      <p className="hint">Tap the microphone on your keyboard to dictate. German or English both work.</p>
      {analysis ? (
        <label className="field"><span>{FOCUS_LABEL}</span><textarea value={topic} onChange={(e) => setTopic(e.target.value)} placeholder={FOCUS_PLACEHOLDER} autoFocus /></label>
      ) : (
        <>
          <label className="field"><span>What you worked on</span><textarea value={topic} onChange={(e) => setTopic(e.target.value)} autoFocus /></label>
          <label className="field"><span>How it went <span className="hint">(optional)</span></span><textarea value={obs} onChange={(e) => setObs(e.target.value)} /></label>
          <label className="field"><span>Next session <span className="hint">(optional)</span></span><textarea value={improve} onChange={(e) => setImprove(e.target.value)} style={{ minHeight: 64 }} /></label>
        </>
      )}
      {err && <div className="notice err" role="alert">{err}</div>}
      <button type="button" className="btn small" disabled={busy} onClick={save}>{busy ? 'Saving' : 'Save notes'}</button>
    </div>
  );
}
