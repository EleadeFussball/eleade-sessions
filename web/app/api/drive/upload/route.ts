// Any coach: prepares an upload of a session clip into the player's "Session clips" folder.
// The phone then sends the video straight to Google Drive.
import { driveFor, fail, findOrCreateFolder, HttpError, startUpload, supabaseFor } from '@/lib/google';

export const dynamic = 'force-dynamic';
const MAX = 2 * 1024 * 1024 * 1024; // 2 GB

export async function POST(req: Request) {
  try {
    const db = supabaseFor(req);
    const { player_id, file_name, mime, size } = await req.json();
    if (!player_id || !file_name) throw new HttpError(400, 'Player or file missing.');
    if (!(Number(size) > 0) || Number(size) > MAX) throw new HttpError(400, 'That file is too large. Keep clips to about a minute.');
    const { data: p, error } = await db.from('players').select('id, name, drive_folder_id').eq('id', player_id).maybeSingle();
    if (error) throw new HttpError(403, error.message);
    if (!p) throw new HttpError(404, 'Player not found.');
    if (!p.drive_folder_id) throw new HttpError(409, `${p.name} has no Drive folder linked yet. Jan links it on the Admin page.`);
    const { token } = await driveFor(db);
    const clips = await findOrCreateFolder(token, p.drive_folder_id, 'Session clips');
    const origin = req.headers.get('origin') ?? new URL(req.url).origin;
    const url = await startUpload(token, clips.id, String(file_name).slice(0, 200), String(mime || 'video/mp4'), Number(size), origin);
    return Response.json({ url });
  } catch (e) { return fail(e); }
}
