'use client';
import { useMemo, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { fmtDate, todayISO } from '@/lib/dates';
import { FORMAT_LABEL } from '@/lib/types';
import { entryKey, hhmm, minutesOf, timeOf, type ScheduleEntry } from '@/lib/schedule';

const SNAP = 15;            // sessions start on a quarter hour
const HOUR = 52;            // pixels per hour
const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

type Props = {
  days: string[];
  entries: ScheduleEntry[];
  selected: string | null;
  onPickSlot: (day: string, time: string) => void;
  onPickEntry: (o: ScheduleEntry) => void;
  onMove: (o: ScheduleEntry, day: string, time: string) => void;
};

/** Side-by-side columns for sessions that overlap in time. */
function layout(list: ScheduleEntry[]) {
  const sorted = [...list].sort((a, b) => (minutesOf(a.start_time)! - minutesOf(b.start_time)!) || b.minutes - a.minutes);
  const out: { o: ScheduleEntry; col: number; cols: number }[] = [];
  let group: typeof out = [];
  let groupEnd = -1;
  const close = () => {
    const cols = group.reduce((n, g) => Math.max(n, g.col + 1), 0);
    group.forEach((g) => { g.cols = cols; });
    out.push(...group);
    group = [];
    groupEnd = -1;
  };
  for (const o of sorted) {
    const from = minutesOf(o.start_time)!;
    const to = from + o.minutes;
    if (from >= groupEnd && group.length) close();
    const taken = new Set(group.filter((g) => minutesOf(g.o.start_time)! + g.o.minutes > from).map((g) => g.col));
    let col = 0;
    while (taken.has(col)) col++;
    group.push({ o, col, cols: 1 });
    groupEnd = Math.max(groupEnd, to);
  }
  if (group.length) close();
  return out;
}

export function CalendarGrid({ days, entries, selected, onPickSlot, onPickEntry, onMove }: Props) {
  const { coach, coaches, isAdmin } = useAuth();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ key: string; day: string; mins: number } | null>(null);
  const dragRef = useRef<{ key: string; day: string; mins: number } | null>(null);

  const timed = entries.filter((o) => o.start_time);
  const untimed = entries.filter((o) => !o.start_time && days.includes(o.session_date));

  const [from, to] = useMemo(() => {
    let lo = 7 * 60, hi = 20 * 60;
    for (const o of timed) {
      const s = minutesOf(o.start_time)!;
      lo = Math.min(lo, Math.floor(s / 60) * 60);
      hi = Math.max(hi, Math.ceil((s + o.minutes) / 60) * 60);
    }
    return [Math.max(0, lo - 60), Math.min(24 * 60, hi + 60)];
  }, [timed]);
  const hours = Array.from({ length: (to - from) / 60 }, (_, i) => from + i * 60);
  const height = ((to - from) / 60) * HOUR;
  const today = todayISO();
  const nowMins = new Date().getHours() * 60 + new Date().getMinutes();

  function timeAt(e: { clientY: number }, el: HTMLElement) {
    const box = el.getBoundingClientRect();
    const mins = from + ((e.clientY - box.top) / HOUR) * 60;
    return Math.max(from, Math.min(to - SNAP, Math.round(mins / SNAP) * SNAP));
  }

  function dayAt(clientX: number) {
    const cols = bodyRef.current?.querySelectorAll<HTMLElement>('[data-day]');
    for (const c of cols ?? []) {
      const b = c.getBoundingClientRect();
      if (clientX >= b.left && clientX <= b.right) return c.dataset.day!;
    }
    return null;
  }

  return (
    <div className="grid-wrap">
      <div className="grid-head" style={{ gridTemplateColumns: `44px repeat(${days.length}, 1fr)` }}>
        <div />
        {days.map((d) => (
          <div key={d} className={d === today ? 'gh on' : 'gh'}>
            <span className="gh-day">{DAY_SHORT[(new Date(d).getDay() + 6) % 7]}</span>
            <span className="gh-num">{Number(d.slice(8))}</span>
          </div>
        ))}
      </div>

      {untimed.length > 0 && (
        <div className="grid-allday" style={{ gridTemplateColumns: `44px repeat(${days.length}, 1fr)` }}>
          <div className="gt-label">no time</div>
          {days.map((d) => (
            <div key={d} className="ad-col">
              {untimed.filter((o) => o.session_date === d).map((o) => (
                <button key={entryKey(o)} type="button" className={`ev ev-${o.kind} flat${selected === entryKey(o) ? ' on' : ''}`}
                        onClick={() => onPickEntry(o)} title={`${o.players} · ${FORMAT_LABEL[o.format]}`}>
                  {o.players}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="grid-body" ref={bodyRef} style={{ gridTemplateColumns: `44px repeat(${days.length}, 1fr)`, height }}>
        <div className="grid-times">
          {hours.map((h) => <div key={h} className="gt" style={{ height: HOUR }}><span>{hhmm(timeOf(h))}</span></div>)}
        </div>
        {days.map((day) => {
          const placed = layout(timed.filter((o) => o.session_date === day));
          return (
            <div key={day} className={`grid-col${day === today ? ' today' : ''}`} data-day={day}
                 style={{ backgroundSize: `100% ${HOUR}px` }}
                 onClick={(e) => {
                   if ((e.target as HTMLElement).closest('.ev')) return;
                   onPickSlot(day, timeOf(timeAt(e, e.currentTarget)));
                 }}>
              {day === today && nowMins > from && nowMins < to && (
                <div className="grid-now" style={{ top: ((nowMins - from) / 60) * HOUR }} />
              )}
              {placed.map(({ o, col, cols }) => {
                const key = entryKey(o);
                const dragging = drag?.key === key;
                const startM = dragging ? drag.mins : minutesOf(o.start_time)!;
                const mine = isAdmin || o.coach_id === coach?.id;
                const done = !!o.session_id;
                return (
                  <button
                    key={key} type="button" data-ev={key}
                    className={`ev ev-${o.kind}${done ? ' done' : ''}${selected === key ? ' on' : ''}${dragging ? ' dragging' : ''}`}
                    style={{
                      top: ((startM - from) / 60) * HOUR + 1,
                      height: Math.max(22, (o.minutes / 60) * HOUR - 2),
                      left: `calc(${(col / cols) * 100}% + 2px)`,
                      width: `calc(${100 / cols}% - 4px)`,
                    }}
                    onClick={() => { if (!dragRef.current) onPickEntry(o); }}
                    onPointerDown={(e) => {
                      if (e.pointerType !== 'mouse' || done || !mine) return;
                      const col0 = (e.currentTarget.parentElement as HTMLElement);
                      const grab = timeAt(e, col0) - minutesOf(o.start_time)!;
                      const startX = e.clientX, startY = e.clientY;
                      let moved = false;
                      const onMoveEv = (ev: PointerEvent) => {
                        if (!moved && Math.abs(ev.clientX - startX) < 4 && Math.abs(ev.clientY - startY) < 4) return;
                        moved = true;
                        const target = dayAt(ev.clientX) ?? day;
                        const mins = Math.max(from, Math.min(to - o.minutes, timeAt(ev, col0) - grab));
                        const next = { key, day: target, mins };
                        dragRef.current = next;
                        setDrag(next);
                      };
                      const onUp = () => {
                        window.removeEventListener('pointermove', onMoveEv);
                        window.removeEventListener('pointerup', onUp);
                        const d = dragRef.current;
                        dragRef.current = null;
                        setDrag(null);
                        if (!moved || !d) return;
                        if (d.day !== day || d.mins !== minutesOf(o.start_time)) onMove(o, d.day, timeOf(d.mins));
                      };
                      window.addEventListener('pointermove', onMoveEv);
                      window.addEventListener('pointerup', onUp);
                    }}
                  >
                    <span className="ev-time">{hhmm(o.start_time)}</span>
                    <span className="ev-name">{o.players}</span>
                    <span className="ev-sub">
                      {FORMAT_LABEL[o.format]}
                      {(!mine || isAdmin) && ` · ${coaches.find((c) => c.id === o.coach_id)?.name ?? ''}`}
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      <p className="hint mt">Tap an empty slot to add a session. Tap a session to open it. On a computer you can drag a session to another time.</p>
    </div>
  );
}
