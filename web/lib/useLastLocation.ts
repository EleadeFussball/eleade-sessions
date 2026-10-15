'use client';
import { useCallback, useEffect, useRef } from 'react';
import { lastLocation } from './schedule';

/**
 * Fills the location with the place the first chosen player was last coached.
 * Anything the coach types or picks wins, and is never overwritten.
 * With `off` (game analysis) nothing is filled in, because the field holds the opponent.
 * Returns `edit` (use it wherever the person changes the location) and `reset` (after saving).
 */
export function useLastLocation(firstPlayerId: string | undefined, setLocation: (l: string) => void, off = false) {
  const touched = useRef(false);
  const wasOff = useRef(off);
  useEffect(() => {
    // Game analysis uses the same field for the opponent: start it empty, and empty it again when switching back.
    if (off !== wasOff.current) { wasOff.current = off; touched.current = false; setLocation(''); }
    if (off || !firstPlayerId || touched.current) return;
    let alive = true;
    lastLocation(firstPlayerId).then((l) => { if (alive && !touched.current && l) setLocation(l); });
    return () => { alive = false; };
  }, [firstPlayerId, setLocation, off]);
  const edit = useCallback((value: string) => { touched.current = true; setLocation(value); }, [setLocation]);
  const reset = useCallback(() => { touched.current = false; }, []);
  return { edit, reset };
}
