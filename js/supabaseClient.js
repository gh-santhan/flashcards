// js/supabaseClient.js
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
