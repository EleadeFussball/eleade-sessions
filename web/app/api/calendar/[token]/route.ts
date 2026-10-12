// Private calendar link for a coach: iPhone, Google and Outlook calendars subscribe to this address.
// The long token in the address is the only key; the database returns nothing for a wrong one.
import { FORMAT_LABEL, type Format } from '@/lib/types';

export const dynamic = 'force-dynamic';

type Row = {
  coach_name: string; kind: string; ref_id: string; plan_date: string | null; session_date: string; start_time: string | null;
  minutes: number; format: Format; location: string | null; note: string | null; players: string | null;
  done: boolean; outcome: string | null; prep: string | null;
};

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
/** Lines longer than 75 bytes are folded (RFC 5545). */
function fold(line: string): string {
  const out: string[] = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > 74) { out.push(cur); cur = ' ' + ch; } else cur += ch;
  }
  out.push(cur);
  return out.join('\r\n');
}
const ymd = (d: string) => d.replace(/-/g, '');
/** Local Sydney date + time + minutes, as an iCalendar local time (date rolls over past midnight). */
function local(date: string, time: string, plusMins = 0): string {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, h, mi + plusMins));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}T${p(t.getUTCHours())}${p(t.getUTCMinutes())}00`;
}
const nextDay = (date: string) => local(date, '00:00', 24 * 60).slice(0, 8);

const VTIMEZONE = [
  'BEGIN:VTIMEZONE', 'TZID:Australia/Sydney',
  'BEGIN:STANDARD', 'DTSTART:19700405T030000', 'TZOFFSETFROM:+1100', 'TZOFFSETTO:+1000', 'RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU', 'TZNAME:AEST', 'END:STANDARD',
  'BEGIN:DAYLIGHT', 'DTSTART:19701004T020000', 'TZOFFSETFROM:+1000', 'TZOFFSETTO:+1100', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=1SU', 'TZNAME:AEDT', 'END:DAYLIGHT',
  'END:VTIMEZONE',
];

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const clean = token.replace(/\.ics$/i, '');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key || !/^[a-f0-9]{32,}$/i.test(clean)) return new Response('Not found', { status: 404 });

  const r = await fetch(`${url}/rest/v1/rpc/calendar_feed`, {
    method: 'POST',
    headers: { apikey: key, ...(key.startsWith('sb_') ? {} : { Authorization: `Bearer ${key}` }), 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_token: clean }),
    cache: 'no-store',
  });
  if (!r.ok) return new Response('Calendar not available right now', { status: 503 });
  const rows = (await r.json()) as Row[];

  const origin = new URL(req.url).origin;
  const name = rows[0]?.coach_name ? `Eleade · ${rows[0].coach_name}` : 'Eleade';
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines: string[] = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Eleade//eleade Hub//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(name)}`, 'X-WR-TIMEZONE:Australia/Sydney',
    'REFRESH-INTERVAL;VALUE=DURATION:PT15M', 'X-PUBLISHED-TTL:PT15M',
    ...VTIMEZONE,
  ];
  for (const e of rows) {
    const label = FORMAT_LABEL[e.format] ?? e.format;
    const who = e.players || label;
    const summary = `${e.done ? '✓ ' : ''}${who}${e.format !== '1:1' && e.players ? ` (${label})` : ''}`;
    const desc = [
      `${label}${e.done ? ', documented' : ''}`,
      e.prep ? `Plan: ${e.prep}` : '',
      e.note ? `Note: ${e.note}` : '',
      `Open in eleade Hub: ${origin}/`,
    ].filter(Boolean).join('\n');
    lines.push('BEGIN:VEVENT',
      `UID:${e.kind}-${e.ref_id}-${e.plan_date ?? e.session_date}@eleade-hub`,
      `DTSTAMP:${stamp}`,
      ...(e.start_time
        ? [`DTSTART;TZID=Australia/Sydney:${local(e.session_date, e.start_time)}`, `DTEND;TZID=Australia/Sydney:${local(e.session_date, e.start_time, e.minutes || 60)}`]
        : [`DTSTART;VALUE=DATE:${ymd(e.session_date)}`, `DTEND;VALUE=DATE:${nextDay(e.session_date)}`]),
      `SUMMARY:${esc(summary)}`,
      ...(e.location ? [`LOCATION:${esc(e.location)}`] : []),
      `DESCRIPTION:${esc(desc)}`,
      'STATUS:CONFIRMED', 'TRANSP:OPAQUE',
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');

  return new Response(lines.map(fold).join('\r\n') + '\r\n', {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="eleade.ics"',
      'Cache-Control': 'private, max-age=300',
    },
  });
}
