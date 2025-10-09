# Decisions (why we chose X)

## 2025-10-09 — Split UI vs Logic vs Data
- **Why**: Faster UI iteration without breaking persistence or queries.
- **Decision**: `index.html` + `styles.css` (UI), `main.js` (controller), `repo.js` (data).
- **Tradeoff**: Slightly more files, but changes are safer and diffs are clearer.

## 2025-10-09 — Persist grades in DB + local fallback removed
- **Why**: Users reported refresh clearing grades. DB is source of truth per user.
- **Decision**: `card_grades` table with upsert by (user_id, card_id).
- **Tradeoff**: Adds one extra fetch on load; acceptable.

## 2025-10-09 — Filters inside accordion
- **Why**: Cleaner study surface; controls still available on demand.
- **Decision**: `<details>` “Filters” wrapping Chapter/Topic/Mix/Search/Chips.
- **Tradeoff**: One extra click to reach filters; improves focus.

## 2025-10-09 — Tolerant importer
- **Why**: LLM JSON sometimes includes comments/curly quotes/trailing commas.
- **Decision**: Pre-clean text before `JSON.parse`.
- **Tradeoff**: Slight code complexity; smoother authoring workflow.
