'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { supabase, errorText } from './supabase';
import { driveApi } from './drive';
import { todayISO } from './dates';
import { compressClip } from './compress';

export type Upload = {
  id: string; playerId: string; playerName: string; fileName: string;
  pct: number; status: 'starting' | 'compressing' | 'uploading' | 'done' | 'error'; error?: string; social?: boolean; socialNote?: string; sizeNote?: string;
};

/** For a clip of a past session: the session's date (and start time) go into the file name instead of today's. */
export type ClipWhen = { date: string; time?: string | null };

type Ctx = {
  uploads: Upload[];
  start: (file: File, playerId: string, playerName: string, coachName?: string, social?: boolean, part?: string, when?: ClipWhen) => void;
  dismiss: (id: string) => void;
};
const UploadCtx = createContext<Ctx>({ uploads: [], start: () => {}, dismiss: () => {} });
export const useUploads = () => useContext(UploadCtx);

/** Fired when a clip is saved, so lists of clips can refresh. */
export const CLIP_SAVED = 'eleade:clip-saved';

type WakeLock = { release: () => Promise<void> };

/**
 * Clip uploads for the whole app: they keep running while the coach moves around eleade Hub,
 * and the screen is kept awake until they finish (closing the app or locking the phone still stops them).
 */
export function UploadProvider({ children }: { children: ReactNode }) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const patch = (id: string, p: Partial<Upload>) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, ...p } : x)));
  const active = uploads.some((u) => u.status === 'starting' || u.status === 'compressing' || u.status === 'uploading');

  // At most two uploads at a time; the rest wait their turn.
  const running = useRef(0);
  const queue = useRef<(() => Promise<void>)[]>([]);
  const pump = useCallback(() => {
    while (running.current < 2 && queue.current.length) {
      const job = queue.current.shift()!;
      running.current += 1;
      job().finally(() => { running.current -= 1; pump(); });
    }
  }, []);

  // Shrinking uses the phone's video encoder, so one clip at a time; uploads of finished ones carry on meanwhile.
  const shrinking = useRef<Promise<unknown>>(Promise.resolve());
  const shrink = useCallback((file: File, onPct: (n: number) => void) => {
    const run = shrinking.current.then(() => compressClip(file, onPct));
    shrinking.current = run.catch(() => {});
    return run;
  }, []);

  const start = useCallback((file: File, playerId: string, playerName: string, coachName?: string, social = false, part = '', when?: ClipWhen) => {
    const id = Math.random().toString(36).slice(2);
    const ext = (file.name.match(/\.[a-z0-9]{2,5}$/i)?.[0] ?? '.mp4').toLowerCase();
    const first = (coachName ?? '').split(' ')[0];
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    // today's clips: date and time of upload; clips for a past session: the session's date (and its start time when known)
    const stamp = when ? `${when.date}${when.time ? ` ${when.time.replace(':', '').slice(0, 4)}` : ''}` : `${todayISO()} ${hhmm}`;
    const baseName = `${stamp} ${playerName}${first ? ` (${first})` : ''}${part ? ` ${part}` : ''}`;
    setUploads((u) => [...u, { id, playerId, playerName, fileName: baseName + ext, pct: 0, status: 'starting', social }]);
    queue.current.push(async () => {
      try {
        // shrink first (clearly smaller, same look), otherwise send the original untouched
        patch(id, { status: 'compressing', pct: 0 });
        const res = await shrink(file, (pct) => patch(id, { pct }));
        const sendFile = res.file;
        const fileName = baseName + (res.compressed ? '.mp4' : ext);
        const mb = (n: number) => `${Math.max(1, Math.round(n / 1048576))} MB`;
        const sizeNote = res.compressed ? ` (shrunk from ${mb(file.size)} to ${mb(sendFile.size)})` : '';
        const mime = sendFile.type || 'video/mp4';
        patch(id, { status: 'uploading', pct: 0, fileName, sizeNote });
        const { url } = await driveApi<{ url: string }>('/api/drive/upload', { player_id: playerId, file_name: fileName, mime, size: sendFile.size });
        const fileId = await new Promise<string>((resolve, reject) => {
          const x = new XMLHttpRequest();
          x.open('PUT', url);
          x.setRequestHeader('Content-Type', mime);
          x.upload.onprogress = (e) => { if (e.lengthComputable) patch(id, { pct: Math.round((e.loaded / e.total) * 100) }); };
          x.onload = () => {
            if (x.status >= 200 && x.status < 300) { try { resolve(JSON.parse(x.responseText).id ?? ''); } catch { resolve(''); } }
            else reject(new Error(`Upload stopped (${x.status}). Try again on a better connection.`));
          };
          x.onerror = () => reject(new Error('Upload stopped. Keep eleade Hub open until it finishes, then try again.'));
          x.send(sendFile);
        });
        const { data: clipId } = await supabase.rpc('record_clip', { p_player_id: playerId, p_file_id: fileId, p_file_name: fileName });
        let socialNote = '';
        if (social && clipId) {
          try { await driveApi('/api/drive/social', { clip_id: clipId }); socialNote = ' and copied to Social Media Footage'; }
          catch (e) { socialNote = `. Copy to Social Media Footage failed: ${errorText(e)}`; }
        }
        patch(id, { status: 'done', pct: 100, socialNote });
        window.dispatchEvent(new CustomEvent(CLIP_SAVED, { detail: playerId }));
        setTimeout(() => setUploads((u) => u.filter((x) => x.id !== id)), 6000);
      } catch (e) {
        patch(id, { status: 'error', error: errorText(e) });
      }
    });
    pump();
  }, [pump, shrink]);

  const dismiss = useCallback((id: string) => setUploads((u) => u.filter((x) => x.id !== id)), []);

  // Keep the screen on while uploading, and warn before closing the app.
  const lock = useRef<WakeLock | null>(null);
  useEffect(() => {
    if (!active) { lock.current?.release().catch(() => {}); lock.current = null; return; }
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<WakeLock> } };
    const grab = () => { if (document.visibilityState === 'visible' && nav.wakeLock) nav.wakeLock.request('screen').then((l) => { lock.current = l; }).catch(() => {}); };
    grab();
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    document.addEventListener('visibilitychange', grab);
    return () => { window.removeEventListener('beforeunload', warn); document.removeEventListener('visibilitychange', grab); };
  }, [active]);

  return <UploadCtx.Provider value={{ uploads, start, dismiss }}>{children}</UploadCtx.Provider>;
}

/** Progress for every running upload, shown at the top of every page. */
export function UploadBar() {
  const { uploads, dismiss } = useUploads();
  if (uploads.length === 0) return null;
  return (
    <div className="uploads" role="status" aria-live="polite">
      {uploads.map((u) => (
        <div key={u.id} className={`upload ${u.status}`}>
          <div className="upload-line">
            <span>
              {u.status === 'done' ? `Clip saved to ${u.playerName}'s folder${u.sizeNote ?? ''}${u.socialNote ?? ''}` : u.status === 'error' ? `${u.playerName} clip not uploaded` : u.status === 'starting' ? `${u.playerName} clip waiting` : u.status === 'compressing' ? `Shrinking ${u.playerName} clip ${u.pct}%` : `Uploading ${u.playerName} clip ${u.pct}%`}
            </span>
            {(u.status === 'done' || u.status === 'error') && <button type="button" className="linkbtn" onClick={() => dismiss(u.id)} aria-label="Close">×</button>}
          </div>
          {(u.status === 'uploading' || u.status === 'compressing' || u.status === 'starting') && (
            <>
              <div className="upload-track"><div className="upload-fill" style={{ width: `${u.pct}%` }} /></div>
              <div className="upload-hint">{u.status === 'compressing' ? 'Shrinking the clip first so it uploads faster and saves storage, with no visible loss of quality. ' : ''}You can keep using eleade Hub. Keep the app open until it is saved.</div>
            </>
          )}
          {u.status === 'error' && <div className="upload-hint">{u.error}</div>}
        </div>
      ))}
    </div>
  );
}
