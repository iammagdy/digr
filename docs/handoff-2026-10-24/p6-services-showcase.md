# P6 — «خدماتنا» as a showcase (no per-service status)

- `/services` and the landing overview no longer show any per-service status, status counts or per-service call to action. One primary call to action («ابدأ طلبك») at the top and the bottom of `/services`.
- Every service has ONE plain-Arabic sentence (`explainAr`) in `src/lib/servicesCatalog.ts`, generated from `scripts/catalog/explanations.json` by `scripts/build-services-catalog.ts` (key `platform|nameAr`). The sentences are shown when a platform card is opened and for the decision-makers list; the search also matches them. A later chat answer can read the same field.
- The internal proven list (`src/lib/servicesAvailability.ts`) now only orders platforms (proven first); nothing about it is rendered. `docs/FUTURE_SERVICES.md` is internal and says so at its top.
- Refusal text for a plan item with no matching capability (`UNVERIFIED_PLATFORM_MESSAGE_AR`, `src/functions/shared/capabilityRegistry.ts`): text only; nothing is charged or held. The «تعذر مطابقة الخطة…» sentence quoted earlier is an internal `errorAr`, not what the customer sees.
- Priced cards on `/services` now come from the shared pricing function for every option that already has a price (they were filtered to the proven list before).
- Rollback: `git revert -m 1 <merge commit>` on a new branch.
