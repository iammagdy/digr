# Live acceptance workflow (14 Nov 2026)

**Status: built, refused in production by design.** The admin workflow exists. It refuses to turn on Intelligence switches or create paid scenario missions until the campaign's $0.30 ceiling can be **enforced** before every paid request. Today it cannot be (§3). The change that would make it enforceable needs separate owner approval (§6, P1). Nothing was activated and no paid call was made.

## 1. What blocked L1–L4

1. **Authentication.** Every admin route requires a signed-in Supabase user with `app_metadata.role = "admin"` (`src/lib/server/adminAuth.ts`). There is no service token. Claude Code has no such session and must not be given one (§6, P2).
2. **Flags.** The admin UI could set only `redesign_flags` and `social_discovery`. The six Intelligence keys needed SQL.
3. **Budget.** No existing control enforces a combined ceiling across model and provider calls (§3).
4. **Identifiers.** No email or phone number has been authorized for L1/L2.

## 2. Audit of the existing product (Task A)

| Area | What exists | Usable for acceptance? |
|---|---|---|
| Admin authentication | Supabase JWT plus `role=admin`; every admin route calls `authenticateAdmin`; audit rows in `admin_audit_log` | Yes. Unchanged |
| Test account | `AGENT_TEST_ACCOUNT_EMAIL` (`iam.magdy+1@outlook.com`, id `b0d08be8-…`); shared classifier `server/testAccounts.ts` (admin-only import) | Yes |
| Creating a mission | The admin agent console's `createMission`: the test account only, `queued`, planned by the worker | Yes. No customer impersonation: an existing, owner-designed console |
| Approval | `approvePlan`: refused unless the mission belongs to the test account; the shared `approveMissionOnce` (re-price by code, reserve from the test account's balance) | Yes. Unchanged; this workflow never approves |
| Flags | `agent_settings` (service role only); readers use `scopedFlagOn` (`true`, `"on"` or `{user_ids}`) | Yes, with the scoped form plus expiry (§4) |
| Spend | See §3 | Not as a hard ceiling |

## 3. Can a combined $0.30 ceiling be enforced today? (Task B): **No**

| Spend | Control on `main` | Hard maximum before the request? |
|---|---|---|
| Anthropic planning and execution | Agent SDK `maxBudgetUsd` and per-mission budgets (planning model budget $0.30 per mission) | **No.** Checked after a turn. The round-61 model gate exists but is not wired |
| TREG | Per call: route cap `X-Treg-Route-Max-Cost` (TREG refuses above it). Per job: in-memory call budget reserving the estimate. Per day: `reserve_provider_spend_atomic` | Per call yes; per job and per day only on estimates |
| Firecrawl / Context.dev | Daily cap per provider (`reserve_provider_spend_atomic`), reserving the estimate | **No.** Billed by reported credits after the call |
| Retries / concurrency | The daily cap is atomic across servers (advisory lock) | On estimates only; TREG key-pool hops are documented as unbilled, not prevented |
| Unknown / delayed charges | Counted at the estimate (job budget, gateways) | **No.** An estimate is not the maximum |
| Combined total | Nothing adds model and provider spend into one reserved total | **No** |

The daily provider caps are global and shared with every customer, so lowering them would stop customers too. They also do not cover the model.

In code this is `PRODUCTION_BUDGET_GUARANTEE = { enforceable: false, reasons: [model_calls_not_reserved, provider_caps_shared_and_estimated, no_aggregate_ledger] }` (`src/lib/agentMission/acceptance/campaign.ts`). It can only be changed in its own reviewed PR, after P1.

## 4. What was built (Task D)

**PR #492 (route and library):** `/api/admin/acceptance`, admin only, every attempt audited.

- **`start {keys, minutes}`**
  - Takes only the six Intelligence keys, only keys that are unset today, for 10–180 minutes.
  - Writes `{"user_ids":[<test account>],"expires_at":…}` per key, never `true` or `"on"`.
  - The account is the console's test account and must also be a test account by the shared classifier.
  - **Automatic off:** `scopedFlagOn` reads an expired value as OFF. Values without `expires_at` read as before.
  - **One campaign at a time:** the lock row is inserted, never upserted.
  - **Failures:** a start that fails partway undoes its own writes.
  - **Refused** unless the ceiling is enforceable.
- **`restore`**
  - Removes only what the campaign wrote; a value changed meanwhile is kept and reported.
  - Re-reads to verify, and removes the lock last. Running it again is a no-op. It is always allowed.
- **`create_scenario {L3|L4}`**
  - Goes through the existing console `createMission`.
  - L3 requires every Intelligence switch off; L4 requires a live, isolated campaign.
  - **Refused** unless the ceiling is enforceable.
- **`GET`:** state, isolation probe, guarantee and reasons, scenarios, and the test account's mission spend (add-on rows included and marked).

**PR-B (screen and this document):** an «حملة القبول الحي» panel in the agent console (`/admin/agent`).

- Shows the guarantee and why it is off, each switch's state and expiry, and isolation.
- Offers start and restore, and L3/L4 creation; disabled with the reason while the ceiling is not enforceable.
- L1/L2 link to the reverse-lookup screen; no identifier box exists here.
- Shows spend against $0.30, and downloads a JSON acceptance report (test account id only, no email).

**Not changed:** pricing, ledger, approval, reservation, settlement, schema, migrations, permissions and customer behaviour. Tests pin that no acceptance file calls `.rpc(`, `.upsert(`, `.update(`, an approval or a grant.

## 5. Guarantees (true now)

- **Authentication:** only an authenticated admin can reach any of it. Non-admins get 403, and nothing is read, written or audited.
- **Isolation:** a switch can only be scoped to the designated test account. A probe account sees nothing, and an "on for everyone" value is flagged and blocks L4.
- **Rollback:** expiry turns the switches off by itself. Restore is exact and verified, and it is idempotent.
- **Approval integrity:** missions go through the existing console; approval stays the existing quote path for the test account.
- **Spending:** no switch is turned on and no scenario mission is created while the hard ceiling is not enforceable.
- **Privacy:** the route accepts no identifier fields, and the screen has no identifier input.

## 6. Proposals for separate owner approval (none applied)

### P1: hard campaign ceiling, the only blocker for L3/L4

Use the designed spend gate (`docs/proposals/spend-gate/SPEC-v2.md`, PR #481):

1. Rebase PR #481 onto `main` (it conflicts with #489 in `runMission.ts`) and review it.
2. Apply `docs/proposals/spend-gate/sql/001_spend_gate.sql` and `002_verify.sql`. This is a migration, done by the owner.
3. Issue one grant with the owner role:
   - `ceiling_usd 0.30`, `per_mission_max_usd 0.10`, `per_op_max_usd 0.10`;
   - `kinds {provider, model}`, a window of a few hours.
4. Set `DIGER_SPEND_GATE=enforce` on the Heroku worker for that window only, then unset it.
5. A follow-up PR replaces `PRODUCTION_BUDGET_GUARANTEE` with a live check (an open grant ≤ $0.30, and the worker reporting `enforce`).

**What it covers.** Every paid request of an admin-console mission happens in the worker:
- planning and execution model requests through the model gate;
- TREG at its route cap;
- web calls at documented bounds.

The website makes no paid call for these missions: no chat, and approval re-prices by code.

**Limits to accept or fix first:**
- A grant is **global**: no account scope. In enforce mode every customer's paid worker call during the window draws on, or is refused by, the campaign grant. Either choose a quiet window (recent traffic: 125 provider calls in 7 days, all accounts) or extend the gate with a per-account or per-mission scope (a spec change).
- Context.dev pre-built parsers have no documented bound and are refused under enforce, so L3/L4 may deliver fewer public contacts.
- A **billed** TREG key-pool hop would be recorded as an overrun and trip the grant, but not prevented (#481 risk list).
- The website is not gated. That does not matter for console missions, but it does for any broader claim.

### P2: a machine credential for unattended campaigns (not recommended)

An admin service token would let a tool such as Claude Code run campaigns without a browser. That is a **new authorization semantic**: a non-human admin. It would need its own scope (acceptance actions only), rotation, an audit identity and revocation. The workflow above needs only a few clicks from a signed-in admin, so this is not proposed for now.

### P3: L1/L2 identifiers

The owner types their **own** work email and phone number on the reverse-lookup screen (its $2 cap and fail-closed audit apply). Nothing is stored by this workflow. Until then L1/L2 stay blocked, without blocking L3/L4.

## 7. Runbook once P1 is approved (no SQL, no code, no secrets)

1. Open `/admin/agent`, then the «حملة القبول الحي» panel. It should show the ceiling as enforced.
2. **L3:** «أنشئ مهمة L3». The mission appears in the list; approve its priced plan there (the existing quote path). Wait for delivery.
3. **L4:**
   - choose the four L4 switches and a duration;
   - «فعّل لحساب الاختبار»;
   - «أنشئ مهمة L4», then approve it;
   - after delivery, «أعِد المفاتيح كما كانت».
4. **L1/L2 (optional):** the reverse-lookup screen with your own identifiers.
5. «نزّل تقرير القبول». The audit log holds every step.

**Stop rules:**
- any spend above a scenario's ceiling;
- isolation not shown;
- a private mailbox delivered;
- a refusal you did not expect.
