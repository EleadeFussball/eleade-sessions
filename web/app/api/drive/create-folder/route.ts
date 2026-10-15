// Jan only: a new player folder in "Players", with a "Game analysis" folder inside.
import { createFolder, driveFor, fail, HttpError, requireAdmin, supabaseFor } from '@/lib/google';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const db = supabaseFor(req);
    await requireAdmin(db);
    const { name } = await req.json();
    const clean = String(name ?? '').replace(/\s+/g, ' ').trim();
    if (!clean) throw new HttpError(400, 'Folder name missing.');
    const { token, playersFolder } = await driveFor(db);
    const folder = await createFolder(token, playersFolder, clean);
    await createFolder(token, folder.id, 'Game analysis');
    return Response.json({ folder });
  } catch (e) { return fail(e); }
}
