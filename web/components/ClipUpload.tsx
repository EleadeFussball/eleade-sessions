'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { folderUrl } from '@/lib/drive';
import { fmtDate } from '@/lib/dates';
import { CLIP_SAVED, useUploads } from '@/lib/uploads';

type Clip = { id: string; file_name: string; created_at: string; coach_id: string | null };

/** The "Upload clip" button for one player. The upload itself runs app-wide (see UploadProvider). */
export function ClipButton({ playerId, playerName, folderId, label }: { playerId: string; playerName: string; folderId: string | null; label?: string }) {
  const { coach, isAdmin } = useAuth();
  const { uploads, start } = useUploads();
  const input = useRef<HTMLInputElement>(null);
  const busy = uploads.find((u) => u.playerId === playerId && (u.status === 'starting' || u.status === 'uploading'));
  if (!folderId) {
    return <p className="hint">{playerName}: no Drive folder linked yet. {isAdmin ? 'Link it under Google Drive on the Admin page.' : 'Jan links it on the Admin page.'}</p>;
  }
  return (
    <>
      <input ref={input} type="file" accept="video/*" hidden
             onChange={(e) => { const f = e.target.files?.[0]; if (f) start(f, playerId, playerName, coach?.name); e.target.value = ''; }} />
      <button type="button" className="btn small" onClick={() => input.current?.click()}>
        {busy ? `Uploading ${busy.pct}%` : label ?? 'Upload clip'}
      </button>
    </>
  );
}

/** Player page: upload a session clip and see the latest ones. */
export function ClipUpload({ playerId, playerName, folderId }: { playerId: string; playerName: string; folderId: string | null }) {
  const { coaches, isAdmin } = useAuth();
  const [clips, setClips] = useState<Clip[]>([]);

  const load = useCallback(() => {
    supabase.from('drive_clips').select('id, file_name, created_at, coach_id').eq('player_id', playerId)
      .order('created_at', { ascending: false }).limit(5).then(({ data }) => setClips((data as Clip[]) ?? []));
  }, [playerId]);
  useEffect(() => {
    load();
    const on = (e: Event) => { if ((e as CustomEvent).detail === playerId) load(); };
    window.addEventListener(CLIP_SAVED, on);
    return () => window.removeEventListener(CLIP_SAVED, on);
  }, [load, playerId]);

  const coachName = (id: string | null) => coaches.find((c) => c.id === id)?.name.split(' ')[0] ?? '';

  return (
    <section className="panel mt">
      <h2 style={{ marginTop: 0 }}>Session clips</h2>
      {folderId && <p className="hint">30 to 60 seconds is ideal. Pick a video from your phone or record one now.</p>}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <ClipButton playerId={playerId} playerName={playerName} folderId={folderId} />
        {isAdmin && folderId && <a className="btn small ghost" href={folderUrl(folderId)} target="_blank" rel="noreferrer">Open Drive folder</a>}
      </div>
      {clips.length > 0 && (
        <ul className="list mt">{clips.map((c) => (
          <li key={c.id}>{c.file_name}<br /><span className="hint">{fmtDate(c.created_at.slice(0, 10))}{coachName(c.coach_id) ? `, ${coachName(c.coach_id)}` : ''}</span></li>
        ))}</ul>
      )}
    </section>
  );
}
