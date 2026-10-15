'use client';
import { supabase } from './supabase';

/** Calls one of the app's Drive routes as the signed-in coach. */
export async function driveApi<T>(path: string, body: unknown = {}): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const r = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token ?? ''}` },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j as T;
}

export const folderUrl = (id: string) => `https://drive.google.com/drive/folders/${id}`;

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();

/** Best folder for a player name: same name, or a folder name that contains the first and last name. */
export function matchFolder<F extends { id: string; name: string }>(player: string, folders: F[]): F | null {
  const p = norm(player);
  const exact = folders.filter((f) => norm(f.name) === p);
  if (exact.length === 1) return exact[0];
  const words = p.split(' ');
  const first = words[0], last = words[words.length - 1];
  const hits = folders.filter((f) => { const w = norm(f.name).split(' '); return w.includes(first) && w.includes(last); });
  return hits.length === 1 ? hits[0] : null;
}
