// Pulls message templates from Meta so only real, approved templates can be used.
import { admin, corsHeaders, errorResponse, HttpError, json, loadSettings, rateLimit, requireStaff } from '../_shared/common.ts';
import { listTemplates, metaToken } from '../_shared/meta.ts';

function analyse(components: any[], category: string) {
  const body = components.find((c) => c.type === 'BODY');
  const text: string = body?.text ?? '';
  const named = /\{\{[a-zA-Z_]+\}\}/.test(text);
  const nums = [...text.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  const variableCount = nums.length ? Math.max(...nums) : 0;
  let supported = !named && category !== 'AUTHENTICATION';
  for (const c of components) {
    if (c.type === 'HEADER' && (c.format !== 'TEXT' || /\{\{/.test(c.text ?? ''))) supported = false;
    if (c.type === 'BUTTONS' && (c.buttons ?? []).some((b: any) => /\{\{/.test(b.url ?? '') || b.type === 'COPY_CODE' || b.type === 'FLOW')) supported = false;
    if (!['BODY', 'HEADER', 'FOOTER', 'BUTTONS'].includes(c.type)) supported = false;
  }
  return { variableCount, supported };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const { userId } = await requireStaff(req, ['admin', 'editor']);
    const db = admin();
    await rateLimit(db, `sync:${userId}`, 5, 300);
    const settings = await loadSettings(db);
    const token = metaToken();
    if (!token) throw new HttpError(400, 'META_ACCESS_TOKEN secret is not set.');
    if (!settings.waba_id) throw new HttpError(400, 'Set the WhatsApp Business Account ID in Settings first.');

    let templates;
    try {
      templates = await listTemplates({ token, apiVersion: settings.api_version, phoneNumberId: settings.phone_number_id ?? '', wabaId: settings.waba_id });
    } catch (e) {
      throw new HttpError(502, `Meta API error: ${(e as Error).message}`);
    }
    const rows = templates
      .filter((t) => /^[a-z0-9_]+$/.test(t.name) && /^[a-z]{2,3}(_[A-Za-z]{2,4})?$/.test(t.language))
      .map((t) => {
        const a = analyse(t.components ?? [], t.category);
        return {
          meta_template_id: t.id, name: t.name, language: t.language, category: t.category,
          status: String(t.status).toLowerCase(), components: t.components ?? [],
          variable_count: a.variableCount, supported: a.supported, source: 'meta', synced_at: new Date().toISOString(),
        };
      });
    if (rows.length) {
      const { error } = await db.from('templates').upsert(rows, { onConflict: 'name,language' });
      if (error) throw new HttpError(500, 'Could not save templates');
    }
    return json({ synced: rows.length });
  } catch (e) {
    return errorResponse(e);
  }
});
