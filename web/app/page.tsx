'use client';
import { DocsTodo } from '@/components/DocsTodo';
import { VideosDue } from '@/components/VideosDue';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth';
import { addDays, fmtDate, todayISO } from '@/lib/dates';
import { coachColour, entryKey, hhmm, loadSchedule, timeRange, type ScheduleEntry } from '@/lib/schedule';
import { FORMAT_LABEL } from '@/lib/types';
import { ScheduleItem } from '@/components/ScheduleItem';
import { Sheet } from '@/components/Sheet';
import { CalendarView } from '@/components/CalendarView';
import { CalendarLink } from '@/components/CalendarLink';

/** Your week: today and tomorrow, sessions still to confirm, the calendar, and logging a session. */
export default function YourWeek() {
  const { coach } = useAuth();
  const [items, setItems] = useState<ScheduleEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [calKey, setCalKey] = useState(0);
  const [showLink, setShowLink] = useState(false);
  const today = todayISO();
  const tomorrow = addDays(today, 1);

  const load = useCallback(async () => {
    if (!coach) return;
    const all = await loadSchedule(addDays(today, -7), tomorrow);
    setItems(all.filter((o) => o.coach_id === coach.id));
    setLoaded(true);
  }, [coach, today, tomorrow]);
  useEffect(() => { load(); }, [load]);

  const open = items.find((o) => entryKey(o) === openKey) ?? null;
  const overdue = items.filter((o) => o.session_date < today && !o.session_id);
  const colour = coachColour(coach?.name);

  function Day({ day, label }: { day: string; label: string }) {
    const list = items.filter((o) => o.session_date === day)
      .sort((a, b) => (a.start_time ?? '99').localeCompare(b.start_time ?? '99'));
    return (
      <section className="day-col" aria-label={label}>
        <h2>{label}<span className="day-date">{fmtDate(day, true).replace(/ \d{4}$/, '')}</span></h2>
        {!loaded ? <p className="empty">Loading</p> : list.length === 0 ? <p className="empty">No sessions.</p> : list.map((o) => {
          const done = !!o.session_id;
          return (
            <button key={entryKey(o)} type="button" className={`day-card${done ? ' done' : ''}${o.outcome === 'cancelled_in_time' ? ' cx' : ''}`}
                    style={{ ['--cc' as string]: colour } as React.CSSProperties} onClick={() => setOpenKey(entryKey(o))}>
              <div className="dc-time">{timeRange(o.start_time, o.minutes) || 'No time set'}</div>
              <div className="dc-name">{o.players ?? FORMAT_LABEL[o.format]}</div>
              <div className="dc-sub">{FORMAT_LABEL[o.format]}{o.location ? `, ${o.location}` : ''}</div>
              <span className="dc-state">{o.outcome === 'cancelled_in_time' ? '✕ Cancelled' : done ? '✓ Documented' : o.prep ? '✓ Planned' : day === today ? 'Plan or document' : 'Plan session'}</span>
            </button>
          );
        })}
      </section>
    );
  }

  const refresh = () => { load(); setCalKey((k) => k + 1); };

  return (
    <>
      <h1>Your week</h1>
      {coach && <DocsTodo coachId={coach.id} />}
      {coach && <VideosDue coachId={coach.id} />}
      <div className="days2">
        <Day day={today} label="Today" />
        <Day day={tomorrow} label="Tomorrow" />
      </div>

      {overdue.length > 0 && (
        <section className="planned" aria-label="Still to confirm">
          <h2 style={{ marginTop: 0 }}>Still to confirm</h2>
          <ul className="list">{overdue.map((o) => <ScheduleItem key={entryKey(o)} o={o} onDone={refresh} showDay />)}</ul>
        </section>
      )}

      <h2>Calendar</h2>
      <CalendarView reloadKey={calKey} onChanged={load} />
      {coach && (
        <div className="mt">
          {!showLink
            ? <button type="button" className="linkbtn" onClick={() => setShowLink(true)}>Show my sessions in my phone calendar</button>
            : <CalendarLink />}
        </div>
      )}

      <h2 className="mt">Log a session</h2>
      <p className="hint">For a session that is not in the calendar, for example one arranged at short notice.</p>
      <Link href="/log" className="btn block">Log a session</Link>

      {open && (
        <Sheet title={`${fmtDate(open.session_date, true)}${open.start_time ? `, ${hhmm(open.start_time)}` : ''}`} onClose={() => setOpenKey(null)}>
          <ul className="list" style={{ borderTop: 0 }}>
            <ScheduleItem key={entryKey(open) + (open.prep ?? '')} o={open} startMode={!open.session_id && open.kind !== 'logged' && open.session_date <= todayISO() ? 'done' : ''} onDone={() => { setOpenKey(null); refresh(); }} />
          </ul>
        </Sheet>
      )}
    </>
  );
}
