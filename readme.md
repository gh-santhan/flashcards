# Lifestyle Medicine Flashcards (Supabase)

A zero-backend JS app (HTML/CSS/JS modules) that reads/writes cards to Supabase and persists per-user grades. Built for rapid authoring + clean studying.

## Quick Start
1) Clone repo and open `index.html` in a modern browser (or host via GitHub Pages/Netlify).
2) Create a Supabase project:
   - Copy Project URL and anon key → put into `js/config.js`.
   - Create tables per `ARCHITECTURE.md` (or reuse your existing DB).
3) Auth:
   - Magic link uses `emailRedirectTo = location.origin + location.pathname`.
   - Add your production domain to Supabase Auth → URL config.

## What’s inside
- **index.html**: structure + modals (Study / Editor / Admin).
- **styles.css**: dark theme, chip filters, card UI, accordion for study controls.
- **js/config.js**: one place to configure env keys + feature toggles.
- **js/supabaseClient.js**: exports `supabase` client.
- **js/repo.js**: *only* talks to Supabase (no DOM).
- **js/main.js**: UI wiring, state, rendering, grading actions.

## Data model (minimum)
- `cards(id, front, back, chapter_id, meta jsonb, status, visibility, author_suspended, created_at)`
- `chapters(id, title)`
- `topics(id, title)`
- `tags(id, name)`
- `card_topics(card_id, topic_id)`
- `card_tags(card_id, tag_id)`
- `card_grades(user_id uuid, card_id uuid, grade text check in ('again','hard','good','easy'), updated_at)`

## Roles & RLS (summary)
- Public read: `cards` (published/public), taxonomy, joins.
- Authenticated write: user’s own `card_grades`.
- No writes to other users’ grades.

## Common tasks
- **Import cards**: Admin tab → upload `{ "cards": [...] }`.
- **Study**: choose Chapter/Topic, filter by grade, star, reveal, grade.
- **Edit**: open card → edit fields, topics, tags, resources.
- **Persist grades**: grading writes to `card_grades`; UI shows your last grade.

## Deploy
- GitHub Pages/Netlify/Vercel (static).
- Ensure your deployed origin is added to Supabase Auth redirect URLs and Storage CORS.
