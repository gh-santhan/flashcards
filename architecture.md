# Architecture

## Layers
1) UI (DOM only)
   - `index.html`, `styles.css`
   - Components: header/tabs, Study card, Editor tables, Admin tools, Search & Edit modals, Filters accordion.

2) App/Controller (state + wiring)
   - `js/main.js`
   - Responsibilities:
     - Holds app state (`cards`, `chapters`, `topics`, `tags`, `scope`, `order`, `idx`, `currentCard`, `user`).
     - Renders card + meta + resources.
     - Handles filters (chapter/topic/mix/diff/starred), search, grading, editor actions.
     - Calls repo.js for all data I/O.

3) Data (Supabase only)
   - `js/repo.js`
   - Responsibilities:
     - Auth helpers (getSession/onAuthStateChange).
     - Fetch taxonomy (chapters/topics/tags + counts).
     - Fetch cards (with joins for topics/tags).
     - Insert/update/delete cards; join tables.
     - Upsert/fetch grades (`card_grades`).
     - Storage uploads + public URLs.

## Data Flow
`main.js` → (calls) → `repo.js` → Supabase  
`repo.js` → (returns) → `main.js` → (updates) → DOM

**Rule:** No `supabase.*` calls outside `repo.js`. No DOM inside `repo.js`.

## State Keys (main.js)
- `session`, `user`
- `chapters[]`, `topics[]`, `tags[]`, `cards[]`
- `scope` `{ chapter, topic, mix, diff, starred }`
- `order[]`, `idx`, `currentCard`
- Derived counts for chips

## Grades
- On reveal, 4 grading buttons write `{ user_id, card_id, grade, updated_at }` via `repo.upsertGrade`.
- On load, repo returns card list + last grade for current user (joined) → UI shows chip counts, filters work.

## Error Handling & Resilience
- CRUD: toast/alert on failure, do not mutate UI state until DB write confirms.
- Import: tolerant JSON parser (strip BOM, curly quotes, comments, trailing commas).
- Storage: upload, then attach public URL to card meta; allow removal.
