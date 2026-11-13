# Round 60: one paid fetch per page, no paid page for an unsaved company (13 Nov 2026)

Production before this round: `9974769`. **No paid call was made.** Every number below comes from recorded rows (read-only SQL) and offline tests.

## Root cause of the repeated purchases

* `parse_page` offered `emails`, `phone-numbers` and `links` as separate Context.dev parsers. Each one is a full `/web/scrape` of the page at one credit, and the tool told the model to use "one parser per call".
* The reply the model reads (`first_rows`) **masks** e-mails and phones (`h***@…`, `***05`). This is a privacy digest of our own (`maskText`).
  * On 13 Nov the model read the masked values as missing and bought the same contact pages a fourth time with `web_scrape`. Its `why`: "the parsers returned only masked values".
  * The full values were already in the saved answer.
* Result on msn_088c: 37 paid reads of 13 pages, of which 24 were repeats.

## What changed (execution only, `agent/src/webGateway.ts`, `agent/src/pageReuse.ts`, `src/lib/agentMission/pageExtract.ts`)

### One paid fetch per page

* A field parser (`emails`, `phone-numbers`, `links`) buys the page once. It uses a Context.dev markdown read at the same single credit, and code reads the field from the text.
* Every later field or `web_scrape` of the same page in the mission is read from the saved page at **$0**.
  * It is recorded as `page.reuse`, with `reused_from` set to the call that bought it.
  * Its rows are saved like any call's, so `run_code` reads them.
* **Canonical page:** host lower-case without `www.`, no fragment, no tracking parameters, no trailing slash. `http`/`https` are the same page.
* **Cache:**
  * Mission-scoped, in the mission's private folder at `pages/<sha256>.json`. It holds the canonical URL, the mission, the call that bought the page, the time, the text and links, and the methods it answers.
  * After a worker restart the page is read from that file. If the file was lost, it is read from the raw answer of the call that bought it.
  * No new table and no migration.
* **Concurrency:** requests for one page run one at a time, so two simultaneous requests buy it once. Across workers, the existing mission lease already allows one worker per mission.
* **Failures:**
  * A passing failure (timeout, network, 5xx) is tried at most twice per page in a mission.
  * A definitive one (not found, blocked, bad input) is tried once. After that the page is refused with `page_failed_before`, at no cost.
  * A call that got **no answer** is counted in the mission budget at its estimate and marked `charge_unknown`. It is not assumed free.
* **Thin page:** a page with fewer than 200 characters of text (drawn by scripts) was not really read. The provider's own parser is then asked once for that field, as before, and never a third time.
* **The masking note:** the reply now says the masked values are only masked in the reply, and that the full values are in the saved answer.
* **Not changed:**
  * planning, whose call costs are what the plan's price is measured from;
  * the other parsers (social, maps, app stores);
  * search and people search.
* **Kill switch:** `DIGER_WEB_PAGE_REUSE=0` restores the old behaviour.

### No paid page for a company that is not saved

* In execution, when a detail step reads company pages, a page is bought only if one of these holds:
  * it is on the site of a company **already accepted in the item store**;
  * it is on a subdomain of that site;
  * it is linked from a page of that company (a redirect to another host keeps working: go-natural.shop → rootsegypt.shop/contact-us).
* Otherwise it is refused as `parent_not_saved`, at no cost.
* If saved companies carry no site at all, the rule cannot tell their pages apart and stops nothing.

## Accuracy before enabling (`tests/page-reuse-r60.test.ts`)

### Fixture caveat

The provider's 13 Nov markdown sits in the private bucket and could not be read from the development session. The comparison therefore uses the same 15 public pages, fetched directly over plain HTTP on 13 Nov ~18:30 UTC (no provider, no charge) and converted to markdown locally. `tests/fixtures/msn-088c-pages.json` holds each page's text and the row counts each parser call **returned** on 13 Nov (`mission_calls.rows_returned`).

### Results

| Field | Code vs the paid parser on 13 Nov |
|---|---|
| E-mails | Same count on all 13 parser calls of the readable pages. |
| Phones | Same on every page but one: first-cosmetics.com, parser 2 rows, code 1. The page carries one distinct number. |
| Links | Same count on 5 home pages (48, 119, 59, 37, 27). Close on the others (288/289, 43/45; go-natural.shop now redirects). Every contact page the model opened is among the links code reads. |
| Delivered values | All 6 found on their cited pages: info@nanostetic.com, +20222620242, info@bobana-eg.com, +201003308322, hello@donnanatural.com, +201130755305. |
| False positives | None. «562-597-239» on kaline.com is rejected, as are prices, dates and product ids. |

Phones are read in the forms the pages use («+2 02 22620242», «(202)26212652», «(+203) 548 0112», «01130755305» with the request's country). A national number is read only for Egypt. Anything else is left out, never guessed.

## Replay of the 13 Nov execution (the 40 recorded calls, in order)

| | 13 Nov (recorded) | With round 60 (offline replay) |
|---|---|---|
| Provider requests | 40 | 14 (11 pages + 3 failed attempts) |
| Paid calls | 37 | 11 |
| Unique paid pages | 13 | 11 |
| Repeated paid calls of one page | 24 | 0 |
| Empty paid calls | 16 | 9 (a page whose first-asked field was empty still gave its links or its other field) |
| Paid calls for an unsaved company | 5 (first-cosmetics.com) | 0 (5 refused at no cost) |
| Execution provider spend | $0.09398 | $0.02794 (−70%) |
| E-mails available for saved companies | 3 | 3, the same |
| Phones available for saved companies | 9 | 9, the same |
| Companies with no public contact on their pages | kaline, deoc (and avens, hktrade unreachable) | the same |

Data quality is not traded for the saving: the same contact values are available, and every delivered value is still read.

## Tests

* `tests/page-reuse-r60.test.ts` (23).
* Mutation-checked: each protection removed in turn (cache, parent gate, page lock, retry limit, no-answer accounting, linked pages) makes at least one test fail.

## For the owner (not applied)

`docs/proposals/spend-gate-spec.md` is the implementation-ready specification of the hard spend gate. It covers:

* owner, mission and day ceilings stored in the database, never passed by a caller;
* atomic row-locked reservations, upper-bound amounts and expiry as spent;
* fail-closed behaviour on a database outage;
* grants and security-definer rules;
* migration, rollback and running-mission compatibility.

Its §10 lists exactly what needs approval.
