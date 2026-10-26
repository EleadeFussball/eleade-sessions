'use client';
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { fmtDate, num } from '@/lib/dates';
import { FORMAT_LABEL, type Format } from '@/lib/types';

type LedgerRow = {
  id: string; player_id: string; kind: string; sessions_delta: number; pairs_delta: number; analyses_delta: number;
  package_name: string | null; effective_date: string; created_at: string;
};
type UsageRow = {
  player_id: string; session_id: string; session_date: string; format: Format; outcome: string;
  sessions_used: number; pairs_used: number; analyses_used: number;
};
type Kind = 'sessions' | 'pairs' | 'analyses';
type Covered = { date: string; format: Format; outcome: string; amount: number };
type Bucket = { id: string; name: string; date: string; total: number; before: number; used: Covered[] };

const KIND_NAME: Record<string, string> = { opening: 'Opening balance', purchase: 'Package', free: 'Free sessions', correction: 'Correction', expiry: 'Expired' };

/** Hand each used credit to the oldest package that still has room (the order credits are used in). */
export function allocate(rows: LedgerRow[], usage: UsageRow[], kind: Kind) {
  const delta = (l: LedgerRow) => Number(kind === 'sessions' ? l.sessions_delta : kind === 'pairs' ? l.pairs_delta : l.analyses_delta);
  const used = (u: UsageRow) => Number(kind === 'sessions' ? u.sessions_used : kind === 'pairs' ? u.pairs_used : u.analyses_used);
  const entries = rows.filter((l) => delta(l) !== 0)
    .sort((a, b) => a.effective_date.localeCompare(b.effective_date) || a.created_at.localeCompare(b.created_at));
  const buckets: Bucket[] = entries.filter((l) => delta(l) > 0).map((l) => ({
    id: l.id, name: l.package_name || KIND_NAME[l.kind] || l.kind, date: l.effective_date, total: delta(l), before: 0, used: [],
  }));
  const room = (b: Bucket) => b.total - b.before - b.used.reduce((s, c) => s + c.amount, 0);
  // takes and corrections that are not packages reduce the oldest packages first
  for (const l of entries.filter((x) => delta(x) < 0)) {
    let left = -delta(l);
    for (const b of buckets) { const t = Math.min(left, Math.max(room(b), 0)); b.before += t; left -= t; if (left <= 0) break; }
  }
  let notCovered = 0;
  for (const u of usage.filter((x) => used(x) > 0).sort((a, b) => a.session_date.localeCompare(b.session_date))) {
    let left = used(u);
    for (const b of buckets) {
      const t = Math.min(left, Math.max(room(b), 0));
      if (t > 0) { b.used.push({ date: u.session_date, format: u.format, outcome: u.outcome, amount: t }); left -= t; }
      if (left <= 0.00001) break;
    }
    if (left > 0.00001) notCovered += left;
  }
  return { buckets, notCovered, hasAny: entries.length > 0 || usage.some((u) => used(u) > 0) };
}

const outcomeNote = (o: string) => (o === 'cancelled_late' ? ' (late cancellation)' : o === 'no_show' ? ' (no show)' : '');

/** For a package player: each package, how much of it is used, and which sessions it covered. */
export function PackageCoverage({ playerId, family }: { playerId: string; family: string | null }) {
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      let ids = [playerId];
      if (family) {
        const { data } = await supabase.from('players').select('id').eq('family', family);
        ids = [...new Set([playerId, ...((data as { id: string }[] | null) ?? []).map((x) => x.id)])];
      }
      const [l, u] = await Promise.all([
        supabase.from('credit_ledger').select('id, player_id, kind, sessions_delta, pairs_delta, analyses_delta, package_name, effective_date, created_at').in('player_id', ids),
        supabase.from('credit_usage').select('player_id, session_id, session_date, format, outcome, sessions_used, pairs_used, analyses_used').in('player_id', ids),
      ]);
      if (!live) return;
      setRows((l.data as LedgerRow[]) ?? []); setUsage((u.data as UsageRow[]) ?? []); setLoaded(true);
    })();
    return () => { live = false; };
  }, [playerId, family]);

  const hasPairs = rows.some((r) => Number(r.pairs_delta) !== 0);
  const groups = useMemo(() => ([
    { kind: 'sessions' as Kind, title: hasPairs ? '1:1 sessions' : 'Sessions' },
    { kind: 'pairs' as Kind, title: '2:1 sessions' },
    { kind: 'analyses' as Kind, title: 'Game analyses' },
  ].map((g) => ({ ...g, ...allocate(rows, usage, g.kind) })).filter((g) => g.hasAny)), [rows, usage, hasPairs]);

  if (!loaded || groups.length === 0) return null;
  const unit = (k: Kind, n: number) => (k === 'analyses' ? (n === 1 ? 'analysis' : 'analyses') : n === 1 ? 'session' : 'sessions');

  return (
    <>
      <h2>Packages</h2>
      {family && <p className="hint">Credits are shared with the {family} family, so a package may have been used by a sibling.</p>}
      {groups.map((g) => (
        <div key={g.kind} className="mt">
          <p style={{ marginBottom: 6 }}><strong>{g.title}</strong></p>
          <ul className="list">
            {g.buckets.map((b) => {
              const usedN = b.used.reduce((s, c) => s + c.amount, 0);
              const left = b.total - b.before - usedN;
              return (
                <li key={b.id} className="session">
                  <div className="head">
                    <span>{b.name} · {fmtDate(b.date)}</span>
                    <span className={left <= 0 ? 'tag amber' : 'tag turf'}>{left <= 0 ? 'Used up' : `${num(left)} left`}</span>
                  </div>
                  <div className="sub">
                    {num(b.total)} {unit(g.kind, b.total)}: {num(usedN)} used in the app{b.before > 0 ? `, ${num(b.before)} used before the app or adjusted` : ''}
                  </div>
                  {b.used.length > 0 && (
                    <details>
                      <summary className="hint">Sessions covered by this package</summary>
                      <ul className="list">
                        {b.used.map((c, i) => (
                          <li key={i}>{fmtDate(c.date)}, {FORMAT_LABEL[c.format] ?? c.format}{outcomeNote(c.outcome)}{c.amount !== 1 ? ` (${num(c.amount)} credit)` : ''}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
          {g.notCovered > 0 && (
            <div className="notice err">{num(g.notCovered)} {unit(g.kind, g.notCovered)} not covered by a package yet. A new {g.title.toLowerCase()} package is needed.</div>
          )}
        </div>
      ))}
    </>
  );
}
