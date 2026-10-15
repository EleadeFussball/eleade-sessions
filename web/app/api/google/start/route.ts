// Jan only: returns the Google sign-in address for connecting info@eleadefussball.com's Drive.
import { authUrl, fail, requireAdmin, supabaseFor } from '@/lib/google';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    await requireAdmin(supabaseFor(req));
    return Response.json({ url: authUrl(new URL(req.url).origin) });
  } catch (e) { return fail(e); }
}
