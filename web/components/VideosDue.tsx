'use client';
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { fmtDate, todayISO } from '@/lib/dates';
import { CLIP_SAVED } from '@/lib/uploads';
import { ClipButton } from '@/components/ClipUpload';

type Row = { player_id: string; name: string; due_on: string; last_clip: string | null; drive_folder_id: string | null };

/** Every 4 to 6 weeks: a short training video of each of the coach's players. Stays until it is uploaded. */
export function VideosDue({ coachId }: { coachId: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const load = useCallback(() => {
    supabase.rpc('videos_due', { p_coach_id: coachId }).then(({ data }) => setRows((data as Row[]) ?? []));
  }, [coachId]);
  useEffect(() => {
    load();
    window.addEventListener(CLIP_SAVED, load);
    return () => window.removeEventListener(CLIP_SAVED, load);
  }, [load]);

  const today = todayISO();
  const due = rows.filter((r) => r.due_on <= today);
  if (due.length === 0) return null;
  return (
    <section className="panel todo mt" aria-label="Training videos due">
      <h2 style={{ marginTop: 0 }}>Training videos due ({due.length})</h2>
      <p className="hint">Every 4 to 6 weeks, film 30 to 60 seconds of each player in a session: a drill they are working on, filmed so their technique is clear. It goes to the player&apos;s Drive folder and shows their progress over time. Each reminder stays until the video is uploaded here.</p>
      <ul className="list">
        {due.map((r) => (
          <li key={r.player_id} className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
            <span><strong>{r.name}</strong><br />
              <span className="hint">Due {fmtDate(r.due_on, true)}{r.last_clip ? ` · last video ${fmtDate(r.last_clip)}` : ' · first video'}</span></span>
            <ClipButton playerId={r.player_id} playerName={r.name} folderId={r.drive_folder_id} />
          </li>
        ))}
      </ul>
    </section>
  );
}
