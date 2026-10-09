// Nightly backup: reads every table from Supabase (service key), builds the Excel workbook and
// sends it to a Google Apps Script web app that overwrites one file in Google Drive (Drive keeps the earlier versions). No other dependencies than exceljs.
import fs from 'node:fs';
import ExcelJS from 'exceljs';
import { buildBackupWorkbook } from '../../web/lib/backup-workbook.mjs';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, APPS_SCRIPT_URL, BACKUP_SECRET } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required');

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
