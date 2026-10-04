'use client';
import { useCallback, useEffect, useRef } from 'react';
import { lastLocation } from './schedule';

/**
 * Fills the location with the place the first chosen player was last coached.
 * Anything the coach types or picks wins, and is never overwritten.
 * Returns `edit` (use it wherever the person changes the location) and `reset` (after saving).
 */
export function useLastLocation(firstPlayerId: string | undefined, setLocation: (l: string) => void) {
  const touched = useRef(false);
  useEffect(() => {
    if (!firstPlayerId || touched.current) return;
    let alive = true;
    lastLocation(firstPlayerId).then((l) => { if (alive && !touched.current && l) setLocation(l); });
    return () => { alive = false; };
  }, [firstPlayerId, setLocation]);
  const edit = useCallback((value: string) => { touched.current = true; setLocation(value); }, [setLocation]);
  const reset = useCallback(() => { touched.current = false; }, []);
  return { edit, reset };
}
