// Admin tools: (a) report which server secrets are configured, (b) send one template message to one number.
import { admin, corsHeaders, errorResponse, HttpError, json, loadSettings, rateLimit, requireStaff } from '../_shared/common.ts';
import { metaToken, sendTemplate } from '../_shared/meta.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const { userId } = await requireStaff(req, ['admin']);
    const body = await req.json().catch(() => ({}));
    const db = admin();
    const settings = await loadSettings(db);

    if (body.action === 'status') {
      const has = (k: string) => Boolean(Deno.env.get(k));
      return json({
        test_mode: settings.test_mode,
        secrets: {
          META_ACCESS_TOKEN: has('META_ACCESS_TOKEN'), META_APP_SECRET: has('META_APP_SECRET'),
          WEBHOOK_VERIFY_TOKEN: has('WEBHOOK_VERIFY_TOKEN'), WORKER_SECRET: has('WORKER_SECRET'),
        },
        settings: { waba_id: Boolean(settings.waba_id), phone_number_id: Boolean(settings.phone_number_id) },
      });
    }

    if (body.action === 'send') {
      await rateLimit(db, `testsend:${userId}`, 10, 3600);
      const to = String(body.to ?? '');
      if (!/^\+[1-9][0-9]{7,14}$/.test(to)) throw new HttpError(400, 'Phone number must be in E.164 format, e.g. +919876543210');
      if (body.confirm_own_number !== true) throw new HttpError(400, 'Confirm the number belongs to you or a consenting tester.');
      const { data: tpl } = await db.from('templates').select('*').eq('id', body.template_id).maybeSingle();
      if (!tpl) throw new HttpError(404, 'Template not found');
      if (tpl.status !== 'approved') throw new HttpError(400, 'Template is not approved');
      const params: string[] = Array.isArray(body.params) ? body.params.map((p: unknown) => String(p).trim()) : [];
      if (params.length !== tpl.variable_count || params.some((p) => !p || p.length > 1000)) {
        throw new HttpError(400, `This template needs ${tpl.variable_count} non-empty variable(s).`);
      }
      if (settings.test_mode) return json({ simulated: true, message: 'Test mode is on: nothing was sent to Meta.' });

      const token = metaToken();
      if (!token || !settings.phone_number_id) throw new HttpError(400, 'Missing META_ACCESS_TOKEN or phone number ID.');
      if (tpl.source !== 'meta') throw new HttpError(400, 'Sample templates cannot be sent in live mode.');
      const r = await sendTemplate({ token, apiVersion: settings.api_version, phoneNumberId: settings.phone_number_id, wabaId: settings.waba_id ?? '' },
        to.slice(1), tpl.name, tpl.language, params);
      if (!r.ok) throw new HttpError(502, `Meta rejected the request (${r.code ?? 'error'}): ${r.message}`);
      return json({ simulated: false, wa_message_id: r.waMessageId });
    }
    throw new HttpError(400, 'Unknown action');
  } catch (e) {
    return errorResponse(e);
  }
});
