// Nightly backup: reads every table from Supabase (service key), builds the Excel workbook and
// sends it to a Google Apps Script web app that overwrites one file in Google Drive (Drive keeps the earlier versions). No other dependencies than exceljs.
import fs from 'node:fs';
import ExcelJS from 'exceljs';
import { buildBackupWorkbook } from '../../web/lib/backup-workbook.mjs';

const env = process.env;
const SUPABASE_URL = env.SUPABASE_URL?.trim().replace(/\/$/, ''), SUPABASE_SERVICE_KEY = env.SUPABASE_SERVICE_KEY?.trim();
const { APPS_SCRIPT_URL, BACKUP_SECRET } = env;
// Errors are reported as GitHub annotations so they show on the run summary page (never the key itself).
const report = (e) => { console.log(`::error::${String(e?.cause?.code ?? '')} ${String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 500)}`); process.exit(1); };
process.on('uncaughtException', report); process.on('unhandledRejection', report);
if (!SUPABASE_URL) throw new Error('Secret SUPABASE_URL is missing or empty');
if (!SUPABASE_SERVICE_KEY) throw new Error('Secret SUPABASE_SERVICE_KEY is missing or empty');
if (!/^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(SUPABASE_URL.trim())) throw new Error(`SUPABASE_URL looks wrong (length ${SUPABASE_URL.length}, starts "${SUPABASE_URL.slice(0, 12)}")`);
console.log(`Key type: ${SUPABASE_SERVICE_KEY.trim().slice(0, 9)}..., length ${SUPABASE_SERVICE_KEY.length}`);

async function fetchTable(table) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, ...(SUPABASE_SERVICE_KEY.startsWith('sb_') ? {} : { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` }), Range: `${from}-${from + 999}`, 'Range-Unit': 'items' },
    });
    if (!r.ok) throw new Error(`${table}: ${r.status} ${await r.text()}`);
    const page = await r.json();
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

const stamp = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'full', timeStyle: 'short' });
const wb = await buildBackupWorkbook(ExcelJS, fetchTable, stamp);
const buf = Buffer.from(await wb.xlsx.writeBuffer());
fs.writeFileSync('eleade-backup.xlsx', buf);
console.log(`Workbook built (${(buf.length / 1024).toFixed(0)} KB)`);

if (!APPS_SCRIPT_URL || !BACKUP_SECRET) { console.log('No Drive settings, file kept locally only'); process.exit(0); }

// The Google Apps Script web app (scripts/backup/drive-receiver.gs) runs as the Drive owner and overwrites the file.
const res = await fetch(APPS_SCRIPT_URL, {
  method: 'POST', redirect: 'follow',
  headers: { 'Content-Type': 'text/plain' },
  body: JSON.stringify({ secret: BACKUP_SECRET, data: buf.toString('base64') }),
});
const text = await res.text();
if (!res.ok || !text.startsWith('OK')) throw new Error(`Drive upload failed: ${res.status} ${text.slice(0, 300)}`);
console.log(`Uploaded to Google Drive: ${text}`);
