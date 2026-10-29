# TREG key pool: design (STEP 1, NOT BUILT, NOT APPLIED)

> **STEP 2 update (built).** The design below was approved (D1 to D8, all defaults) and built; SQL files 01 to 04 were applied by the owner and verified. While building, one gap in file 03 was found and is closed by ONE new additive function in `06_treg_pool_check_keys.sql` (+ rollback + `06_verify_after_apply.sql`, validated on a scratch Postgres, **NOT APPLIED until the owner applies it**): `treg_pool_runtime()` deliberately hands out no ciphertext while the switch is OFF and none for keys outside the chain, so the background health check and «فحص الآن» need `treg_pool_keys_for_check()` to read the keys they check (service role only, returns secrets, writes nothing). Until 06 is applied the call path, the switch, the failover and the e-mails all work; only the health check and the live refresh say «SQL 06 not applied». Section 8 below counts files 01 to 04 (23 functions); 06 adds the 24th.
>
> Original STEP 1 status line follows.

Status: **design only**. No application code is written, no SQL is applied, nothing was called at a provider. Facts below come from `origin/main` at `51e5d3a1dfee5c5fcb32db7d22dcec9f3a7ede8c` (the #289 merge) and from read-only SELECTs on the live project. The SQL files in this folder are proposals: the owner applies them by hand after review.

Goal (owner): stop burning the main TREG credit in tests. A pool of TREG keys (many test keys of about 1 USD, plus the main key) and ONE active key chosen from the admin panel, used at once by the website AND the Heroku worker, with an always-on fallback chain that ends at the main key.

## 0. The answer in ten lines

1. A new admin section in «مزودو الخدمة» → TREG: a numbered table of keys (label, account e-mail, last 4, live balance, status, last check, spend, a mark on the main key), add / remove / activate / reorder, and the **rollout switch, OFF by default**.
2. While the switch is OFF the platform behaves exactly as today (website: encrypted store key then `TREG_TOKEN`; worker: Heroku `TREG_TOKEN`). Turning it OFF again restores that within about 3 seconds.
3. ON: every provider call of the website and of the worker asks one shared module for the active key. The answer is cached 3 seconds, so a switch is live on the very next call after at most 3 seconds. No restart, no deploy. A running mission continues on the new key from its next call.
4. When the active key is **revoked / rejected (401, 403) or out of balance (402)** the module **verifies** it with the free `/auth/me` and balance reads, records the verdict, moves the active key to the next healthy key of the chain (the main key is always the last step), retries that one call on it, and queues an admin e-mail. Timeouts, 5xx, 429, 400/404/422 and per-call price caps never switch anything.
5. A background check (every 10 minutes at most, driven by a new pg_cron job, read-only calls) refreshes every key's status and balance and e-mails once when a pool key breaks.
6. Every provider call records which key made it (number and label only) in a new side table joined to `provider_costs`; the calls log filters by key and the pool table shows spend per key.
7. **SQL is additive only**: five new tables, 23 new functions (plus one trigger function), one Vault secret, one cron job. Nothing existing is altered or dropped; applied before the code, today's platform keeps working unchanged (proved on a scratch Postgres, section 8).
8. **Secrets**: keys are AES-256-GCM encrypted by the application; the encryption key is generated **inside Supabase Vault** and read by a service-role-only function from both Vercel and Heroku. **No Vercel or Heroku variable changes, nothing is pasted anywhere, the existing Firecrawl / Context.dev / Anthropic keys are untouched** (section 6).
9. If the database or key store cannot be read, the worker uses `TREG_TOKEN` (the main key) and the admin is e-mailed; it never uses a non-main key silently (section 4.5).
10. Rollout order: apply SQL → merge with the switch OFF → add main + test keys → switch ON → tiny mission → check the call log → revoke-test the fallback → decide (section 9).

## 1. What exists today (read from the code and the database, nothing assumed)

| Fact | Where |
|---|---|
| Website TREG key = `resolveProviderKey("treg")`: encrypted store row (`provider_api_keys`, `PROVIDER_KEYS_ENCRYPTION_KEY` on Vercel), else `TREG_TOKEN`. 30 s cache. Every call site goes through it (a test greps for any other read). | `src/lib/server/providerKeys.ts`, `tests/provider-keys-call-sites.test.ts` |
| Worker TREG key = `process.env.TREG_TOKEN`, passed as an explicit `token` to `executeTregCall` by the gateway. The worker never reads the TREG key store. | `agent/src/main.ts` (`token: process.env.TREG_TOKEN`), `agent/src/gateway.ts` |
| One funnel for every TREG call: `executeTregCall` (`tregClient.ts`). It already classifies `isPlatformBalanceLow` (HTTP 402, not `route_max_cost`) and `reportProviderHttpStatus` (401/403). It never switches keys. | `src/functions/shared/tregClient.ts` |
| Costs are recorded through `callRecorder.reserve/commit` into `provider_costs` (UTC-day caps per provider, `reserve_provider_spend_atomic`, `commit_provider_spend_v2`). The key is not recorded anywhere. | `src/lib/server/multiProvider/callRecorder.ts` |
| Real balance of a key: `GET /auth/me` then `GET /orgs/{org}/balance`, both free reads. The plan capacity gate budgets against it. Status cache is keyed by provider only (60 s). | `src/lib/server/providerStatus.ts`, `realProviderBalance.ts` |
| Calls log = `provider_costs` rows (`readCallsLog`), admin only; the worker's calls are in it too (the gateway commits `provider_costs`). `mission_calls` has no key column. | `src/lib/server/adminCallsLog.ts` |
| Admin e-mail: `sendPlatformEmail` → `send-email` Edge Function (v4) with a generic Arabic «job-update» template; recipient `ADMIN_ALERT_EMAIL` (a Vercel variable). | `topupOwnerAlert.ts`, `sendPlatformEmail.ts` |
| Database (SELECT only, project `pfinlfaqwnytesedchik`): `provider_api_keys` has `treg` v5 (last 4 `Az7w`), `firecrawl` v1, `contextdev` v1; `pg_cron`, `pg_net`, `supabase_vault` installed; cron jobs `diger-drive-jobs` and `diger-cron-cleanup`; Vault secrets `diger-app-base-url`, `diger-cron-secret`; `provider_costs.id` is `bigint`; `mission_calls` has `provider_cost_id`. | live SELECTs of this session |

Consequence for the design: the **resolver** (`resolveProviderKey("treg")`) and the **funnel** (`executeTregCall`) are the only two places that need to know about the pool. Everything else follows.

## 2. Data model (files `02_...` and `03_...`)

| Table | Purpose | Notes |
|---|---|---|
| `treg_pool_keys` | one row per key: `id` (uuid, also the AAD of the ciphertext), `number` (identity, 1, 2, 3 ... never reused), `label`, `is_main`, `in_chain`, `chain_position`, `ciphertext`, `last4`, `account_email`, `status` (`unknown / connected / error / revoked / out_of_balance`), `status_reason` (fixed code), `status_checked_at`, `balance_micro`, `balance_checked_at`, `removed_at` | at most ONE live main (partial unique index); a removed key keeps its row (call log history) but its ciphertext is erased; **no grant at all, not even to `service_role`**: only functions read it |
| `treg_pool_state` | the single row: `rollout_on` (default false), `active_key_id`, `generation`, `min_balance_micro` (default 10,000 = 0.01 USD), `last_health_run_at`, `worker_env_last4` | SELECT to `service_role` |
| `treg_pool_events` | append-only trail (key added / removed / replaced, active set, chain set, rollout on/off, failover) with numbers and labels, never a key | UPDATE/DELETE blocked by trigger, like `provider_key_audit` |
| `treg_pool_alerts` | admin e-mail outbox + debounce | one OPEN row per (problem, key); the same pair is refused for 30 minutes after the last one; the Vercel cron route sends them |
| `treg_pool_calls` | `provider_cost_id` → key number and label | no foreign key to `provider_costs` on purpose; per-key spend is `treg_pool_spend()`, a read-only join |

Functions (all `SECURITY DEFINER`, pinned `search_path`, `REVOKE` from `PUBLIC/anon/authenticated`, `GRANT` to `service_role`):

- **Admin (role verified inside, like `admin_set_provider_key_atomic`)**: `admin_add_treg_pool_key`, `admin_replace_treg_pool_key`, `admin_remove_treg_pool_key` (never the main key, never the key in use), `admin_set_treg_active_key` (a revoked / out-of-balance key needs an explicit force), `admin_set_treg_chain` (ordered non-main keys; main is implicit and last), `admin_set_treg_rollout` (ON needs a main key), `admin_set_treg_pool_settings` (minimum balance).
- **Runtime**: `treg_pool_enc_key()` (Vault), `treg_pool_runtime()` (switch, active key, chain in order, main last; **returns no ciphertext at all while the switch is OFF**), `treg_pool_record_failover(...)` (compare-and-set: only the caller whose failed key is still the active key switches; says which alerts it opened), `treg_pool_record_check(...)`, `treg_pool_record_call(...)`, `treg_pool_spend()`, `treg_pool_overview()` (no ciphertext), `treg_pool_claim_health_run(...)`, `treg_pool_note_worker(...)`, `treg_pool_claim_alert(...)`, `treg_pool_take_pending_alerts(...)`, `treg_pool_mark_alert_emailed(...)`, `treg_pool_tick()` (file 04).
- **Internal (no grant to anyone)**: `treg_pool_log_event`, `treg_pool_clear_alerts`, `treg_pool_next_key`.

## 3. Runtime: how a call picks its key

```
call site ──► resolveProviderKey("treg") ──► tregKeyPool.choose()
                                               │
              snapshot = treg_pool_runtime()   │  cached 3 s per server instance (in-flight shared)
                                               ▼
   rollout OFF or pool SQL not applied ──► LEGACY (website: store key → TREG_TOKEN; worker: TREG_TOKEN) — exactly today
   rollout ON  ──► decrypt the active key (AES-GCM, AAD = key id, encryption key from Vault, cached 10 min) → call
   can't read DB / Vault / decrypt ──► EMERGENCY = the main key from TREG_TOKEN (+ alert), see 4.5
```

- **Instant switch**: the admin action writes `active_key_id` and bumps `generation`. Every instance (each Vercel function instance and the worker) re-reads within 3 seconds. A call already in flight finishes on the old key; the next call uses the new one. The worker needs no restart because it asks per call (`gateway.tregCall` passes `legacyToken: TREG_TOKEN` instead of a fixed `token`; the pool decides).
- **Cost of it**: one `treg_pool_runtime()` per instance per 3 s at most, one `treg_pool_enc_key()` per 10 min, one small `treg_pool_record_call()` per recorded call (awaited with a 1.5 s cap, errors swallowed: a missing mark never fails a call).
- **Status cache fix**: `getProviderStatus` caches by provider only; the pool keys it by key id, so the admin sidebar and the plan capacity gate show the ACTIVE key's balance (with a 1 USD test key active, plans larger than its balance are refused at plan time, which is what a test wants).
- **Explicit `token` option** (tests, one-off scripts) keeps bypassing everything, as today.

### 3.1 The failure rules (the heart of requirement 3)

After a call answers, if the key used was a pool key and the answer is one of:

| Answer | Treated as | Action |
|---|---|---|
| 401 | candidate: key rejected | verify with `GET /auth/me` using the same key: still 401/403 → **revoked**; answers fine → it was not the key, no switch |
| 403 | candidate (could also be an endpoint-level refusal) | same verification; only a confirmed rejection switches |
| 402 and not `route_max_cost` (`isPlatformBalanceLow`) | **out_of_balance** | no verification needed |
| 402 `route_max_cost` | the call's own price cap | nothing |
| timeout, network error, 5xx, 429, 400/404/422 | transient or the request's own problem | **nothing switches** |
| verification itself fails (timeout/5xx) | inconclusive | nothing switches; the next failing call verifies again |

When a verdict is **revoked** or **out_of_balance**: `treg_pool_record_failover(key, status, reason, source)` runs (one transaction under one lock): it marks the key, and **only if that key is still the active one** moves the active key to `treg_pool_next_key()` = the first live key AFTER it in the chain that is not known bad, else the **main key**. It records an event and opens the alerts (`failover`, plus `chain_reached_main` when the target is main). The call is then retried once on the new key (same idempotency key; a failed 401/402 call was not billed), at most 3 hops, the last hop always main. If the failed key IS the main key, nothing is left after it: the failure is returned as today and a `main_failed` alert is queued. Two servers failing together switch once and open each alert once (the compare-and-set returns `switched: false` to the second).

The chain only moves forward (2 → 3 → 4 → main). A key that fails is skipped by later walks while its status is bad; the health check restores `connected` when TREG says so, **the active key never flips back by itself** (the admin chooses).

### 3.2 The main key

- Lives in the pool as the live row with `is_main = true`, always the last step (the order is `is_main, chain_position, number`, so it cannot be moved or left out). It can be **replaced** (`admin_replace_treg_pool_key`), never removed (`main_cannot_be_removed`). The key currently active cannot be removed (`key_in_use`).
- **Adoption without copying a secret**: a one-click admin action «اعتماد المفتاح الحالي كمفتاح رئيسي» decrypts today's TREG store key on the server (it has the old encryption key) and re-encrypts it into the pool with the Vault key. The key never reaches a browser. Fallback if that fails: paste the main key from Heroku's «Reveal Config Vars» (`TREG_TOKEN`) into the same admin form.
- `TREG_TOKEN` on Heroku is **not touched**; it stays the worker's legacy and emergency source. The worker reports its last 4 characters (`treg_pool_note_worker`) and the table warns if they differ from the main key's.

## 4. Behaviour matrix

| Situation | Website | Worker | E-mail |
|---|---|---|---|
| Switch OFF (default), or pool SQL not applied | store key → `TREG_TOKEN` (today) | `TREG_TOKEN` (today) | none |
| Switch ON, DB readable | active pool key | active pool key | on failures, see 5 |
| Active key revoked / out of balance | verify → switch → retry once | same | failover (+ chain reached main) |
| Chain exhausted, main active and failing | returns the failure as today | same | `main_failed` |
| DB or Vault unreadable, or decrypt fails | today's resolver (store → env) | `TREG_TOKEN`, after at most 30 s of grace on the last good active key | `store_unreadable`, queued in memory by the worker and flushed when the DB is back; sent directly if `ADMIN_ALERT_EMAIL` is set on Heroku |
| Switch turned OFF during a mission | next call uses legacy keys | same | none |

4.5 **Emergency rule (requirement c, and my reading of «never silently»)**: when the pool cannot be read the worker uses `TREG_TOKEN`, never a non-main key. One deliberate exception, to avoid burning main credit on a database blip: for at most **30 seconds** it may keep using the last good active key it already holds (the admin's own choice, not a fallback). After that it is `TREG_TOKEN` + alert. Decision D2 below sets this grace to 0 if the owner wants it stricter.

## 5. Admin e-mails (Arabic, short, admin only; sent by the new cron route through the existing `send-email` path, template «job-update», digits Arabic-Indic, times Cairo)

One e-mail per **key per problem episode** (`treg_pool_alerts`: one open row per pair, a repeat within 30 minutes refused, cleared when the key is connected again or replaced). Retried up to 5 times if sending fails. They name the provider and `TREG_TOKEN` because only the owner reads them (like the admin pages).

| Problem | Subject | Lead |
|---|---|---|
| `failover` | تنبيه: انتقلت المنصة إلى مفتاح TREG رقم ٣ | توقّف المفتاح رقم ٢ (اختبار-٢) لأنه أُلغي / انتهى رصيده / رفضه المزود. انتقلت المنصة تلقائيًا إلى المفتاح رقم ٣ (اختبار-٣) وتابعت العمل دون أن يتأثر أي عميل. |
| `chain_reached_main` | تنبيه: المنصة تعمل الآن على المفتاح الرئيسي | لم يبقَ مفتاح اختبار صالح في السلسلة، فانتقلت المنصة إلى المفتاح الرئيسي (رقم ١). أي اختبار الآن يُخصم من رصيده. أضف مفتاحًا أو فعّل مفتاحًا صالحًا للعودة. |
| `health_broken` | تنبيه: مفتاح TREG رقم ٤ لا يعمل | وجد الفحص الدوري أن المفتاح رقم ٤ (اختبار-٤) أُلغي / انتهى رصيده / يعطي خطأ. ليس نشطًا الآن فلم يتأثر العمل، وسيُتخطّى في السلسلة إلى أن يعود. |
| `main_failed` (extra, D5) | عاجل: المفتاح الرئيسي لـ TREG لا يعمل | المفتاح الرئيسي (رقم ١) أُلغي / انتهى رصيده ولا يوجد مفتاح بعده، وقد تتعطل طلبات العملاء. اشحن الحساب أو استبدل المفتاح فورًا. |
| `store_unreadable` (extra, D5) | تنبيه: تعذّرت قراءة مخزن مفاتيح TREG | تعذّر على الموقع / العامل قراءة مخزن المفاتيح، فاستُخدم المفتاح الرئيسي المضبوط في البيئة (TREG_TOKEN) بدل المفتاح النشط. لم يُستخدم أي مفتاح اختبار. |

Each carries the time and a button «افتح مزودو الخدمة» (`/admin/providers`). The key itself never appears; the number and label do.

## 6. Secrets design (requirement d)

**Chosen: the pool encryption key lives in Supabase Vault and is read by a service-role-only function from both Vercel and Heroku.**

- File `01` creates the secret `diger-treg-pool-enc-key` **inside the database** (`gen_random_bytes(32)`, base64). Nobody sees it. `treg_pool_enc_key()` (service role only) returns it; the application keeps it in memory for 10 minutes.
- Keys are encrypted by the application (AES-256-GCM, random nonce, AAD `digr:treg-pool:<key id>`, so a ciphertext cannot be moved to another row) with the existing format `v1.<nonce>.<ct>.<tag>`. The plaintext key never reaches SQL, a function argument, a log, an error text or an e-mail; the browser only ever sees last 4.
- **Owner steps for the secret: none beyond running file 01.** Vercel and Heroku already hold `SUPABASE_SERVICE_ROLE_KEY` (the worker uses it today). No new variable, no copy between platforms, nothing pasted in chat. `PROVIDER_KEYS_ENCRYPTION_KEY` and every key already stored with it (TREG store key, Firecrawl, Context.dev, Anthropic) are untouched, so nothing existing is re-entered.
- Trade-off, stated plainly: the ciphertext and the Vault key are in the same project, so whoever holds the service-role key can read the pool keys. That is the same trust level as the Vercel server today (it holds the service-role key AND `PROVIDER_KEYS_ENCRYPTION_KEY`). A database dump alone (without the Vault root key) does not reveal pool keys. The main key keeps living in two places only because it already does (Heroku, old store).

Rejected alternative A: set the same `PROVIDER_KEYS_ENCRYPTION_KEY` on Heroku. Vercel sensitive variables cannot be revealed, so it could not be copied; a NEW key would be needed and every stored key re-entered in the admin. If the owner prefers it anyway: (1) generate locally `openssl rand -base64 32` and never paste it in chat; (2) set it as `PROVIDER_KEYS_ENCRYPTION_KEY` on Vercel (Production + Preview), redeploy; (3) set the same value on Heroku (Settings → Config Vars); (4) in the admin re-enter Firecrawl, Context.dev, Anthropic and TREG keys through «استبدال المفتاح». I recommend against it: more steps, a window where stored keys are unreadable, and the value must be carried between two dashboards.

## 7. What changes in code (STEP 2, listed so the review is concrete)

New: `src/lib/server/tregKeyPool.ts` (snapshot cache, `choose`, `classify`, `failover`, recorder; no Next imports so the worker can use it), `tregPoolCrypto.ts`, `tregPoolAdmin.ts`, `tregPoolHealth.ts`, `tregPoolAlerts.ts`; routes `src/app/api/admin/treg-keys/route.ts` (admin only) and `src/app/api/cron/treg-pool/route.ts` (cron secret); UI `src/components/admin/TregKeyPool.tsx` shown inside the TREG tab of `ProviderTab.tsx`.
Edited (small): `providerKeys.ts` (resolve `treg` through the pool when ON), `tregClient.ts` (`legacyToken` option, failover loop, `keyRef` on the result), `callRecorder.ts` + the three commit points (`agent/src/gateway.ts`, `adapters/treg.ts`, `app/api/worker/chunk/route.ts`) to pass `keyRef`, `providerStatus.ts` (cache by key), `adminCallsLog.ts` + `AllCallsLog.tsx` + the calls-log route (key filter, key column, spend per key), `agent/src/main.ts` and `agent/README.md`, `docs/HANDOFF.md`. **No** change to money functions, ledger, pricing, caps, the model string, or any customer text.

Admin screen (inside «مزودو الخدمة» → TREG, below today's blocks, which stay):

```
مجمّع مفاتيح TREG                                      [ تشغيل المجمّع: مغلق ]   ← OFF by default
مغلق: المنصة تعمل بالمفتاح الحالي كما هي اليوم.   النشط الآن: رقم ٢ (اختبار-١)

 #   الاسم            بريد الحساب      آخر ٤   الرصيد المتبقي   الحالة        آخر فحص    الاستهلاك         إجراءات
 ١   الرئيسي          main@…           Az7w    ١٢٫٤٠ دولار      متصل          ١٠:٠٢      ٠٫٤٢ دولار        استبدال
     ┗ الرئيسي / الافتراضي · آخر خطوة في السلسلة دائمًا
 ٢   اختبار-١  ● نشط  t1@…             bb2c    ٠٫٩١ دولار       متصل          ١٠:٠٢      ٠٫٠٩ دولار        ↑ ↓ حذف(معطّل: قيد الاستخدام)
 ٣   اختبار-٢         t2@…             cc3d    ١٫٠٠ دولار       ملغى          ١٠:٠٢      —                 تفعيل ↑ ↓ حذف
 [ أضف مفتاحًا ]  [ فحص الآن ]  [ ترتيب السلسلة: ٢ ← ٣ ← الرئيسي ]
```

The calls log gets a key filter («كل المفاتيح / رقم ٢ / … / قبل التفعيل») and a column «المفتاح» (`#٢ · اختبار-١`, or «—»); the pool section shows calls and spend (today, total) per key from `treg_pool_spend()`.

## 8. SQL: files, safety, and what was actually run

| File | What | Rollback |
|---|---|---|
| `00_verify_before_apply.sql` | read-only: new objects absent, extensions and Vault names present, `provider_costs.id` bigint, an admin exists; prints the current key store (provider, version, last 4) | n/a |
| `01_vault_encryption_key.sql` | one Vault secret, generated in the DB, idempotent | `01_..rollback.sql` |
| `02_treg_pool_tables.sql` | 5 new tables, 1 seeded row (`rollout_on = false`), RLS on, service-role-only grants | `02_..rollback.sql` |
| `03_treg_pool_functions.sql` | 23 new functions (section 2) | `03_..rollback.sql` |
| `04_treg_pool_cron.sql` | `treg_pool_tick()` + job `diger-treg-pool-tick` (every minute; returns before any HTTP call unless an e-mail is waiting or a health run is due; reuses the two existing Vault secrets) | `04_..rollback.sql` |
| `05_verify_after_apply.sql` | read-only: RLS, privileges of anon / authenticated / service_role on every object, switch OFF, empty pool, `treg_pool_runtime()` has no keys, Vault key length 44 (length only), cron job present, old key store unchanged | n/a |

**Additive proof.** Existing objects the files touch: none are altered or dropped. They only READ `auth.users` (admin role check), `vault.decrypted_secrets` (the two existing secrets and the new one), `provider_costs` (inside the read-only `treg_pool_spend`), and ADD a row to `vault.secrets` and a job to `cron.job`. No money table or function, no `provider_api_keys` change, no column added to any existing table. Applied before the code, nothing reads the new objects; with the pool empty the cron tick returns immediately, so today's platform is unchanged.

**What I ran (not on Supabase).** The files were applied to a throwaway local PostgreSQL 16 with Supabase stubs (roles, `auth.users`, `vault`, `cron`, `net`, `pgcrypto`), then removed: applied twice without error (idempotent); `05` output as expected (RLS 5/5; anon and authenticated no access to anything; `service_role` no access to `treg_pool_keys` and no INSERT anywhere); two behaviour scripts (17 groups and 8 groups of checks): non-admin refused, bad ciphertext refused, second main refused, main not removable, active key not removable, chain 2 → 3 → 4 → main with main last and not listable, two servers failing at once switch once and open one alert, a bad key is skipped, the chain reaches main with the `chain_reached_main` alert, a failing main opens `main_failed`, a transient check changes nothing, a non-active key turning bad opens one `health_broken` and its repeat none, the active key found broken answers `needs_failover` with no health alert, per-key spend join, one health run per interval, outbox leasing, ciphertext never in `treg_pool_overview()`, events append-only, anon/authenticated denied, tick makes 0 HTTP calls when nothing is due and 1 when due, numbers never reused, all four rollback files leave nothing behind. **Not run on Supabase**: Vault, pg_cron and pg_net were stubs.

## 9. Owner steps and the rollout checklist

**Secrets/config steps: none.** The encryption key is created inside the database by file 01. Optional: set `ADMIN_ALERT_EMAIL` on Heroku (Settings → Config Vars) only if you want the worker to e-mail directly when the database itself is unreachable; without it that single case is e-mailed as soon as the database is back.

Checklist (stop at any step; each step says how to go back):

1. **Review** this folder; answer the decisions in section 10.
2. **Apply SQL** (SQL editor, in order): `00` (all `must_be` equal `found`) → `01` → `02` → `03` → `04` → `05`. Expected: pool empty, switch OFF, `treg_pool_runtime()` keys `[]`, Vault key length 44, cron job present. The platform is unchanged. Tell me «SQL applied». Back: the four rollback files in reverse order (04, 03, 02, 01).
3. **Merge with the switch OFF** (STEP 2, merge commit). Expected: new section visible, switch OFF, empty table, everything behaves as before. Back: `git revert -m 1 <merge sha>`.
4. **Adopt the main key**: press «اعتماد المفتاح الحالي كمفتاح رئيسي». Expected: row #١ marked «الرئيسي / الافتراضي», status متصل, last 4 `Az7w`, balance shown; no mismatch warning for Heroku's `TREG_TOKEN`.
5. **Add one 1 USD test key** («اختبار-١»). It is checked live first and rejected unsaved if TREG refuses it. Expected: row #٢, balance about 1 USD. For the fallback test in step 8 add a SECOND test key («اختبار-٢») so the chain is 2 → 3 → main and the main credit is not touched.
6. **Switch ON** (the active key starts as main: nothing changes), then press «تفعيل» on #٢. Expected within about 3 seconds: «النشط الآن: رقم ٢». Back: switch OFF (seconds).
7. **Run one tiny mission** (for example ١٠ تغريدات). Expected: it completes; the calls log shows every TREG call with «#٢ · اختبار-١»; the main key's balance is unchanged; the test key's balance dropped by about the mission's provider cost.
8. **Revoke-test the fallback**: on TREG the owner revokes test key #٢, then runs another tiny mission (or presses «فحص الآن»). Expected: the first call after the revocation is answered by key #٣ (the call log shows #٢ failing at no cost, then #٣), the mission completes, the table shows #٢ «ملغى» and active #٣, and **one** Arabic e-mail «انتقلت المنصة إلى مفتاح TREG رقم ٣» arrives within about two minutes. Optional, spends a few cents of the main credit: revoke #٣ as well and confirm the move to the main key and the second e-mail.
9. **Decide**: keep ON; or switch OFF (instant, restores today); or roll the SQL back.

## 10. Decisions for the owner (defaults in bold; none blocks the SQL review)

- **D1**: store each key's TREG account e-mail in the database (**yes**, admin-only table, no grant to anyone but through functions). It breaks the earlier rule «the account e-mail is memory-only» (PR that added it); the table needs it to show the e-mail without 100 live reads on every page load. If «no», drop the `account_email` column from file 02 and the table shows the e-mail only after a live refresh.
- **D2**: 30 seconds of grace on the last good active key during a database blip (**30 s**; 0 = go to `TREG_TOKEN` at once).
- **D3**: the chain only moves forward, then main (**yes**); alternative: any healthy in-chain key before main (protects the main credit more, less predictable).
- **D4**: «الرصيد خلص» at or below **0.01 USD**, editable in the admin.
- **D5**: two extra e-mails beyond the three you listed, `main_failed` and `store_unreadable` (**yes**).
- **D6**: retry the failed call once on the next key (**yes**); the alternative is to only switch for the next call.
- **D7**: the 10-minute health check runs even while the switch is OFF (**yes**, free read-only calls; the table is useful before you turn it on).
- **D8**: pool size cap **500** keys (a SQL check; the health run checks up to 200 keys per run, oldest check first).

## 11. STEP 2 test plan (fake TREG, in-memory fake of the RPCs; no provider call)

Baseline test counts (files, tests, skipped = 57, `expect(` count) are taken at the start of STEP 2 on the exact base; the report gives before / after, the removed-lines output of `git diff -U0 origin/main -- tests | grep '^-'`, and every changed existing test with its old and new lines. No existing assertion is weakened.

- **Instant switch**: on the website resolver and on the worker gateway, one shared fake DB: change the active key, the next call (after the 3 s cache window, with a fake clock) carries the new key's header; a mission mid-way continues on the new key from its next call; generation bump; switch OFF returns legacy keys within the window.
- **OFF = today**: with pool rows present and the switch OFF, the website sends the store/env key and the worker sends `TREG_TOKEN`, byte for byte as today; pool SQL missing (function not found) = OFF with one log line.
- **Chain**: order 2 → 3 → 4 → main; main always last and unmovable; bad keys skipped; the chain ends at main; a failing main returns the failure and opens `main_failed`; hop cap 3.
- **Auth / balance move on, transient does not**: 401 and 403 are verified (a 403 with a healthy `/auth/me` switches nothing), 402 moves on; timeout, network error, 5xx, 429, 400, `route_max_cost` and an inconclusive verification never switch; two instances failing together switch once; the retry reuses the idempotency key; cost is counted once.
- **DB unreachable / Vault or decrypt failure**: the worker uses `TREG_TOKEN`, never a non-main key after the grace window, queues the alert and flushes it when the database returns.
- **E-mails**: debounce (1,000 failing calls → one row, one e-mail), 30-minute repeat refusal, cleared on recovery, retry on send failure, Arabic text, no key, no ciphertext, only number and label.
- **Key never leaves the server**: admin responses, `treg_pool_overview`, events, alerts, logs, errors and e-mails scanned for the fake key and its ciphertext; client components import no server module; the existing client-bundle secret scan stays green.
- **Call log**: every call records number and label (website and worker), the log filters by key and shows spend per key, legacy calls show «—», OFF writes no mark.
- **Admin API**: admin only (customers and anonymous refused), invalid keys rejected unsaved, remove rules, rollout needs a main key, rate limit, audit entries.
- **Crypto and contract**: AAD binds ciphertext to its row, wrong Vault key fails, ciphertext matches the SQL regex; a static test keeps the SQL function names and argument lists in step with the code (like `provider-keys-contract.test.ts`). No new skipped tests.

## 12. NOT PROVEN

- TREG's real answers: that a revoked key answers 401 or 403 and an exhausted one 402. This is read from `tregClient.ts` (`isPlatformBalanceLow`, `reportProviderHttpStatus`), not from a live call; the verification step makes 401/403 safe either way, but an exhausted key that answers some other status would not be moved off until the health check sees it. Step 8 of the checklist is the proof for revocation; letting a 1 USD key run dry is the proof for balance.
- That `/auth/me` returns an org id and an account e-mail for the keys of OTHER TREG accounts the same way it does for the main one, and that a retry with another token under the same `Idempotency-Key` is accepted.
- The SQL on Supabase itself (Vault, pg_cron and pg_net were stubs in the scratch run); calling `treg_pool_enc_key()` through PostgREST from Vercel and Heroku.
- Propagation time across real Vercel instances (designed: 3 s cache; not measured), and e-mail rendering in a mailbox.
- The worker's behaviour when the database is down for longer than the grace window (designed and to be tested with fakes; not seen live).
- Health runs with 100 or more keys (designed: concurrency 8, 200 keys per run; not measured).
- The admin screen in a browser (design above is a sketch).

Rollback of the whole feature after it is built: switch OFF (seconds), then `git revert -m 1 <merge sha>`, then the rollback SQL files in reverse order. The main key, `TREG_TOKEN` and the old key store are never touched by any of it.
