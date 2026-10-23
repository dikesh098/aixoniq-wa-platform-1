import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2';

export const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
};

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: e.message }, e.status);
  console.error('Unhandled error:', e);
  return json({ error: 'Internal error' }, 500);
}

/** Service-role client. Only ever created inside Edge Functions. */
export function admin(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });
}

/** Verifies the caller's JWT and that they are an allowed staff member. */
export async function requireStaff(req: Request, roles: string[]): Promise<{ userId: string; role: string }> {
  const auth = req.headers.get('Authorization');
  if (!auth) throw new HttpError(401, 'Missing authorization');
  const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data.user) throw new HttpError(401, 'Invalid session');
  const { data: staff } = await admin().from('staff').select('role').eq('user_id', data.user.id).maybeSingle();
  if (!staff || !roles.includes(staff.role)) throw new HttpError(403, 'You do not have permission to do this');
  return { userId: data.user.id, role: staff.role };
}

export async function rateLimit(db: SupabaseClient, key: string, limit: number, windowSeconds: number) {
  const { data, error } = await db.rpc('rl_hit', { p_key: key, p_limit: limit, p_window_seconds: windowSeconds });
  if (error) throw new HttpError(500, 'Rate limiter unavailable');
  if (data !== true) throw new HttpError(429, 'Too many requests. Please wait and try again.');
}

export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export interface Settings {
  business_name: string; waba_id: string | null; phone_number_id: string | null; api_version: string;
  test_mode: boolean; daily_cap: number; max_per_minute: number;
}

export async function loadSettings(db: SupabaseClient): Promise<Settings> {
  const { data, error } = await db.from('business_settings').select('*').eq('id', 1).single();
  if (error || !data) throw new HttpError(500, 'Business settings missing. Run the migrations.');
  return data as Settings;
}
