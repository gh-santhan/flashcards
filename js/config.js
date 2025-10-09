// js/config.js
export const SUPABASE_URL = "https://vzcgdpedoyiqzgguitum.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ6Y2dkcGVkb3lpcXpnZ3VpdHVtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTkxNDA1MjksImV4cCI6MjA3NDcxNjUyOX0.hHMkwcrROCQHGlYPdfbVYmPffVHUiE838GktgXaRAzI";
export const STORAGE_BUCKET = "media";

// NOTE: Ensure this table exists (run once):
// create table if not exists public.card_grades (
//   user_id uuid not null references auth.users(id) on delete cascade,
//   card_id uuid not null references public.cards(id) on delete cascade,
//   grade text not null check (grade in ('again','hard','good','easy')),
//   updated_at timestamptz not null default now(),
//   primary key (user_id, card_id)
// );
// alter table public.card_grades enable row level security;
// create policy "read own grades" on public.card_grades for select using (auth.uid() = user_id);
// create policy "upsert own grades" on public.card_grades for insert with check (auth.uid() = user_id);
// create policy "update own grades" on public.card_grades for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
