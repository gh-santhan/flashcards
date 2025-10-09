# FILEMAP — where things live

## App surface
- `index.html`            — Page layout (header, tabs, modals), script tags (ES modules).
- `styles.css`            — All styles (dark theme, tables, cards, modals, accordion).

## JavaScript (modules)
- `js/config.js`          — 🔧 Supabase URL/anon key, storage bucket name, feature flags.
- `js/supabaseClient.js`  — Creates and exports the Supabase client.
- `js/repo.js`            — 📦 Data layer ONLY: all DB/storage I/O (auth helpers, fetch cards/
                            chapters/topics/tags, counts, CRUD, grade upsert/fetch).
- `js/main.js`            — 🧠 UI + state: render card, filters, search, editor/modals, grading.

## Docs (project memory)
- `README.md`             — What/How/Setup/Deploy.
- `ARCHITECTURE.md`       — Layers, responsibilities, data flow, state.
- `DECISIONS.md`          — Tiny decision log (why we chose X).
- `CHANGELOG.md`          — What changed, when.

## Database (Supabase)
Tables (minimum viable):
- `cards`, `chapters`, `topics`, `tags`
- `card_topics` (M–M), `card_tags` (M–M)
- `card_grades` (user_id, card_id, grade, updated_at)

Policies: RLS ON; user can read public + their own graded state; write only their grades.
