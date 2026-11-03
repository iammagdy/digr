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
