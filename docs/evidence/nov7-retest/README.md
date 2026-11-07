# Nov 7 Facebook retest: evidence

Mission: `msn_365928deea447ca8ae92` (test account; created 2026-11-06 22:16 UTC = 7 Nov 00:16 Cairo; 6 rows delivered, 215 points charged).
Production facts come from read-only SELECTs on `missions`, `mission_calls`, `mission_events` and `storage.objects` (names only). No Storage object was read. No write, no paid call.

## Production facts

| Fact | Where |
| :--- | :--- |
| The first keyword search answered empty (0 rows) | `mission_calls` call_0001, `justoneapi.x.facebook-search-post-v1`, status `empty` |
| The second search gave 20 posts | call_0002, `anyapi.facebook.search_posts`, status `ok` |
| Both chosen posts carry their page's name («العالم الجديد - يوسف بهنس», «AraGeek - أراجيك») | `missions.plan -> stages[0].pinned_rows[*].author` |
| The card still said «طلبت أسماء أصحاب الحسابات، لكن المصدر المختار لا يعيدها…» | `missions.plan_public.notes_ar`; `plan.compiled.fields = [{author: unavailable}]` |
| The first chosen post's whole link is 155 characters, ending `…Kl&id=61570030318692` | `missions.plan -> stages[0].pinned_rows[0].link` |
| The card showed it cut at 120 characters (`…VPfT`, with no `id`) | `missions.plan_public -> stages[0].sample_rows[0].link` |

## Browser evidence (SIMULATED, NOT production)

`nov7-fb-card-results.json` with `nov7-fb-card-*.png`: 18/18 checks pass at 1280, 390 and 320.
- The setup uses the real compiler (`planByCompiler`, test-account mode) over the retest's stored rows: the first search empty, the second search with the posts.
- The real customer view and the real `AgentMissionCardBody` render it, with the production-built CSS, in real Chromium.
- Covered:
  - the permalink is shown whole, with its `id`;
  - no cut permalink appears;
  - the page names are shown;
  - there is no false account-names line;
  - the page has no sideways scroll;
  - RTL layout.
- Script: `scripts/browser-journey/nov7-facebook-card.chromium.ts`.
