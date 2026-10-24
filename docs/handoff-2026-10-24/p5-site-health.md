# Handoff note (2026-10-24): p5-site-health

Kept in its own file so the parallel PRs of this session do not conflict in docs/HANDOFF.md; fold it into HANDOFF.md after merging.

## 00000000. Site health script (branch `claude/site-health`, from main `2548785`)

- `scripts/site-health.ts` (read-only: GET only, no cookie, no key, no write): `npx tsx scripts/site-health.ts [base-url]` (default https://diger.tech). Checks `/`, `/services`, `/pricing`, `/calculator`, `/contact`, `/login`, `/register` for HTTP 200, no provider / endpoint / model-vendor word in the HTML, none of the English UI strings of its banned list in the visible text and attributes, `lang="ar"`; and that `/admin/*` and `/api/admin/*` answer a request without a session with a redirect to sign-in, 401, 403 or 404. It proves nothing about logged-in pages, sign-in, payments or the quality of any page. Run it against production only after the merge it checks is confirmed. Tests: `tests/site-health-script.test.ts` (fixtures, no network).

---

