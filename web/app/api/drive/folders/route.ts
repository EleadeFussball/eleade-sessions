// Jan only: the player folders inside "Players" in Google Drive, to link them to players.
import { driveFor, fail, listFolders, requireAdmin, supabaseFor } from '@/lib/google';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const db = supabaseFor(req);
    await requireAdmin(db);
    const { token, playersFolder } = await driveFor(db);
    return Response.json({ folders: await listFolders(token, playersFolder) });
  } catch (e) { return fail(e); }
}
