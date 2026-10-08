// Stripe webhook: records paid Checkout Sessions (Payment Links) in stripe_payments.
// Setup: in Stripe, add an endpoint for this function's URL with the event
// "checkout.session.completed" (and "checkout.session.async_payment_succeeded"),
// then save its signing secret as the Supabase secret STRIPE_WEBHOOK_SECRET.
import { createClient } from 'npm:@supabase/supabase-js@2';

const enc = new TextEncoder();
const TOLERANCE_SECONDS = 300;

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function verifyStripeSignature(payload: string, header: string, secret: string, now = Date.now() / 1000): Promise<boolean> {
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || sigs.length === 0) return false;
  if (Math.abs(now - Number(t)) > TOLERANCE_SECONDS) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${payload}`)));
  return sigs.some((s) => safeEqual(s, expected));
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Eleade Stripe webhook', { status: 200 });
  const secret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  if (!secret) return new Response('Webhook secret not set', { status: 500 });

  const payload = await req.text();
  const ok = await verifyStripeSignature(payload, req.headers.get('stripe-signature') ?? '', secret);
  if (!ok) return new Response('Invalid signature', { status: 400 });

  const event = JSON.parse(payload);
  if (event.type !== 'checkout.session.completed' && event.type !== 'checkout.session.async_payment_succeeded') {
    return new Response('Ignored', { status: 200 });
  }
  const s = event.data?.object ?? {};
  if (s.payment_status !== 'paid') return new Response('Not paid yet', { status: 200 });

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });
  // "Player Name" field on the payment link (Stripe custom field)
  const fields: { key?: string; label?: { custom?: string }; text?: { value?: string } }[] = s.custom_fields ?? [];
  const playerField = fields.find((f) => /player/i.test(`${f.key ?? ''} ${f.label?.custom ?? ''}`));
  const { error } = await db.rpc('record_stripe_payment_named', {
    p_stripe_session_id: s.id,
    p_reference: s.client_reference_id ?? null,
    p_amount_total: (s.amount_total ?? 0) / 100,
    p_currency: s.currency ?? 'aud',
    p_email: s.customer_details?.email ?? null,
    p_name: s.customer_details?.name ?? null,
    p_paid_at: new Date((s.created ?? event.created ?? Date.now() / 1000) * 1000).toISOString(),
    p_player_name: playerField?.text?.value ?? null,
  });
  if (error) {
    console.error('record_stripe_payment failed', error.message);
    return new Response('Could not record payment', { status: 500 }); // Stripe retries
  }
  return new Response('ok', { status: 200 });
});
