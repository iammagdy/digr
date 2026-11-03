# Diger anonymised raw pages (28 missions), version 2

Source: the owner's admin raw-pages ZIPs (PR #347), 28 missions of docs/FOUNDATION-PLAN.md,
509 files (raw/*.json and rows/*.json), originals 19,603,637 bytes.

Version 2 fixes the two gaps the PR 2a session found in version 1:
- the yes/no exemption is gone: a commenter's one-word «نعم» / «لا» is now a placeholder.
  Diger's own flag columns (is_reply, verified, liked_by_creator, ...) keep their values.
- a link inside a personal field (text, description, ...) is now a placeholder too.

Rule: whitelist. Kept: structure, numbers, booleans, ids, cursors and paging tokens, dates,
types, statuses, language and country fields, counters, Diger's request params under requestParams.
Replaced: every other string with نص_<hash> (Arabic originals) or txt_<hash>. Same original -> same
placeholder. URLs outside personal fields: platform hosts kept, other hosts hashed, path segments kept
only when they are ids, query dropped except id params. Provider tokens and cookies redacted.
The random salt is not included.

Checks run on this version (same rule as the session's scan):
- 15,454 string values in personal fields (name, author name, username, handle, unique_id, nickname,
  text, message, caption, title, description, bio, place, address; case, _ and - ignored):
  0 that are neither a placeholder nor empty.
- no "eyJ", no "Bearer ", no tt_chain_token cookie, no e-mail address anywhere.

## Added in live round 7 (3 Nov 2026)

Two more missions from the owner's admin raw-pages ZIP, anonymised with `anonymise.py` (8 files): `msn_9fa5ba384c05a25247e1` (X; the five REAL replies pages of the first live run of the X replies tool, `raw/call_0003..0007`, and its delivered `rows/tweets.json`, `rows/replies.json`) and `msn_4e68812d396bd5db0a01` (TikTok; the real first search page, `raw/call_0001`). Captions, texts and handles are placeholders, so a test that needs a caption builds it (made up) on the real structure. The provider's `hint` string on the replies pages is replaced by the anonymiser; its words are recorded in `tests/live-e-x-replies-real.test.ts`.

## Added in live round 8 (3 Nov 2026)

One more mission from the owner's admin raw-pages ZIP, anonymised with `anonymise.py` (16 files): `msn_50e3b83c44e7ebd7f577` (X; the 14 REAL replies pages of the first live run of the pageable replies route, `raw/call_0003..0016`, and its delivered `rows/replies.json` and `rows/tweets.json`). The two search pages of that mission are not kept. Cursors are kept by the whitelist (they are the opaque paging tokens the next call asked for); the provider envelope fields (`provider`, `costUsd`, `source`) are kept, the source's name is a placeholder. The 14 calls are in `call-index.json`. Used by `tests/live-g-x-replies-verified.test.ts`.

## Added in PR 3 (4 Nov 2026): the Facebook, Instagram and YouTube calls in `call-index.json`

No new page is committed: the raw pages of M1, M2, M4, M15-M20 and the eight Facebook search missions were already here (version 2). PR 3 adds their CALLS to `call-index.json` (read-only SELECT on `mission_calls`; each SELECT is listed in the PR) so the replay gateway can serve a stored page for the same tool and the same inputs. The same rules as before: a link is reduced to the numeric id it carries (an Instagram post's short code is converted to its media id by the code's own base-64 rule, `instagramMediaIdOf` in `tests/helpers/replayGateway.ts`); the Instagram account handle is a personal field, so the index keeps a placeholder (`txt_a11ce1`) and the replay compares nothing of its value; a Facebook post link that carries no numeric id (a `pfbid` link) is not indexed, so a replay never serves a page for a post it cannot tell apart; the two page-listing calls of M17 and M19 are indexed under the page's numeric id (`pageId`), never its handle. The privacy scan (`tests/fixtures-anonymised.test.ts`) passes on the index.

Where the compiler's own inputs differ from the words the model used live (the in-channel search words of YouTube, the comments tool's `limit`), the test that needs it says so (`only` in `ReplayOptions`) and the stored page is served by the other inputs; a page the live run never read (the second Facebook search page, by cursor) is lent by a stored page of the same tool only where the test says it (`borrow`).

## Added in live round 11 (3 Nov 2026): `round11/stored-public-plans.json`

No raw page is added. One file of NUMBERS read by SELECT: the stored `plan_public` stages (key, deliver, expected_rows only: no text, no id of a person) of two finished missions of the test account, with the job's own number and the number the file and the chat say, for `tests/round11-orders-count.test.ts`.
