# Changelog

## 2025-10-09
- feat: split code into `styles.css`, `js/config.js`, `js/supabaseClient.js`, `js/repo.js`, `js/main.js`.
- feat: accordion for study controls (filters).
- feat: per-user grade persistence via `card_grades` upsert; UI shows counts/filters correctly.
- fix: magic-link redirect now uses `location.origin + location.pathname`.
- docs: add FILEMAP, README, ARCHITECTURE, DECISIONS, CHANGELOG.
