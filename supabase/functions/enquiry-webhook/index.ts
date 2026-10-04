// Website enquiry webhook: the Wix expression-of-interest form posts each submission here
// and it appears in the app under Enquiries.
// Send a POST with JSON (or form fields) and the key from the Team page in the
// "x-eleade-key" header (or as ?key=...).
import { createClient } from 'npm:@supabase/supabase-js@2';
import { normalise } from './normalise.ts';

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function sha(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const url = new URL(req.url);
  const given = req.headers.get('x-eleade-key')
    ?? req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    ?? url.searchParams.get('key') ?? '';

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });
  const { data: keyRow } = await db.from('private_keys').select('value').eq('name', 'enquiry_webhook').maybeSingle();
  const expected = (keyRow?.value as string | undefined) ?? '';
  if (!expected || !given || !safeEqual(given, expected)) return json({ error: 'Not allowed' }, 401);

  let payload: unknown;
  const type = req.headers.get('content-type') ?? '';
  try {
    if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
      const form = await req.formData();
      payload = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
    } else {
      const text = await req.text();
      payload = JSON.parse(text);
    }
  } catch {
    return json({ error: 'Could not read the form data' }, 400);
  }

  const { fields, externalId, answers } = normalise(payload);
  if (!fields.first_name && !fields.email && !fields.parent_name) {
    return json({ error: 'No name or email found in the submission' }, 422);
  }
  // Without an id from the website, treat the same person submitting twice on one day as one enquiry.
  const today = new Date().toISOString().slice(0, 10);
  const id = externalId || `auto-${await sha([fields.email, fields.first_name, fields.last_name, today].join('|').toLowerCase())}`;

  const { data, error } = await db.rpc('record_enquiry', { p_external_id: id, p_fields: fields, p_raw: { answers, payload } });
  if (error) return json({ error: 'Could not save the enquiry' }, 500);
  return json({ ok: true, id: data ?? null, duplicate: data === null });
});
