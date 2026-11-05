Round 37 fixtures: the three files delivered for the real mission `msn_b56312efe3a41bef94a8`
(request: «اجمع ٥ ريلز من إنستجرام عن الذكاء الاصطناعي، مع النصوص والروابط وتاريخ النشر واسم الحساب وعدد المشاهدات.»), exactly as the customer's viewer saved them.

| file | sha256 |
| --- | --- |
| delivered.csv (CSV (1).csv; identical in size to the stored result/result.csv: 6,247 bytes) | 2d85cac9209903ac920ab3e2c9c6fde0218287717efe7b4b7bbd9ef2185b7686 |
| methodology.csv (المنهجية (1).csv) | ad0c6a558da70e51aea8be7d6b59f4b706326b09f2e2439199f2cdb5f5555d58 |
| delivered-saved-by-excel-android.xlsx (Excel (1).xlsx) | bfd1002e0b0f8698740563b4982cc4b6ede226133a5e35219e4ee2f7477d0a2a |

The XLSX is 16,140 bytes; the stored result/result.xlsx is 13,418. `docProps/app.xml` says `Application: Excel Android` (AppVersion 16.03): the copy under test was re-saved by Excel for Android, not written by Diger's writer.
Content: public Instagram posts of five public accounts read by a test account; no customer personal data.

## STATUS ON A CLEAN CHECKOUT: the three files are NOT in Git (found 5 Nov 2026)

`tests/round37-real-reels-excel-acceptance.test.ts` reads the three files above, but they were never committed: the repository's `.gitignore` rules `/tests/**/*.csv` and `/tests/**/*.xlsx` kept them out of commit b8b0661f (only this README and the test were added). On a clean checkout the test file therefore cannot load (`ENOENT: tests/fixtures/round37/delivered.csv`), and it fails the same way on every branch. No other copy exists in any branch, and none of the sanitized fixture sets under `tests/fixtures/live/` is this mission.

What was done: `.gitignore` now has an EXCEPTION for exactly these three file names, so that they can be committed. What was NOT done, on purpose: the files were not recreated, approximated or regenerated (they are the real evidence of one real delivery; any substitute would make the test prove nothing), and the test was not changed, skipped or loosened.

To close this (owner, once): from the device that saved them, copy the three files into this folder under exactly these names, check `sha256sum` against the table above (a different hash means a different file: stop), look at them once, and commit them.
