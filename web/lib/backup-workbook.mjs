// Builds the full Eleade backup workbook (used by the Admin download button and the nightly Drive job).
// ExcelJS is passed in so the same code runs in the browser and in Node.
// fetchTable(name) must resolve to an array of row objects.

const TABLES = [
  'players', 'coaches', 'sessions', 'session_players', 'credit_ledger', 'player_balances',
  'payments', 'stripe_payments', 'coach_invoices', 'invoice_lines', 'player_notes',
  'bookings', 'booking_players', 'session_plans', 'plan_players', 'coach_rates', 'settings',
];
// bank details never go into the backup file
const DROP = { coach_invoices: ['bsb', 'account_number', 'account_name'] };

const pretty = (k) => k.replace(/_/g, ' ');

function addSheet(wb, name, rows, cols) {
  const ws = wb.addWorksheet(name.slice(0, 31));
  const keys = cols ?? (rows.length ? Object.keys(rows[0]) : []);
  ws.columns = keys.map((k) => ({ header: pretty(k), key: k, width: Math.min(40, Math.max(10, pretty(k).length + 2)) }));
  for (const r of rows) ws.addRow(keys.map((k) => { const v = r[k]; return v !== null && typeof v === 'object' ? JSON.stringify(v) : v; }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  if (keys.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: keys.length } };
  return ws;
}

export async function buildBackupWorkbook(ExcelJS, fetchTable, stamp) {
  const data = {};
  for (const t of TABLES) data[t] = await fetchTable(t);
  const pName = new Map(data.players.map((p) => [p.id, p.name]));
  const cName = new Map(data.coaches.map((c) => [c.id, c.name]));
  const byId = (rows) => new Map(rows.map((r) => [r.id, r]));
  const sess = byId(data.sessions);

  const wb = new ExcelJS.Workbook();
  wb.created = new Date();

  const readme = addSheet(wb, 'Read me', [
    { info: 'Eleade backup', value: stamp },
    { info: 'Source', value: 'eleade Hub database (read-only copy, edit data in the app, not here)' },
    ...TABLES.map((t) => ({ info: `Rows: ${t}`, value: data[t].length })),
  ], ['info', 'value']);
  readme.getColumn(1).width = 30; readme.getColumn(2).width = 70;

  const players = data.players.map((p) => ({ ...p, main_coach: cName.get(p.main_coach_id) ?? '' }));
  addSheet(wb, 'Players', players, ['name', 'family', 'billing_model', 'session_price', 'main_coach', 'active', 'opening_confirmed', 'profile_notes', 'created_at', 'id']);

  const bal = data.player_balances.map((b) => ({ ...b, main_coach: cName.get(b.main_coach_id) ?? '' }));
  addSheet(wb, 'Balances', bal, ['name', 'family', 'billing_model', 'active', 'sessions_left', 'analyses_left', 'pairs_left', 'last_purchase', 'next_expiry', 'last_session', 'sessions_used_live']);

  const plist = new Map();
  for (const sp of data.session_players) {
    if (!plist.has(sp.session_id)) plist.set(sp.session_id, []);
    plist.get(sp.session_id).push(pName.get(sp.player_id) ?? sp.player_id);
  }
  const sessions = data.sessions
    .map((s) => ({ ...s, coach: cName.get(s.coach_id) ?? '', players: (plist.get(s.id) ?? []).join(', ') }))
    .sort((a, b) => String(b.session_date).localeCompare(String(a.session_date)));
  const sCols = ['session_date', 'start_time', 'coach', 'players', 'format', 'outcome', 'location', 'topic', 'observations', 'improve'];
  const extra = sessions.length ? Object.keys(sessions[0]).filter((k) => !sCols.includes(k) && !['coach_id'].includes(k)) : [];
  addSheet(wb, 'Sessions', sessions, [...sCols, ...extra]);

  const perPlayer = data.session_players.map((sp) => {
    const s = sess.get(sp.session_id) ?? {};
    return { player: pName.get(sp.player_id) ?? sp.player_id, session_date: s.session_date, format: s.format, outcome: s.outcome, coach: cName.get(s.coach_id) ?? '', imported: s.imported, topic: s.topic, observations: s.observations, improve: s.improve };
  }).sort((a, b) => String(a.player).localeCompare(String(b.player)) || String(b.session_date).localeCompare(String(a.session_date)));
  addSheet(wb, 'Sessions by player', perPlayer);

  const ledger = data.credit_ledger.map((l) => ({ ...l, player: pName.get(l.player_id) ?? l.player_id }))
    .sort((a, b) => String(a.player).localeCompare(String(b.player)) || String(a.effective_date).localeCompare(String(b.effective_date)));
  addSheet(wb, 'Credit ledger', ledger, ['player', 'effective_date', 'kind', 'package_name', 'sessions_delta', 'analyses_delta', 'pairs_delta', 'amount_paid', 'reason', 'expires_on', 'created_at']);

  addSheet(wb, 'Payments', data.payments.map((p) => ({ ...p, player: pName.get(p.player_id) ?? p.player_id })), ['player', 'week_start', 'amount', 'received_on', 'note', 'created_at']);
  addSheet(wb, 'Stripe payments', data.stripe_payments.map((p) => ({ ...p, player: pName.get(p.player_id) ?? '' })), ['player', 'paid_at', 'amount_total', 'currency', 'purpose', 'for_what', 'customer_name', 'customer_email', 'stripe_session_id']);

  const inv = byId(data.coach_invoices);
  addSheet(wb, 'Coach invoices', data.coach_invoices.map((r) => { const o = { ...r }; for (const k of DROP.coach_invoices) delete o[k]; return o; }),
    ['coach_name', 'number', 'period_start', 'period_end', 'issued_on', 'total', 'status', 'submitted_at', 'paid_at']);
  addSheet(wb, 'Invoice lines', data.invoice_lines.map((l) => ({ ...l, invoice: inv.get(l.invoice_id) ? `${inv.get(l.invoice_id).coach_name} #${inv.get(l.invoice_id).number}` : '' })), ['invoice', 'line_date', 'description', 'amount', 'is_correction']);

  addSheet(wb, 'Player notes', data.player_notes.map((n) => ({ ...n, player: pName.get(n.player_id) ?? n.player_id })), ['player', 'created_at', 'author', 'body']);
  addSheet(wb, 'Bookings', data.bookings.map((b) => ({ ...b, coach: cName.get(b.coach_id) ?? '', players: data.booking_players.filter((x) => x.booking_id === b.id).map((x) => pName.get(x.player_id)).join(', ') })),
    ['session_date', 'start_time', 'coach', 'players', 'format', 'location', 'note', 'cancelled_at', 'minutes']);
  addSheet(wb, 'Regular sessions', data.session_plans.map((p) => ({ ...p, coach: cName.get(p.coach_id) ?? '', players: data.plan_players.filter((x) => x.plan_id === p.id).map((x) => pName.get(x.player_id)).join(', ') })),
    ['weekday', 'start_time', 'coach', 'players', 'format', 'location', 'starts_on', 'ends_on', 'minutes']);
  addSheet(wb, 'Coaches', data.coaches.map((c) => ({ ...c })), ['name', 'email', 'is_admin', 'active', 'salaried', 'paid_separately']);
  addSheet(wb, 'Coach rates', data.coach_rates.map((r) => ({ ...r, coach: cName.get(r.coach_id) ?? '' })), ['coach', 'one_to_one', 'two_to_one', 'four_to_one', 'analysis', 'testing', 'assessment']);
  addSheet(wb, 'Settings', data.settings, ['key', 'value']);
  return wb;
}
