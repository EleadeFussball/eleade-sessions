'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase, errorText } from '@/lib/supabase';
import { fmtDate, num } from '@/lib/dates';

type P = { id: string; name: string; family: string; active: boolean | null };
type L = { player_id: string; kind: string; sessions_delta: number; analyses_delta: number; pairs_delta: number };
type S = { player_id: string; sessions: { session_date: string; format: string; outcome: string } | null };
type Bal = { player_id: string; sessions_left: number | null; analyses_left: number | null; pairs_left: number | null };

const COUNTS = ['attended', 'cancelled_late', 'no_show'];

/** One card per family: what the siblings have done together and what is paid for and left. */
export default function FamiliesPage() {
  const [players, setPlayers] = useState<P[]>([]);
  const [ledger, setLedger] = useState<L[]>([]);
  const [sess, setSess] = useState<S[]>([]);
  const [bal, setBal] = useState<Bal[]>([]);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');

  useEffect(() => {
    (async () => {
      const { data: ps, error } = await supabase.from('players').select('id, name, family, active').not('family', 'is', null).order('name');
      if (error) { setErr(errorText(error)); setLoading(false); return; }
      const list = (ps as P[]) ?? [];
      setPlayers(list);
      const ids = list.map((p) => p.id);
      if (ids.length) {
        const [l, s, b] = await Promise.all([
          supabase.from('credit_ledger').select('player_id, kind, sessions_delta, analyses_delta, pairs_delta').in('player_id', ids),
          supabase.from('session_players').select('player_id, sessions(session_date, format, outcome)').in('player_id', ids).limit(10000),
          supabase.from('player_balances').select('player_id, sessions_left, analyses_left, pairs_left').in('player_id', ids),
        ]);
        if (l.error || s.error || b.error) setErr(errorText(l.error ?? s.error ?? b.error));
        setLedger((l.data as L[]) ?? []); setSess((s.data as unknown as S[]) ?? []); setBal((b.data as Bal[]) ?? []);
      }
      setLoading(false);
    })();
  }, []);

  const families = useMemo(() => {
    const by = new Map<string, P[]>();
    players.forEach((p) => by.set(p.family, [...(by.get(p.family) ?? []), p]));
    return [...by.entries()].filter(([f]) => f.toLowerCase().includes(q.trim().toLowerCase())).map(([family, kids]) => {
      const rows = kids.map((k) => {
        const mine = sess.filter((s) => s.player_id === k.id && s.sessions && COUNTS.includes(s.sessions.outcome) && !['testing', 'assessment'].includes(s.sessions.format));
        const sum = (f: string) => mine.filter((s) => s.sessions!.format === f).length;
        const last = mine.map((s) => s.sessions!.session_date).sort().pop() ?? null;
        return { ...k, one: sum('1:1'), two: sum('2:1'), four: sum('4:1'), analyses: sum('analysis'), last };
      });
      const ids = kids.map((k) => k.id);
      const lg = ledger.filter((x) => ids.includes(x.player_id));
      const paid = (f: 'sessions_delta' | 'analyses_delta' | 'pairs_delta') => lg.filter((x) => Number(x[f]) > 0).reduce((s, x) => s + Number(x[f]), 0);
      const b = bal.find((x) => ids.includes(x.player_id));
      const done = rows.reduce((s, r) => s + r.one + r.two + r.four, 0);
      return { family, rows, done, paidSessions: paid('sessions_delta'), paidAnalyses: paid('analyses_delta'), paidPairs: paid('pairs_delta'),
        left: b?.sessions_left ?? 0, leftAnalyses: b?.analyses_left ?? 0, leftPairs: b?.pairs_left ?? null,
        doneAnalyses: rows.reduce((s, r) => s + r.analyses, 0) };
    }).sort((a, b) => a.family.localeCompare(b.family));
  }, [players, ledger, sess, bal, q]);

  return (
    <>
      <p><Link href="/players">Players</Link></p>
      <h1>Families</h1>
      <p className="hint">Siblings are added and logged one by one. Each family card adds them up: sessions done by every sibling, and the sessions and analyses paid for and still left. Set the family name on each player (Edit player, Family).</p>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search families" aria-label="Search families" />
      {err && <div className="notice err" role="alert">{err}</div>}
      {loading ? <p className="empty">Loading families</p> : families.length === 0 ? <p className="empty">No families yet. Give siblings the same family name on their player pages.</p> : (
        families.map((f) => (
          <section key={f.family} className="panel mt">
            <h2 style={{ marginTop: 0 }}>{f.family} family</h2>
            <p>
              <strong>{num(f.done)}</strong> sessions done · <strong>{num(f.paidSessions)}</strong> paid for · <strong className={Number(f.left) < 0 ? 'neg' : ''}>{num(f.left)}</strong> left<br />
              <strong>{num(f.doneAnalyses)}</strong> analyses done · <strong>{num(f.paidAnalyses)}</strong> paid for · <strong>{num(f.leftAnalyses)}</strong> left
              {f.leftPairs !== null && <><br />2:1 credits: {num(f.paidPairs)} paid for, {num(f.leftPairs)} left</>}
            </p>
            <p className="hint">Sessions done include earlier history that was imported. Paid for includes the opening balance and every package. Late cancellations and no shows count as sessions done.</p>
            <table className="t">
              <thead><tr><th>Player</th><th className="n">1:1</th><th className="n">2:1</th><th className="n">Analysis</th></tr></thead>
              <tbody>{f.rows.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/players/${r.id}`}>{r.name}</Link>{r.active === false ? ' (inactive)' : ''}<br /><span className="hint">{r.last ? `last session ${fmtDate(r.last)}` : 'no sessions yet'}</span></td>
                  <td className="n">{r.one + r.four}</td><td className="n">{r.two}</td><td className="n">{r.analyses}</td>
                </tr>
              ))}</tbody>
            </table>
          </section>
        ))
      )}
    </>
  );
}
