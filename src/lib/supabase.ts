import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isConfigured = Boolean(url && key);
// Only the public anon key is used here. All data access is gated by Row Level Security.
export const supabase = createClient(url ?? 'http://localhost:54321', key ?? 'missing-key');
