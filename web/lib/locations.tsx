'use client';
import { useEffect, useState } from 'react';
import { supabase } from './supabase';

export type Pitch = { id: string; name: string; aliases: string[]; address: string | null; place_id: string | null; maps_url: string | null; active: boolean };

let cache: Pitch[] | null = null;
let pending: Promise<Pitch[]> | null = null;
const listeners = new Set<(p: Pitch[]) => void>();

export function loadPitches(force = false): Promise<Pitch[]> {
  if (cache && !force) return Promise.resolve(cache);
  if (!pending || force) {
    pending = Promise.resolve(supabase.from('locations').select('*').order('name')).then(({ data }) => {
      cache = (data as Pitch[]) ?? []; pending = null;
      listeners.forEach((l) => l(cache!));
      return cache;
    });
  }
  return pending;
}

/** Eleade's pitches, loaded once and shared across the app. */
export function usePitches(): Pitch[] {
  const [p, setP] = useState<Pitch[]>(cache ?? []);
  useEffect(() => {
    listeners.add(setP);
    loadPitches().then(setP);
    return () => { listeners.delete(setP); };
  }, []);
  return p;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The saved pitch a typed location refers to (by name or a known short form). */
export function findPitch(text: string | null | undefined, pitches: Pitch[]): Pitch | null {
  const t = norm(text ?? '');
  if (!t) return null;
  return pitches.find((p) => norm(p.name) === t || p.aliases.some((a) => norm(a) === t)) ?? null;
}

export function mapsUrl(p: Pitch): string | null {
  if (p.maps_url) return p.maps_url;
  if (!p.address && !p.place_id) return null;
  const q = new URLSearchParams({ api: '1', query: [p.name, p.address].filter(Boolean).join(', ') });
  if (p.place_id) q.set('query_place_id', p.place_id);
  return `https://www.google.com/maps/search/?${q}`;
}

/** "📍 Queens Park" plus the Google Maps link, for messages to parents. */
export function pitchLines(text: string | null | undefined, pitches: Pitch[]): string {
  if (!text?.trim()) return '';
  const p = findPitch(text, pitches);
  const url = p ? mapsUrl(p) : null;
  return `📍 ${p?.name ?? text.trim()}${url ? `\n${url}` : ''}`;
}

/** One shared suggestion list for every location box (input list="pitches"). */
export function PitchList() {
  const pitches = usePitches();
  return (
    <datalist id="pitches">
      {pitches.filter((p) => p.active).map((p) => <option key={p.id} value={p.name} />)}
    </datalist>
  );
}
