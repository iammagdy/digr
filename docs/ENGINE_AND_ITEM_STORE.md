# One item store and a code engine: why, what, and what is NOT proven

Owner decision (2026-10-29, binding): **the model PLANS, code EXECUTES.** After the customer approves a plan, a deterministic code engine runs it: it reads the source page after page (resuming, never restarting), de-duplicates, checks every item (rules first, the model only for the genuinely ambiguous, in batches, within the review budget), stores every item in ONE item store, goes on until the matching items the customer bought are saved or a stop reason is RECORDED, builds the customer's file, reads it back and settles from it. The model cannot lose, double count or stop early.

## 1. What went wrong (STEP 1 evidence, read-only; test account, mission `msn_3e6b1b5f7d3abc7a1748`, 2026-10-28 21:48-21:52 UTC = 00:48-00:52 Cairo on the 29th)

Request «هات ٣٠٠ تغريدة عن محمد صلاح». Mission row: `completed`, reserved 200, unit 0.666666, `delivered_units` 192, `charged_points` 128 (= ceil(192 x 0.666666)), hold 200 released. The file the owner downloaded, at completion and later from «طلباتي», has **77** items and its summary sheet says «تم تسليم ٧٧ من ٣٠٠ تغريدة».

Events in order (UTC; counts are the events' own `counts`):

| id | time | what |
|---|---|---|
| 124 | 21:50:23.78 | save 1: saved 9, checked 9, accepted 9 |
| 126-133 | 21:50:31-49 | source pages 1 to 8 (20 items each; found 160) |
| 134 | 21:50:55.75 | save 2: saved 77, checked 79, accepted 77, excluded 2 |
| 136-143 | 21:51:00-19 | pages 9 to 16 |
| 148 | 21:51:35.28 | save 3: saved 192, checked 201, accepted 192, excluded 9 |
| 150-163 | 21:51:39-21:52:13 | pages 21 to 34 (found 680) |
| **164** | **21:52:19.08** | **save 4: saved 300, checked 242, accepted 185 (lower than the 192 of save 3), excluded 10** |
| 166, 167 | 21:52:24.85, 21:52:25.04 | tokens; the check report (examined 242, by rule 185, excluded 10, pending 0) |
| 168 | 21:52:26.07 | result: delivered 192, charged 128 |

35 provider calls (1 planning, 34 execution), every one ok, 20 items each, 0.00054 USD each. 680 items were found; 242 were ever checked.

Storage (`storage.objects`, bucket `agent-missions`; every object carries `cacheControl max-age=3600`):

| object | size | created | last written |
|---|---|---|---|
| `rows/tweets.json` | 123,129 | 21:50:23.233 | **21:52:21.559** |
| `excluded/tweets.json` | 3,175 | 21:50:23.341 | 21:52:21.898 |
| `checks.json` | 169 | 21:50:23.740 | 21:52:21.996 |
| `collect/0zlpjkv.json` | 17,073 | 21:50:49.642 | 21:52:13.097 |
| `result/result.xlsx` | 27,593 | 21:52:25.592 | (created once) |
| `result/result.csv` | 38,118 | 21:52:25.706 | (created once) |

Order of the end: last save event 21:52:19.08 -> `rows/tweets.json` written again 21:52:21.559 (2.5 s after save 4 reported 300) -> `excluded` 21:52:21.898 -> `checks.json` 21:52:21.996 -> check report 21:52:25.04 -> file build and publish 21:52:25.1-25.7 -> settlement and completion 21:52:26.03.

**Where the 115 items (192 delivered vs 77 in the file) were lost.** Reading of the evidence (the OBJECT CONTENTS were not read: this session has no storage read access; paths below):

1. Every save did `read rows/tweets.json -> extend -> overwrite it`. Supabase Storage serves an overwritten object from its CDN edge nodes with the OLD content for up to 60 seconds (Supabase docs, «Overwriting files» and «Smart CDN»: «we do advise against overwriting files ... the CDN will take some time to propagate the changes to all the edge nodes leading to stale content; uploading a file to a new path is the recommended way»). #281's in-process lock does not help: the lost update is in the storage READ, not in the process.
2. Proof that reads returned older objects than were written: save 4 reported `accepted 185, checked 242`; its counters are exactly save 2's state (77 accepted, 79 checked) plus its own 108 accepted and 163 checked. It read `checks.json` as it was after save 2, although save 3 had written a newer one.
3. `rows/tweets.json` was written again at 21:52:21.559, AFTER save 4's event (the closing pass of `finish` saves nothing but writes back what it read). Its size, 123,129 bytes, fits 192 items (the earlier mission's 250 items were 173,673 bytes: 695 bytes an item; 123,129 / 695 = 177, 192 items at 641), not the 300 of save 4 (about 190,000 bytes). So the closing pass wrote back an older version and destroyed save 4's 300.
4. The settlement read `rows/tweets.json` twice within milliseconds (`countDeliveredRows`, then the rows for the file): the first read gave 192 (delivered, charge, notice, e-mail, «طلباتي»), the second gave 77 (the file's rows and its summary sheet). Two reads of the same object returned two different versions.
5. The tracker's «٣٠٠ من ٣٠٠» was the last save event's `saved` (the writer's own memory of 300). 379 found items were never checked because the model's `run_code` handed `save_rows` subsets and then stopped.

The run before (`msn_0a9ebe1b55e4bfb65ef6`, delivered 250, charged 202, file 250, tracker 300) is the same defect with a milder outcome: the last write of `rows/tweets.json` was 20:11:47.27 (save 5, 300 items), the settlement read it at 20:11:54.6 (7 s later) and got the 250-item version.

To confirm the contents, the owner can download: `agent-missions/msn_3e6b1b5f7d3abc7a1748/rows/tweets.json` (expected about 192 items), `.../checks.json`, `.../collect/0zlpjkv.json`, `.../result/result.xlsx` (77 items), `.../result/result.csv`.

### Missions since merge `aefb7c07` (#273, 2026-10-28 16:00 UTC) whose charge disagrees with the stored file

Five missions exist since then, **all test accounts, no real customer, no admin**; nobody real was overcharged.

| mission | status | charged | delivered | file |
|---|---|---|---|---|
| `msn_480a44f9...` | plan_ready | - | - | - |
| `msn_4b08aab1...` | needs_input | - | - | - |
| `msn_56a3a9da...` | completed | 50 | 300 | CSV 129,199 B (about 431 B an item = about 300; not opened) |
| `msn_0a9ebe1b...` | completed | 202 | 250 | 250 (owner-reported) |
| `msn_3e6b1b5f...` | completed | 128 | 192 | **77** (owner-reported): charged for 192, file 77; at 77 it would be ceil(77 x 0.666666) = 52, so 76 points too many |

## 2. The design

**ONE ITEM STORE** (`agent/src/items/itemStore.ts`) is the single source of truth. It is an append-only log of IMMUTABLE objects `items/seg_<seq>_<writer>.json`, each written once with a create-only upload to a path nobody has read before (a never-overwritten path has no stale copy), and read through the LISTING (which reads the database and is exact right after a write) followed by a download of exactly the names it returned. Nothing is ever read, extended and overwritten. A commit appends one segment holding the verdicts of a batch together with the page that gave them (so a cursor and its items cannot disagree after a crash). The state is a fold of the log in (seq, writer) order: the first appearance of an id wins; a later `resolve` only moves a pending item. The writer's memory is never ahead of storage (it applies ops after the segment was stored); a segment that cannot be stored throws and changes nothing; an unreadable segment is an error, never a gap.

Counts, one definition for every screen: `found = new + duplicates`; `new = accepted + excluded + pending + unchecked`; `saved = accepted` (persisted); `delivered` = the items in the final file, counted from the file.

**THE ENGINE** (`agent/src/engine/run.ts`): for every stage in order, reads pages from the cursor the log recorded (resume, never restart; a source paged by a page number is read by the next number), maps each page with the plan's recipe, checks and stores each item (`items/ingest.ts`: rule first; the model only for what the rule cannot decide, in batches, within the review budget; items the review could not reach stay PENDING and are asked again), and goes on until the target is reached or a stop reason is RECORDED: `target_reached`, `source_exhausted`, `no_new_items`, `budget`, `daily_cap`, `refused`, `time_limit`, `review_limit`, `failed`, `page_limit`, `no_parents`, `model_stopped`. The shortfall sentence is built from that reason (`agent/src/finalize.ts`). A parent whose children could not be read (two failed calls) is skipped and the stage goes on with the others; three in a row end the stage as `failed`; items the review could not reach are asked again until none is left or a round makes no progress (`drainPending`).

**THE RECIPE** is derived BY CODE at plan time (`agent/src/engine/spec.ts`) from what the agent really did: its measuring call (inputs, saved page) and the `run_code` that mapped that page. Code runs the recorded mapping again on the very page and requires the same rows, one row for every row the call returned; for a stage with a parent it finds which input takes which parent field. A stage that cannot be proven has no recipe, and a plan with any such stage is carried out by the model (same store, same checks), with `finish` refused (a few times) while matching items are needed and a source has more pages, and further rounds when a round ends early.

**SETTLE FROM THE FILE** (`runMission.ts: settleExecution`): the log is read fresh, the files are built and published, the xlsx is read back and its items counted from the file itself; that count is the delivered count, the charge basis (ceil(count x unit), never above the reserve, through the existing money functions), the count in the result event, the notice, the e-mail, the panel and the summary sheet. A disagreement (memory vs log, log vs file, file unreadable) charges by the file and flags the mission for the admin (internal event with `adm_flag`, `adm_store`, `adm_file`, `adm_memory`; `missions.error` = `admin: ...`).

**Customer text**: one money line per mission, the same everywhere: «خُصم ١٢٨ نقطة مقابل ١٩٢ تغريدة» (`src/lib/agentMission/moneyText.ts`); nothing delivered: «لم يُخصم شيء؛ حجز مؤقت مُحرَّر ٢٠٠ نقطة». The wallet groups one mission's hold, charge and release under that line with collapsible details (ledger rows unchanged). The plan card says: the price shown is the full-delivery price; fewer costs in proportion; nothing costs nothing.

**Tracker**: the final number is the file's count; the time left is smoothed and rises only after several events in a row say so; the bar's accessible value is the count shown (`aria-valuenow` = saved, `aria-valuemax` = bought, `aria-valuetext` = the words on screen).

The older files (`rows/<stage>.json`, `excluded/<stage>.json`, `checks.json`, `review_state.json`) are still written, from the store, for the admin page and the older readers; nothing reads them to decide anything. A mission an older worker started (rows in `rows/`, no log) is imported once.

## 3. Tests

`tests/helpers/cdnStaleStore.ts` is a store with the real storage's read semantics (an overwritten object is served stale for a few reads; a created-once object never). `tests/items-store.test.ts` proves concurrent writes lose nothing on it and that the OLD pattern loses items on the very same store (the defect, reproduced), and replays the live run's save sequence. `tests/engine-x-posts.test.ts`, `tests/engine-mission-types.test.ts` (Facebook posts + comments, TikTok videos + comments, companies + employees) and `tests/engine-settlement.test.ts` (settle from the file, resume never restarts, every stop reason, finish refused, review limit) run whole missions through the replay harness.

## 4. NOT PROVEN

- Nothing here ran on the live Supabase Storage: the create-only upload, the listing's pagination and the immutability of the new objects are asserted from the Supabase documentation and by a simulated store, not by a live write.
- Whether the real model's planning mapping covers EVERY row of the measured page (the prompt now says so; the code checks it). A plan that fails the check is carried out by the model, through the same store, and that path is only as good as before plus the gate.
- Page-number sources (`page`) are read by the next number until an empty page or a repeat; the real behaviour of each catalog endpoint was not exercised.
- Memory of the worker with several thousand items in the store (the engine starts no SDK process, which should lower it; not measured).
- The wallet page, the panel and the e-mail were not seen in a browser or a mail client.
- The file counts of `msn_56a3...` and `msn_0a9e...` were not read from the files (no storage read access here).
