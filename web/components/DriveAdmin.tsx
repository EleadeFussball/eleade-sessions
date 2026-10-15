'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase, errorText } from '@/lib/supabase';
import { driveApi, folderUrl, matchFolder } from '@/lib/drive';
import { fmtDate } from '@/lib/dates';

type Status = { connected: boolean; connected_email: string | null; connected_at: string | null; players_folder_id: string };
type Folder = { id: string; name: string };
type P = { id: string; name: string; active: boolean; drive_folder_id: string | null; drive_folder_name: string | null };

/** Jan only: connect info@eleadefussball.com's Google Drive and link each player to their folder. */
export function DriveAdmin() {
  const [status, setStatus] = useState<Status | null>(null);
  const [players, setPlayers] = useState<P[]>([]);
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    const [s, p] = await Promise.all([
      supabase.rpc('drive_status'),
      supabase.from('players').select('id, name, active, drive_folder_id, drive_folder_name').order('name'),
    ]);
    setStatus(((s.data as Status[]) ?? [])[0] ?? null);
    setPlayers((p.data as P[]) ?? []);
  }, []);

  // Back from Google: save the (encrypted) key with Jan's login, then tidy the address bar.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const keyEnc = q.get('drive_key'); const e = q.get('drive_error');
    if (!keyEnc && !e) { load(); return; }
    window.history.replaceState(null, '', '/admin#drive');
    if (e) { setErr(e); load(); return; }
    const email = q.get('drive_email') ?? '';
    supabase.rpc('drive_connect', { p_token_enc: keyEnc, p_email: email }).then(({ error }) => {
      if (error) setErr(errorText(error));
      else setMsg(`Google Drive connected${email ? ` as ${email}` : ''}.${email && email !== 'info@eleadefussball.com' ? ' Note: that is not info@eleadefussball.com. Tap Reconnect and choose the info account if that was a mistake.' : ''}`);
      load();
    });
  }, [load]);

  async function connect() {
    setBusy('connect'); setErr('');
    try { const { url } = await driveApi<{ url: string }>('/api/google/start'); window.location.href = url; }
    catch (e) { setErr(errorText(e)); setBusy(''); }
  }

  async function loadFolders() {
    setBusy('folders'); setErr(''); setMsg('');
    try {
      const { folders: f } = await driveApi<{ folders: Folder[] }>('/api/drive/folders');
      setFolders(f);
      const taken = new Set(players.map((p) => p.drive_folder_id).filter(Boolean));
      const free = f.filter((x) => !taken.has(x.id));
      const next: Record<string, string> = {};
      players.filter((p) => !p.drive_folder_id).forEach((p) => { const m = matchFolder(p.name, free); if (m) next[p.id] = m.id; });
      setPick(next);
    } catch (e) { setErr(errorText(e)); }
    setBusy('');
  }

  const unlinked = useMemo(() => players.filter((p) => !p.drive_folder_id && (p.active || pick[p.id])), [players, pick]);
  const linked = players.filter((p) => p.drive_folder_id);
  const chosen = Object.entries(pick).filter(([, f]) => f);
  const usedFolders = new Set([...linked.map((p) => p.drive_folder_id), ...Object.values(pick)]);
  const freeFolders = (folders ?? []).filter((f) => !linked.some((p) => p.drive_folder_id === f.id));

  async function saveLinks() {
    setBusy('save'); setErr('');
    const links = chosen.map(([player_id, folder_id]) => ({ player_id, folder_id, folder_name: folders?.find((f) => f.id === folder_id)?.name ?? null }));
    const { error } = await supabase.rpc('set_player_folders', { p_links: links });
    setBusy('');
    if (error) { setErr(errorText(error)); return; }
    setMsg(`${links.length} player${links.length === 1 ? '' : 's'} linked to their folder.`); setPick({}); load();
  }

  async function createFor(p: P) {
    setBusy(p.id); setErr('');
    try {
      const { folder } = await driveApi<{ folder: Folder }>('/api/drive/create-folder', { name: p.name });
      const { error } = await supabase.rpc('set_player_folders', { p_links: [{ player_id: p.id, folder_id: folder.id, folder_name: folder.name }] });
      if (error) throw error;
      setFolders((f) => f ? [...f, folder] : f); setMsg(`Folder created for ${p.name}, with a Game analysis folder inside.`); load();
    } catch (e) { setErr(errorText(e)); }
    setBusy('');
  }

  async function unlink(p: P) {
    const { error } = await supabase.rpc('set_player_folders', { p_links: [{ player_id: p.id, folder_id: null }] });
    if (error) setErr(errorText(error)); else load();
  }

  return (
    <section id="drive">
      <h2>Google Drive</h2>
      {!status ? <p className="empty">Loading</p> : status.connected ? (
        <p>Connected as <strong>{status.connected_email ?? 'Google account'}</strong>{status.connected_at ? ` since ${fmtDate(status.connected_at.slice(0, 10))}` : ''}.
          Clips go into <a href={folderUrl(status.players_folder_id)} target="_blank" rel="noreferrer">Players</a> › player › Session clips.{' '}
          <button type="button" className="linkbtn" onClick={connect} disabled={!!busy}>Reconnect</button></p>
      ) : (
        <>
          <p className="hint">Sign in once with info@eleadefussball.com. Coaches then upload clips from their phones into each player&apos;s folder, without needing Google themselves.</p>
          <button type="button" className="btn small" onClick={connect} disabled={!!busy}>{busy === 'connect' ? 'Opening Google' : 'Connect Google Drive'}</button>
        </>
      )}
      {err && <div className="notice err mt" role="alert">{err}</div>}
      {msg && <div className="notice ok mt" role="status">{msg}</div>}

      {status?.connected && (
        <>
          <h3 className="mt">Player folders</h3>
          <p className="hint">{linked.length} player{linked.length === 1 ? '' : 's'} linked, {players.filter((p) => p.active && !p.drive_folder_id).length} active player{players.filter((p) => p.active && !p.drive_folder_id).length === 1 ? '' : 's'} still without a folder.</p>
          {folders === null ? (
            <button type="button" className="btn small" onClick={loadFolders} disabled={!!busy}>{busy === 'folders' ? 'Reading Drive' : 'Match player folders'}</button>
          ) : (
            <>
              {unlinked.length === 0 ? <p className="empty">Every active player has a folder.</p> : (
                <table className="t">
                  <thead><tr><th>Player</th><th>Folder in Drive</th></tr></thead>
                  <tbody>{unlinked.map((p) => (
                    <tr key={p.id}>
                      <td><Link href={`/players/${p.id}`}>{p.name}</Link>{!p.active && <><br /><span className="hint">Not active</span></>}</td>
                      <td>
                        <select value={pick[p.id] ?? ''} onChange={(e) => setPick({ ...pick, [p.id]: e.target.value })} aria-label={`Folder for ${p.name}`}>
                          <option value="">No folder yet</option>
                          {freeFolders.filter((f) => f.id === pick[p.id] || !usedFolders.has(f.id)).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                        </select>
                        {!pick[p.id] && <button type="button" className="linkbtn" onClick={() => createFor(p)} disabled={!!busy}>{busy === p.id ? 'Creating' : 'Create a folder'}</button>}
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
              {chosen.length > 0 && <button type="button" className="btn small mt" onClick={saveLinks} disabled={!!busy}>{busy === 'save' ? 'Saving' : `Save ${chosen.length} link${chosen.length === 1 ? '' : 's'}`}</button>}
              <p className="hint mt">Suggestions are filled in where the folder name matches the player&apos;s first and last name. Check them, change any that are wrong, then save.</p>
            </>
          )}
          {linked.length > 0 && (
            <details className="mt">
              <summary>Linked players ({linked.length})</summary>
              <ul className="list">{linked.map((p) => (
                <li key={p.id}>{p.name} → <a href={folderUrl(p.drive_folder_id!)} target="_blank" rel="noreferrer">{p.drive_folder_name ?? 'folder'}</a>{' '}
                  <button type="button" className="linkbtn" onClick={() => unlink(p)}>Unlink</button></li>
              ))}</ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
