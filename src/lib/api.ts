import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from './supabase';

/** Calls an Edge Function with the signed-in user's JWT and surfaces the server's error message. */
export async function invokeFn<T = any>(name: string, body?: unknown): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body: body as Record<string, unknown> });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const j = await error.context.json().catch(() => null);
      throw new Error(j?.error ?? error.message);
    }
    throw new Error(error.message);
  }
  return data as T;
}

export const fmt = (d: string | null | undefined) => (d ? new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const num = (n: number | undefined | null) => (n ?? 0).toLocaleString('en-IN');
export const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '—');
