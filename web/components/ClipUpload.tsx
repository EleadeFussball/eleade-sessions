'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase, errorText } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { driveApi, folderUrl } from '@/lib/drive';
import { fmtDate, todayISO } from '@/lib/dates';

type Clip = { id: string; file_name: string; created_at: string; coach_id: string | null };

/** Any coach: upload a session clip from the phone into the player's Drive folder (Session clips). */
export function ClipUpload({ playerId, playerName, folderId }: { playerId: string; playerName: string; folderId: string | null }) {
  const { coach, coaches, isAdmin } = useAuth();
  const [clips, setClips] = useState<Clip[]>([]);
  const [pct, setPct] = useState<number | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    supabase.from('drive_clips').select('id, file_name, created_at, coach_id').eq('player_id', playerId)
      .order('created_at', { ascending: false }).limit(5).then(({ data }) => setClips((data as Clip[]) ?? []));
  }, [playerId]);
  useEffect(() => { load(); }, [load]);

  async function upload(file: File) {
    setErr(''); setMsg('');
    const ext = (file.name.match(/\.[a-z0-9]{2,5}$/i)?.[0] ?? '.mp4').toLowerCase();
    const first = (coach?.name ?? '').split(' ')[0];
    const name = `${todayISO()} ${playerName}${first ? ` (${first})` : ''}${ext}`;
    try {
      const { url } = await driveApi<{ url: string }>('/api/drive/upload', { player_id: playerId, file_name: name, mime: file.type || 'video/mp4', size: file.size });
      setPct(0);
      const fileId = await new Promise<string>((resolve, reject) => {
        const x = new XMLHttpRequest();
        x.open('PUT', url);
        x.setRequestHeader('Content-Type', file.type || 'video/mp4');
        x.upload.onprogress = (e) => { if (e.lengthComputable) setPct(Math.round((e.loaded / e.total) * 100)); };
        x.onload = () => {
          if (x.status >= 200 && x.status < 300) { try { resolve(JSON.parse(x.responseText).id ?? ''); } catch { resolve(''); } }
          else reject(new Error(`Upload stopped (${x.status}). Try again on a better connection.`));
        };
        x.onerror = () => reject(new Error('Upload stopped. Check the connection and try again.'));
        x.send(file);
      });
      await supabase.rpc('record_clip', { p_player_id: playerId, p_file_id: fileId, p_file_name: name });
      setMsg(`Clip saved to ${playerName}'s Drive folder.`); load();
    } catch (e) { setErr(errorText(e)); }
    setPct(null);
    if (input.current) input.current.value = '';
  }

  const coachName = (id: string | null) => coaches.find((c) => c.id === id)?.name.split(' ')[0] ?? '';

  return (
    <section className="panel mt">
      <h2 style={{ marginTop: 0 }}>Session clips</h2>
      {!folderId ? (
        <p className="hint">No Drive folder linked yet. {isAdmin ? 'Link it under Google Drive on the Admin page.' : 'Jan links it on the Admin page.'}</p>
      ) : (
        <>
          <p className="hint">30 to 60 seconds is ideal. Pick a video from your phone or record one now.</p>
          <input ref={input} type="file" accept="video/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }} />
          <button type="button" className="btn small" disabled={pct !== null} onClick={() => input.current?.click()}>
            {pct !== null ? `Uploading ${pct}%` : 'Upload clip'}
          </button>
          {isAdmin && <> <a className="btn small ghost" href={folderUrl(folderId)} target="_blank" rel="noreferrer">Open Drive folder</a></>}
        </>
      )}
      {pct !== null && <p className="hint mt">Keep this page open until it reaches 100%.</p>}
      {err && <div className="notice err mt" role="alert">{err}</div>}
      {msg && <div className="notice ok mt" role="status">{msg}</div>}
      {clips.length > 0 && (
        <ul className="list mt">{clips.map((c) => (
          <li key={c.id}>{c.file_name}<br /><span className="hint">{fmtDate(c.created_at.slice(0, 10))}{coachName(c.coach_id) ? `, ${coachName(c.coach_id)}` : ''}</span></li>
        ))}</ul>
      )}
    </section>
  );
}
