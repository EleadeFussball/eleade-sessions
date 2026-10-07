// Nightly backup: reads every table from Supabase (service key), builds the Excel workbook and
// overwrites one file in Google Drive (Drive keeps the earlier versions). No other dependencies than exceljs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import ExcelJS from 'exceljs';
import { buildBackupWorkbook } from '../../web/lib/backup-workbook.mjs';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, GOOGLE_SERVICE_ACCOUNT_JSON, DRIVE_FILE_ID } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required');

async function fetchTable(table) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, Range: `${from}-${from + 999}`, 'Range-Unit': 'items' },
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

if (!GOOGLE_SERVICE_ACCOUNT_JSON || !DRIVE_FILE_ID) { console.log('No Drive settings, file kept locally only'); process.exit(0); }

const sa = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/drive', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3000 })}`;
const jwt = `${unsigned}.${crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url')}`;
const tok = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
}).then((r) => r.json());
if (!tok.access_token) throw new Error(`Google auth failed: ${JSON.stringify(tok)}`);

const up = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${DRIVE_FILE_ID}?uploadType=media&supportsAllDrives=true`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  body: buf,
});
if (!up.ok) throw new Error(`Drive upload failed: ${up.status} ${await up.text()}`);
console.log('Uploaded to Google Drive');
