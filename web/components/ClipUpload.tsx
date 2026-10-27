'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { driveApi, folderUrl } from '@/lib/drive';
import { errorText } from '@/lib/supabase';
import { fmtDate } from '@/lib/dates';
import { CLIP_SAVED, useUploads, type ClipWhen } from '@/lib/uploads';

type Clip = { id: string; file_name: string; created_at: string; coach_id: string | null; social?: boolean };

/** The "Upload clip" button for one player: pick one or several videos, tick the ones for social media, upload. */
export function ClipButton({ playerId, playerName, folderId, label, when }:
  { playerId: string; playerName: string; folderId: string | null; label?: string; when?: ClipWhen }) {
  const { coach, isAdmin } = useAuth();
  const { uploads, start } = useUploads();
  const input = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<{ file: File; url: string; social: boolean }[]>([]);
  const urls = useRef<string[]>([]);
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);
  const mine = uploads.filter((u) => u.playerId === playerId && (u.status === 'starting' || u.status === 'uploading'));
  if (!folderId) {
    return <p className="hint">{playerName}: no Drive folder linked yet. {isAdmin ? 'Link it under Google Drive on the Admin page.' : 'Jan links it on the Admin page.'}</p>;
  }
  function uploadAll() {
    const n = picked.length;
    picked.forEach((p, i) => start(p.file, playerId, playerName, coach?.name, p.social, n > 1 ? `${i + 1} of ${n}` : '', when));
    setPicked([]);
  }
  return (
    <>
      <input ref={input} type="file" accept="video/*" multiple hidden
             onChange={(e) => {
               const files = Array.from(e.target.files ?? []);
               if (files.length) setPicked(files.map((f) => { const url = URL.createObjectURL(f); urls.current.push(url); return { file: f, url, social: false }; }));
               e.target.value = '';
             }} />
      {picked.length === 0 ? (
        <button type="button" className="btn small" onClick={() => input.current?.click()}>
          {mine.length ? `Uploading ${mine.length} clip${mine.length === 1 ? '' : 's'}` : label ?? 'Upload clips'}
        </button>
      ) : (
        <div className="panel clippick" style={{ width: '100%' }}>
          <p style={{ marginTop: 0 }}><strong>{picked.length} clip{picked.length === 1 ? '' : 's'} for {playerName}</strong><br />
            <span className="hint">Tick the ones that are good for social media. They are also copied to the Social Media Footage folder.</span></p>
          <ul className="cliplist">{picked.map((p, i) => (
            <li key={p.url}>
              <video src={p.url} muted playsInline preload="metadata" />
              <label className="check small">
                <input type="checkbox" checked={p.social} onChange={(e) => setPicked(picked.map((x, k) => (k === i ? { ...x, social: e.target.checked } : x)))} />
                <span>Social media</span>
              </label>
              <button type="button" className="linkbtn" onClick={() => setPicked(picked.filter((_, k) => k !== i))}>Remove</button>
            </li>
          ))}</ul>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button type="button" className="btn small" onClick={uploadAll}>Upload {picked.length} clip{picked.length === 1 ? '' : 's'}</button>
            <button type="button" className="btn small ghost" onClick={() => input.current?.click()}>Choose again</button>
            <button type="button" className="btn small ghost" onClick={() => setPicked([])}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}

/** Player page: upload a session clip and see the latest ones. */
export function ClipUpload({ playerId, playerName, folderId }: { playerId: string; playerName: string; folderId: string | null }) {
  const { coaches, isAdmin } = useAuth();
  const [clips, setClips] = useState<Clip[]>([]);
  const [err, setErr] = useState('');
  const alertErr = setErr;

  const load = useCallback(() => {
    supabase.from('drive_clips').select('id, file_name, created_at, coach_id, social').eq('player_id', playerId)
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
      {folderId && <p className="hint">30 to 60 seconds each is ideal. Pick one or several videos from your phone, or record one now.</p>}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <ClipButton playerId={playerId} playerName={playerName} folderId={folderId} />
        {isAdmin && folderId && <a className="btn small ghost" href={folderUrl(folderId)} target="_blank" rel="noreferrer">Open Drive folder</a>}
      </div>
      {err && <div className="notice err mt" role="alert">{err}</div>}
      {clips.length > 0 && (
        <ul className="list mt">{clips.map((c) => (
          <li key={c.id}>{c.file_name} {c.social && <span className="tag turf">Social media</span>}<br /><span className="hint">{fmtDate(c.created_at.slice(0, 10))}{coachName(c.coach_id) ? `, ${coachName(c.coach_id)}` : ''}</span>
            {!c.social && <> · <button type="button" className="linkbtn" onClick={async () => {
              try { await driveApi('/api/drive/social', { clip_id: c.id }); load(); } catch (e) { alertErr(errorText(e)); }
            }}>Copy to social media</button></>}</li>
        ))}</ul>
      )}
    </section>
  );
}
