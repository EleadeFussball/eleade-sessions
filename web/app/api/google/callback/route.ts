// Google sends Jan back here after sign-in. The key is encrypted and handed to the Admin page,
// which saves it with Jan's own login (the database only accepts it from Jan).
import { checkState, exchangeCode, seal } from '@/lib/google';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const u = new URL(req.url);
  const back = (q: Record<string, string>) => Response.redirect(`${u.origin}/admin?${new URLSearchParams(q)}#drive`, 303);
  if (u.searchParams.get('error')) return back({ drive_error: u.searchParams.get('error') === 'access_denied' ? 'Google sign-in was cancelled.' : String(u.searchParams.get('error')) });
  if (!checkState(u.searchParams.get('state'))) return back({ drive_error: 'The sign-in link expired. Tap Connect Google Drive again.' });
  try {
    const { refresh, email } = await exchangeCode(u.searchParams.get('code') ?? '', u.origin);
    return back({ drive_key: seal(refresh), drive_email: email ?? '' });
  } catch (e) {
    return back({ drive_error: e instanceof Error ? e.message : 'Google sign-in failed.' });
  }
}
