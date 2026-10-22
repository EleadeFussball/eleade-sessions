// Server only: Google sign-in and Drive calls for eleade Hub.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { createClient } from '@supabase/supabase-js';

export const DRIVE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive'];
const FOLDER = 'application/vnd.google-apps.folder';
const API = 'https://www.googleapis.com/drive/v3';

function secret(): string {
  const s = process.env.GOOGLE_CLIENT_SECRET;
  if (!s || !process.env.GOOGLE_CLIENT_ID) throw new Error('Google is not set up yet: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are missing in Vercel.');
  return s;
}
const key = () => createHash('sha256').update('eleade-drive:' + secret()).digest();
const b64 = (b: Buffer) => b.toString('base64url');

/** The Google key is stored encrypted in the database; only this server can unlock it. */
export function seal(text: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [b64(iv), b64(c.getAuthTag()), b64(body)].join('.');
}
export function unseal(sealed: string): string {
  const [iv, tag, body] = sealed.split('.').map((x) => Buffer.from(x, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString('utf8');
}

/** Signed, short-lived state for the Google sign-in round trip. */
export function signState(): string {
  const payload = b64(Buffer.from(JSON.stringify({ exp: Date.now() + 10 * 60_000, n: b64(randomBytes(8)) })));
  return payload + '.' + b64(createHmac('sha256', key()).update(payload).digest());
}
export function checkState(state: string | null): boolean {
  if (!state) return false;
  const [payload, sig] = state.split('.');
  if (!payload || !sig) return false;
  const want = createHmac('sha256', key()).update(payload).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return false;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now(); } catch { return false; }
}

export const redirectUri = (origin: string) => `${origin}/api/google/callback`;

export function authUrl(origin: string): string {
  const q = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? '', redirect_uri: redirectUri(origin), response_type: 'code',
    scope: DRIVE_SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',
    login_hint: 'info@eleadefussball.com', state: signState(),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

export async function exchangeCode(code: string, origin: string): Promise<{ refresh: string; email: string | null }> {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: process.env.GOOGLE_CLIENT_ID ?? '', client_secret: secret(),
      redirect_uri: redirectUri(origin), grant_type: 'authorization_code' }),
  });
  const j = await r.json();
  if (!r.ok || !j.refresh_token) throw new Error(j.error_description || j.error || 'Google did not return a key. Try Connect again.');
  let email: string | null = null;
  if (j.id_token) { try { email = JSON.parse(Buffer.from(j.id_token.split('.')[1], 'base64url').toString()).email ?? null; } catch { /* ignore */ } }
  return { refresh: j.refresh_token, email };
}

export async function accessToken(refresh: string): Promise<string> {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: refresh, client_id: process.env.GOOGLE_CLIENT_ID ?? '', client_secret: secret(), grant_type: 'refresh_token' }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error === 'invalid_grant' ? 'The Google Drive connection has expired. Jan needs to tap Connect Google Drive on the Admin page again.' : (j.error_description || 'Google sign-in failed'));
  return j.access_token;
}

/** Supabase client acting as the signed-in coach (their own login token), so the database rules apply. */
export function supabaseFor(req: Request) {
  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!jwt) throw new HttpError(401, 'Sign in first.');
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false, autoRefreshToken: false },
  });
}

export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

export async function requireAdmin(db: ReturnType<typeof supabaseFor>) {
  const { data } = await db.rpc('is_admin');
  if (data !== true) throw new HttpError(403, 'Only Jan can do this.');
}

/** Drive access for the signed-in coach: the encrypted key from the database, unlocked here. */
export async function driveFor(db: ReturnType<typeof supabaseFor>) {
  const { data, error } = await db.rpc('drive_secret');
  if (error) throw new HttpError(403, error.message);
  const row = (data as { refresh_token_enc: string; players_folder_id: string }[] | null)?.[0];
  if (!row) throw new HttpError(409, 'Google Drive is not connected yet. Jan connects it on the Admin page.');
  return { token: await accessToken(unseal(row.refresh_token_enc)), playersFolder: row.players_folder_id };
}

async function g<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(502, j?.error?.message || `Google Drive error ${r.status}`);
  return j as T;
}

export type DriveFolder = { id: string; name: string };
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export async function listFolders(token: string, parent: string): Promise<DriveFolder[]> {
  const out: DriveFolder[] = [];
  let pageToken = '';
  do {
    const q = new URLSearchParams({
      q: `'${esc(parent)}' in parents and mimeType = '${FOLDER}' and trashed = false`,
      fields: 'nextPageToken, files(id, name)', pageSize: '1000', orderBy: 'name',
      supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', ...(pageToken ? { pageToken } : {}),
    });
    const j = await g<{ files: DriveFolder[]; nextPageToken?: string }>(token, `${API}/files?${q}`);
    out.push(...j.files); pageToken = j.nextPageToken ?? '';
  } while (pageToken);
  return out;
}

export async function createFolder(token: string, parent: string, name: string): Promise<DriveFolder> {
  return g<DriveFolder>(token, `${API}/files?supportsAllDrives=true&fields=id,name`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
  });
}

export async function findOrCreateFolder(token: string, parent: string, name: string): Promise<DriveFolder> {
  const q = new URLSearchParams({
    q: `'${esc(parent)}' in parents and mimeType = '${FOLDER}' and name = '${esc(name)}' and trashed = false`,
    fields: 'files(id, name)', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
  });
  const j = await g<{ files: DriveFolder[] }>(token, `${API}/files?${q}`);
  return j.files[0] ?? createFolder(token, parent, name);
}

/**
 * Starts an upload straight from the coach's phone to Drive. The returned address is used once for this file;
 * the video never passes through our server (which could not take large files).
 */
export async function startUpload(token: string, parent: string, name: string, mime: string, size: number, origin: string): Promise<string> {
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(size), Origin: origin },
    body: JSON.stringify({ name, parents: [parent] }),
  });
  const loc = r.headers.get('location');
  if (!r.ok || !loc) { const j = await r.json().catch(() => ({})); throw new HttpError(502, j?.error?.message || 'Google Drive did not accept the upload.'); }
  return loc;
}

export async function parentOf(token: string, id: string): Promise<string | null> {
  const j = await g<{ parents?: string[] }>(token, `${API}/files/${encodeURIComponent(id)}?fields=parents&supportsAllDrives=true`);
  return j.parents?.[0] ?? null;
}

export async function findFile(token: string, parent: string, name: string): Promise<string | null> {
  const q = new URLSearchParams({
    q: `'${esc(parent)}' in parents and name = '${esc(name)}' and trashed = false`,
    fields: 'files(id)', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', orderBy: 'createdTime desc',
  });
  const j = await g<{ files: { id: string }[] }>(token, `${API}/files?${q}`);
  return j.files[0]?.id ?? null;
}

export async function copyFile(token: string, id: string, parent: string, name: string): Promise<string> {
  const j = await g<{ id: string }>(token, `${API}/files/${encodeURIComponent(id)}/copy?supportsAllDrives=true&fields=id`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, parents: [parent] }),
  });
  return j.id;
}

export function fail(e: unknown) {
  const status = e instanceof HttpError ? e.status : 500;
  return Response.json({ error: e instanceof Error ? e.message : 'Something went wrong.' }, { status });
}
