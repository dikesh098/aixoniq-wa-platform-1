// Receives Meta webhooks: delivery statuses and inbound opt-out replies.
import { admin, json, loadSettings, timingSafeEqual } from '../_shared/common.ts';
import { verifySignature } from '../_shared/meta.ts';

const STOP_RE = /^\s*(stop|unsubscribe|opt[\s-]?out|cancel|end|quit|stop promotions?)\s*[.!]*\s*$/i;

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // Meta's one-time verification handshake.
  if (req.method === 'GET') {
    const expected = Deno.env.get('WEBHOOK_VERIFY_TOKEN');
    const given = url.searchParams.get('hub.verify_token') ?? '';
    if (expected && url.searchParams.get('hub.mode') === 'subscribe' && timingSafeEqual(given, expected)) {
      return new Response(url.searchParams.get('hub.challenge') ?? '', { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const appSecret = Deno.env.get('META_APP_SECRET');
  if (!appSecret) return new Response('Not configured', { status: 500 });
  const raw = await req.text();
  if (!(await verifySignature(raw, req.headers.get('x-hub-signature-256'), appSecret))) {
    return new Response('Invalid signature', { status: 401 });
  }

  let payload: any;
  try { payload = JSON.parse(raw); } catch { return new Response('Bad request', { status: 400 }); }

  const db = admin();
  const settings = await loadSettings(db);

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue;
      const v = change.value ?? {};
      const pid = v.metadata?.phone_number_id;
      if (settings.phone_number_id && pid && pid !== settings.phone_number_id) continue; // not our number

      for (const st of v.statuses ?? []) {
        if (!st.id || !['sent', 'delivered', 'read', 'failed'].includes(st.status)) continue;
        const err = st.errors?.[0];
        const ts = new Date(Number(st.timestamp) * 1000);
        const { data: inserted, error } = await db.from('webhook_events').upsert({
          event_key: `${st.id}:${st.status}`, wa_message_id: st.id, status: st.status,
          event_ts: isNaN(ts.getTime()) ? new Date().toISOString() : ts.toISOString(),
          error_code: err?.code !== undefined ? String(err.code) : null,
          error_message: err ? String(err.error_data?.details ?? err.message ?? err.title ?? '').slice(0, 500) : null,
        }, { onConflict: 'event_key', ignoreDuplicates: true }).select('id');
        if (error) { console.error('event insert failed', error.message); return new Response('Retry', { status: 500 }); }
        if (!inserted?.length) continue; // duplicate delivery from Meta
        const ev = inserted[0];
        const { data: ok } = await db.rpc('apply_message_status', {
          p_wa_id: st.id, p_status: st.status, p_ts: ts.toISOString(),
          p_code: err?.code !== undefined ? String(err.code) : null,
          p_msg: err ? String(err.message ?? err.title ?? '').slice(0, 500) : null,
        });
        if (ok === true) await db.from('webhook_events').update({ processed: true }).eq('id', ev.id);
        // If false, the message id was not stored yet; housekeeping re-applies it within minutes.
      }

      // Inbound opt-out replies ("STOP" etc.) become suppressions immediately.
      for (const m of v.messages ?? []) {
        const text: string = m.type === 'text' ? m.text?.body ?? '' : m.type === 'button' ? m.button?.text ?? '' : '';
        if (m.from && STOP_RE.test(text)) {
          const phone = `+${String(m.from).replace(/\D/g, '')}`;
          const { error } = await db.from('suppressions').upsert(
            { phone_e164: phone, reason: 'user_request', source: 'whatsapp_reply' },
            { onConflict: 'phone_e164', ignoreDuplicates: true });
          if (error) console.error('suppression failed', error.message);
        }
      }
    }
  }
  return json({ received: true });
});
