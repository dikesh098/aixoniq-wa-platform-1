import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import type { Settings } from '../types';

export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const reload = useCallback(async () => {
    const { data } = await supabase.from('business_settings').select('*').eq('id', 1).maybeSingle();
    setSettings((data as Settings) ?? null);
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { settings, reload };
}
