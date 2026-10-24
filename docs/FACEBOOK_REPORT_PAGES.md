# Page registry of the Facebook topic report

The report browses a registry of vetted **public** Facebook Pages (`src/lib/facebookReport/registry.ts`, a data module: no database, no SQL). The list is **the owner's to review and extend**: every entry ships with `ownerReviewed: false`, and the tests assert that.

Rules the module holds (and the tests check):

- A Page is used only when its country equals the request's country and its topic tags cover the request's topic area. A non-Egyptian Page is never used for Egypt; a request with no country gets no Page.
- Only public Pages are listed, **never a personal profile or a group** (`registryProblems` rejects `profile.php`, `/people/`, `/groups/`). The two doctors in the owner's audit were personal profiles that returned nothing; they are not listed and must not be added.
- `status`: `ok` (browsed), `invalid` (not a valid Page address for the source; needs the correct URL) or `not_public`. Entries that are not `ok` are skipped, counted and reported, never browsed.
- The Page's Arabic display name is the **publisher** in the customer's files; the internal id and provider names never appear there. A search result whose page name is one of the Page's listed spellings counts as the same publisher (so the 20% cap counts it once).
- With fewer than 5 usable Pages an exact 20% per-publisher share is impossible; the report states the share it could hold.

## Seeded list (Egypt, health), from `facebook_pages_and_queries_audit.csv`

| Id | Page | Status | Owner reviewed |
|---|---|---|---|
| `eg_health_el_consolto` | الكونسلتو الطبي | ok | no |
| `eg_health_drug_authority` | هيئة الدواء المصرية | ok | no |
| `eg_health_medical_syndicate` | النقابة العامة لأطباء مصر | ok | no |
| `eg_health_cairo24` | القاهرة ٢٤ | ok | no |
| `eg_health_masrawy` | مصراوي | ok | no |
| `eg_health_mohp` | وزارة الصحة والسكان المصرية | **invalid** (the audit: the address answered «not found»; needs the correct Page URL) | no |

## What the owner needs to do

1. Open each Page and confirm it is a public Page for Egypt with health content; set `ownerReviewed: true` for the ones confirmed.
2. Supply the correct URL for the Ministry of Health Page, then set its `status` to `ok`.
3. To cover another country or topic, add entries (country code, topic tags, Arabic name, spellings) and, for a new topic area, a `TOPIC_AREAS` entry and a set of axes. Until then the platform answers that the full report is available for health topics in Egypt only.
4. Add at least five Pages per country and topic area if the exact 20% share is wanted.
