# Instructions for AI Collaborator (please follow exactly)

Goal: Modify UI without breaking persistence. All data I/O must stay in `js/repo.js`. All DOM changes happen in `index.html`/`styles.css`/`js/main.js`.

Boundaries:
- DO NOT call `supabase.*` in `main.js` or `index.html`.
- DO NOT manipulate the DOM in `repo.js`.
- Any new DB query → add a new function in `repo.js` and export it.
- Any new UI element → wire it in `main.js`, using existing state patterns.

When making changes:
1) Update `FILEMAP.md` if new files are added.
2) Append a bullet to `DECISIONS.md` if behavior/architecture changes.
3) Add a short entry to `CHANGELOG.md`.

Acceptance checklist for any PR:
- [ ] Can log in with magic link (redirect correct).
- [ ] Study filters load, counts correct, star/suspend work.
- [ ] Grading persists: grade a card → refresh → grade chip counts reflect.
- [ ] Importer accepts JSON and populates joins (topics/tags).
- [ ] No console errors on load or study actions.
