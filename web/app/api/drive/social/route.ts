// Any coach: copies an uploaded training video into the shared "Social Media Footage" folder,
// which sits next to "Players" in the Eleade Australia folder.
import { copyFile, driveFor, fail, findFile, findOrCreateFolder, HttpError, parentOf, supabaseFor } from '@/lib/google';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const db = supabaseFor(req);
    const { clip_id } = await req.json();
    const { data: clip, error } = await db.from('drive_clips').select('id, player_id, file_id, file_name, social_file_id').eq('id', clip_id).maybeSingle();
    if (error) throw new HttpError(403, error.message);
    if (!clip) throw new HttpError(404, 'Clip not found.');
    if (clip.social_file_id) return Response.json({ id: clip.social_file_id });
    const { token, playersFolder } = await driveFor(db);

    let fileId: string | null = clip.file_id;
    if (!fileId) {
      const { data: p } = await db.from('players').select('drive_folder_id').eq('id', clip.player_id).maybeSingle();
      if (!p?.drive_folder_id) throw new HttpError(409, 'The player has no Drive folder linked.');
      const clips = await findOrCreateFolder(token, p.drive_folder_id, 'Session clips');
      fileId = await findFile(token, clips.id, clip.file_name);
      if (!fileId) throw new HttpError(404, 'The video was not found in the player\'s folder yet. Try again in a minute.');
    }

    const { data: saved } = await db.rpc('social_folder');
    let social = (saved as string | null) ?? null;
    if (!social) {
      const top = await parentOf(token, playersFolder);
      if (!top) throw new HttpError(409, 'Could not find the Eleade Australia folder above Players.');
      social = (await findOrCreateFolder(token, top, 'Social Media Footage')).id;
      await db.rpc('set_social_folder', { p_folder_id: social });
    }
    const copy = await copyFile(token, fileId, social, clip.file_name);
    await db.rpc('mark_clip_social', { p_clip_id: clip.id, p_file_id: copy });
    return Response.json({ id: copy });
  } catch (e) { return fail(e); }
}
