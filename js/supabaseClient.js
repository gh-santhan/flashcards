import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// uses the UMD global injected by index.html
export const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
