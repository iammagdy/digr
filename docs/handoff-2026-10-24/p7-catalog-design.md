# P7 — «خدماتنا» catalog redesign (cards + one page per platform)

- `/services`: header with the counts and the two constant lines, the decision-makers block (six chosen services as cards, the rest behind «عرض باقي»), then every sector as a grid of platform cards (tile letter, name, one-line description, number of services). Sticky sector chips with platform counts; Arabic search over names, descriptions, service names and the one-sentence explanations. One «ابدأ طلبك» at the top and one at the bottom.
- `/services/[platform]` (new, static, 105 pages from `generateStaticParams`): the platform's name and description, the first six services as cards (name + one sentence), the rest as a plain list grouped by kind, links to the other platforms of the sector, «ابدأ طلبك» at the top and bottom. In the sitemap. `/services/` was already a public prefix.
- No price, status, provider or endpoint anywhere on these pages. The priced cards section of `/services` was removed (prices live on `/pricing` and `/calculator`).
- Hand-written helpers: `src/lib/servicesCatalogView.ts` (the generated `servicesCatalog.ts` is untouched), `src/components/services/PlatformTile.tsx` (a letter on a sector-coloured tile; no logo files).
- Rollback: `git revert -m 1 <merge commit>` on a new branch.
