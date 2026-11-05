# Launch announcement e-mail (Arabic) — PREPARATION ONLY. **No e-mail has been sent. No e-mail API, Edge Function or paid service was called.**

> **Send gate:** every sentence below describes a capability. A sentence may be sent **only if that capability is READY in `LAUNCH-CHECKLIST.md` §10 on the day of sending** (flag on for everyone, journey passed). Sections marked ⟦…⟧ must be deleted if their feature is not live. Today most are UNVERIFIED/BLOCKED, so this e-mail is **not sendable yet**.

## 1. Subject lines (pick one)

1. «ديجر صار أوضح: شاهد نتائج بحثك وهي تتجمّع، وراجع ملفك وعدّله»
2. «جديد في ديجر: جدول حيّ لنتائجك، وتقرير مراجعة، وتعديل ملفك بعد التسليم»
3. «تابع بحثك لحظة بلحظة في ديجر»

(Subjects carry no price, no «مجانًا»، no number we cannot prove.)

## 2. Body

```
السلام عليكم {{ .Name }}،

أضفنا في ديجر ما يخلّي رحلة طلبك أوضح من أول سؤال لحد الملف الجاهز:

• جدول حيّ لنتائجك: وإنت منتظر، تشوف النتائج وهي تتجمّع في جدول واحد، وعدّاد واحد واضح «كذا من كذا» على الموبايل.   ⟦إذا كان DIGER_STAGE2_LIVE_SHEET مفعّلًا للجميع⟧
• بطاقة «فهمنا طلبك»: نعرض لك كيف فهمنا طلبك قبل ما نبدأ، وتقدر تعدّل عليه.   ⟦إذا كان DIGER_STAGE2_ASK_CARD مفعّلًا⟧
• أبحاث الشركات مع ترتيب الدور: تعرف مكان طلبك في الطابور بوضوح.   ⟦إذا كان DIGER_STAGE3_COMPANIES وDIGER_STAGE3_QUEUE مفعّلين⟧
• تقرير مراجعة لملفك بعد التسليم: يبيّن لك ما وجدناه في خاناته، والسعر يظهر لك قبل أي حجز، ولا يبدأ إلا بعد اعتمادك.   ⟦إذا كان DIGER_STAGE4_REVIEW وDIGER_STAGE4_APPROVAL مفعّلين⟧
• تعديلات مدعومة على ملفك (مثل إعادة تسمية عمود أو تصحيح خانات محددة): تُسعَّر قبل التنفيذ، وتنفَّذ بعد اعتمادك فقط، وتصلك نسخة جديدة وتبقى نسختك الأصلية كما هي. نعرض لك دائمًا ما يمكن تنفيذه فقط.   ⟦إذا كان DIGER_STAGE4_EDITS وDIGER_STAGE4_APPROVAL مفعّلين⟧
• تنزيل النتائج بصيغة إكسل أو CSV، مع ملف «المنهجية» بالعربية الذي يشرح كيف جمعنا بياناتك وحدود التسليم.

لا نحجز نقاطك إلا بعد أن تعتمد السعر الظاهر لك، ولا نخصم إلا ما سُلّم فعلًا.

جرّب الآن: افتح طلبك الأخير أو ابدأ طلبًا جديدًا من هنا:
{{ .SiteURL }}/dashboard

فريق ديجر

لو ما عايز تستقبل أخبارنا، تقدر توقفها من الإعدادات: {{ .SiteURL }}/dashboard/settings
```

Rules for the final text: no promise of speed, of completeness «كل نتائج المنصة»، of platforms not supported, or of any edit type that is not offered in the edit form; no price number unless the pricing page says it that day; no unverified statistic. The «لا نحجز… ولا نخصم إلا ما سُلّم فعلًا» sentence is true only if the Stage 4 charge path (release first, charge ≤ hold) passed the pilot of the checklist §6.

Template variable names are now fixed by the `news` template: `Name, Subject, Heading, Lead, Item1…Item6, ButtonLabel, UnsubscribeURL` (see §3); the words come from `src/lib/launch/announcement.ts`, which uses the sentences above (the greeting is «أهلًا {{ .Name }}،»).

**Call to action (single):** «افتح لوحتك» → `{{ .SiteURL }}/dashboard`.

## 3. How e-mail works in this repository, and what the launch code adds

> **STATUS: CODE ONLY. NOT SENT. NOT DEPLOYED. NOT ENABLED.** The code below exists on branch `launch/news-email-prep` (not merged until the owner says so). No e-mail was sent, no Edge Function was deployed, no environment variable was set, no migration was applied. Merging it changes nothing for customers: a real send is refused unless `LAUNCH_EMAIL_ENABLED` is exactly `on`.

| Piece | File | Fact |
|---|---|---|
| Sender helper | `src/lib/server/sendPlatformEmail.ts` | `sendPlatformEmail(template, to, vars, idempotencyKey?, opts?: { unsubscribeUrl? })` posts to `<SUPABASE_URL>/functions/v1/send-email` with the service role; never throws; failures are fixed reason codes. `opts.unsubscribeUrl` is forwarded in the body only when given (every other caller's body is byte-identical) |
| Edge Function | `supabase/functions/send-email/` | renders an Arabic template and calls **Resend**; sender fixed `Diger <noreply@diger.tech>`; passes `Idempotency-Key`. **New:** an optional `unsubscribeUrl` (https, string, ≤ 2048 chars, no header-breaking characters; else `400 invalid_unsubscribe_url`) adds `List-Unsubscribe: <url>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` to the Resend payload, for any template, and ONLY when provided |
| `news` template | `supabase/functions/send-email/templates.ts` (the app's `src/functions/shared/emailTemplates.ts` renders `news` through the same renderer, so the two cannot differ) | variables `Name, Subject, Heading, Lead, Item1…Item6, ButtonLabel, UnsubscribeURL`; greeting + lead + up to six paragraphs (empty ones dropped) + ONE button to `/dashboard`; footer carries the preferences link AND a visible «إلغاء الاشتراك من الأخبار» link. The footer of every other template is unchanged |
| Consent | `isEmailPreferenceEnabled` + `TEMPLATE_CATEGORY_MAP.news = "news"` | `news` defaults to **OFF** and sends only when `user_metadata.prefs.notif.news === true` |
| One-click unsubscribe | `src/lib/server/unsubscribeToken.ts`, `src/app/api/email/unsubscribe/route.ts` | token = HMAC-SHA256 over `unsubscribe:v1:<userId>` keyed by `UNSUBSCRIBE_HMAC_SECRET` when that variable is set to **at least 32 characters** (a shorter value is ignored), else by `SUPABASE_SERVICE_ROLE_KEY` (so no new variable is required); verification accepts BOTH, so links already mailed survive the introduction of the dedicated secret. **If the service-role key is ever rotated, first set `UNSUBSCRIBE_HMAC_SECRET` to the OLD key value**, otherwise every link already mailed stops working. Carries the user id, constant-time check over every accepted key. **POST** sets `prefs.notif.news = false` (merging the rest of the metadata), idempotent, 200 JSON; a bad token or a deleted account gets the same generic 400; **any other failure of the sign-in service is a retryable 503** (an Arabic retry page when the button of the confirmation page was pressed), never "invalid link". **GET** only shows an Arabic confirmation page with a POST form (a GET never unsubscribes: mail scanners prefetch links). Rate-limited (300 POST/min per address) |
| Announcement words | `src/lib/launch/announcement.ts` | `composeLaunchAnnouncement(env, name?)`: the approved sentences of §2, a feature included ONLY when its flag is exactly «on» (Stage 2 LIVE_SHEET / ASK_CARD, Stage 3 COMPANIES+QUEUE, Stage 4 REVIEW+APPROVAL, EDITS+APPROVAL; `allowlist`/`test`/unset = not announced). Returns `null` when no flag-gated feature qualifies (the download sentence alone never justifies a send). The money sentence only with a Stage 4 sentence. At most six paragraphs: if all five features are on, the download sentence is dropped to make room for the money sentence. The subject names only what is live (long approved subject needs live sheet + review + edits; the live-sheet subject needs the live sheet; otherwise the generic «جديد في ديجر: رحلة طلبك صارت أوضح», which is new wording the owner must approve) |
| Audience + runner | `src/lib/launch/newsCampaign.ts` (+ `newsCampaignWiring.ts`) | see §4-§6 |
| Admin route | `src/app/api/admin/launch-email/route.ts` | POST, admin only; body `{campaign, cap, dryRun?, confirm?, excludeUserIds?, onlyUserIds?, suppressedEmails?}`; **double lock** for a real send (see §6) |
| Deployed? | `docs/HANDOFF.md`; `PRODUCTION-GATES-2026-11-05.md` §7 records `send-email` ACTIVE version 5 | **the deployed version has NO `news` template and ignores `unsubscribeUrl`**: the owner must deploy the Edge Function from this branch before any send |

## 4. Audience and consent checks (implemented in `isEligibleForNews`)

- **Eligible = ALL of:** not a guest (`user_metadata.is_guest === true`, or an address shaped `guest_<32 hex>@diger.tech`); `email_confirmed_at` set by the sign-in service (**never** `user_metadata.email_verified`, which a customer can write); a well-formed address; `user_metadata.prefs.notif.news === true` **exactly** (undefined, false, `"true"`, 1 are all refused); not a test account (the shared rule of `src/lib/server/testAccounts.ts`, plus an optional `excludeUserIds`); address not in the optional `suppressedEmails` list the owner pastes (e.g. addresses Resend suppressed).
- **Registered accounts are not opt-ins. Resend contacts are not consent** (81 contacts, consent unverifiable): they are never read or used.
- **OWNER DECISION still open:** treating the announcement as a service notice to all verified customers is **not recommended** and is not what the code does. Default and only implemented mode: opt-in only.
- **Recipient count today: ZERO** (production gates §7: 0 accounts with `news = true`). A dry run through the admin route returns the genuine number at any time.

## 5. Suppression, unsubscribe and duplicates (implemented)

1. The list is built at send time from the auth users (paged 200 at a time), never from a stored list.
2. **Re-check per recipient:** the user is re-read immediately before each send and eligibility is checked again; a preference switched off after the listing is skipped.
3. **Already-mailed mark:** `app_metadata.campaigns["launch-2026-11"]` (service-owned; a customer cannot write `app_metadata`). The mark is **claimed BEFORE the send** (a crash loses one e-mail, never sends one twice); a definite failure (a Resend 4xx other than 409, `invalid_request`, …) removes the claim; an ambiguous one (`timeout`, `network_error`, `function_unavailable`, `resend_unreachable`, and a Resend 5xx or 409, which the sender reports as `resend_unreachable`) keeps it, so a later run can never mail that person again, and the person is listed in the result's `ambiguousUserIds` (the owner decides case by case; the server log line `[launch-email:failed]` carries the user id and the key). Writes merge `app_metadata` (the admin `role` is preserved). The claim itself is not atomic, so **a real run takes a single-run lock** (see §6): two real runs can never overlap.
4. **Idempotency key** `launch-2026-11:<userId>` on every send (Resend honors it).
5. **Logs and results** hold counts, user ids, idempotency keys and fixed reason codes only: never an address or a body.
6. **One-click unsubscribe** is in every mail (the footer link renders the same per-recipient URL as the header: the app sends it as `UnsubscribeURL` AND the Edge Function injects it from `unsubscribeUrl` when absent, so either deployment order works): the footer link and the `List-Unsubscribe` / `List-Unsubscribe-Post` headers point to `/api/email/unsubscribe?t=<signed token>`.

## 6. Safe sending plan (code ready; NOT executed)

**Runner rules (`runNewsCampaign`):** `dryRun` defaults to **true** (counts only, touches nothing); a real send needs `dryRun === false` AND `confirm === "SEND <campaign> <cap>"` exactly; hard cap `LAUNCH_HARD_CAP = 500` per run and never above the requested cap (`planBatches(n, 500)` plans the batches); the whole run stops after **2 consecutive failures**, and at the first `unauthorized` or `resend_not_configured`. **Ambiguous failures** (`timeout`, `network_error`, `function_unavailable`, `resend_unreachable`: the mail may have gone out) keep their claim and **count toward the cap**, so a run never exceeds it. A **wall-clock budget** (45 s by default, injectable clock) ends a real run cleanly with `stopped: "time_budget"` before the route's `maxDuration = 60`: claims already made stay and the counts are returned. **A large audience is therefore sent in repeated calls** (each call stops at its cap or its time budget; the claim marks make every re-run safe: nobody is mailed twice). **Two real runs cannot overlap**: the route takes a single-run lock (one row of the existing `agent_settings` table, key `launch_email_lock:<campaign>`, one atomic insert; a crashed run's row expires after 150 s and is taken over by one atomic conditional update; no migration) and answers **409** to a second real request. A dry run and a request the runner refuses (wrong confirm text) never touch the lock. The lock uses the calling server's clock: hosts must be time-synchronised (the default on Vercel). Accounts barred by the sign-in service (`banned_until` in the future) are never mailed.

**Admin route lock (`POST /api/admin/launch-email`):** a real send is refused with 403 unless the server env var **`LAUNCH_EMAIL_ENABLED` is exactly `on`** (unset = off; case and spaces matter) **and** the confirm text matches. A dry run is always allowed. The audit log records kind/label/target with counts only.

**What still needs the OWNER (nothing below has been done):**

1. Review and merge `launch/news-email-prep`; **deploy the `send-email` Edge Function** from it (CLI/dashboard, owner only), then run the existing read-only admin check «فحص البريد الإلكتروني للعملاء».
2. Features named in the text must be READY (checklist §10) with their flags «on» for everyone; otherwise `composeLaunchAnnouncement` returns `null` and a real send is refused («nothing_to_announce»). Today none is READY.
3. Approve the **recipient cap and the budget** (§7); fill the three blanks there. Optional but recommended before the first send: set `UNSUBSCRIBE_HMAC_SECRET` on Vercel production to a random value of at least 32 characters (it then signs every new link; nothing else reads it).
4. **Dry run** through the route (`{"campaign":"launch-2026-11","cap":50}`): record the eligible count (expected 0 until customers opt in).
5. **Bounded test send to 3-5 owner accounts first**: the owner switches «أخبار ونصائح بحثية» on in those accounts (`iam.magdy+N@outlook.com`; they must be service-confirmed), then calls the route with a separate campaign name and `onlyUserIds` (1 to 5 ids), e.g. `{"campaign":"launch-2026-11-seed","cap":5,"dryRun":false,"confirm":"SEND launch-2026-11-seed 5","onlyUserIds":[...]}` (needs the lock open, see 6). `onlyUserIds` restricts the audience to those ids and lifts the test-account exclusion for them; every other check still applies. Real inbox check on mobile and desktop: RTL, links, subject, the visible unsubscribe link and the one-click header (use the mail client's «Unsubscribe» button once and confirm `news` turned off).
6. Only then set `LAUNCH_EMAIL_ENABLED=on` on Vercel production, run with `cap` ≤ the approved number (Stage 2 of the original plan: at most 50, wait 24 h; then batches of 500 with a pause).
7. **Stop conditions** (stop, do not resume without the owner): bounce rate above 2%; any spam complaint; two consecutive `resend_rejected` / `function_unavailable` (the runner itself stops at two consecutive failures); any wrong-content report; the Resend monthly limit within 20% of exhausted.
8. **Rollback:** set `LAUNCH_EMAIL_ENABLED` to anything other than `on` (the route then refuses every real send at once; a run already in progress ends at its cap, at most 500), and customers can leave through the unsubscribe link / the settings toggle. A claimed mark is never removed by a rollback (so nobody is mailed twice).
9. Never send from a script outside the existing helper; never include customer data beyond the display name.

## 7. Cost estimate and proposed limit

- Provider: **Resend**, sender domain `diger.tech` (from `supabase/functions/send-email` and `docs/proposals/10_email_delivery_setup.md`).
- The repository records the **limit** the owner works under: «50,000 e-mails per month» (`docs/REDESIGN.md`). The **price/plan** of the Resend account is **UNVERIFIED** (not in the repository; do not guess).
- Formula: `cost ≈ plan_monthly_price × (announcement_recipients / included_monthly_emails)` for the share of the monthly allowance the send consumes; if the account is on a plan with a fixed monthly fee, the marginal cost is 0 until the allowance is exceeded, and the risk is **starving transactional e-mails** (job-done, top-up).
- **Proposed cap:** announcement recipients ≤ **20% of the monthly allowance** (e.g. ≤ 10,000 if the allowance is 50,000) and never in the last week of the billing month; plus a hard stop if the month's usage passes 80%.
- Real recipient count and plan: owner to fill: recipients ______; plan/allowance ______; used this month ______.

## 8. Pre-send checklist

☐ Features named in the body are READY (checklist §10) and their flags are on for everyone  ☐ Sentences of disabled features deleted  ☐ `send-email` deployed and the admin check passed (owner)  ☐ `news` template reviewed in Arabic (both copies identical)  ☐ Seed sends received and rendered correctly on a phone  ☐ Audience = `news === true`, verified, not guest/test; recipient count recorded  ☐ Unsubscribe decision made (header or settings link)  ☐ Idempotency keys set; send-log ready  ☐ Cost cap and stop conditions agreed  ☐ Owner's explicit «send» for Stage 1, then Stage 2, then Stage 3  ☐ **No e-mail sent before all boxes above are ticked.**

## 9. Residual risks the code cannot remove (read before authorizing)

1. **Forged opt-in at sign-up.** The opt-in lives in `user_metadata.prefs.notif.news`, which an account's own sign-up can set. Someone could register a third party's address with `news = true`; if that person then clicks Supabase's confirmation mail, the account is service-confirmed and looks like a consenting recipient. Production requires confirmation (3 accounts are unconfirmed and have never signed in, so auto-confirm is off), which stops mailing an address nobody confirmed, but it does not prove the confirming person chose to subscribe. Today the effect is nil (**0** opted-in accounts). **Before any send beyond the owner's own seed accounts**, either send a one-time double-opt-in confirmation (a signed link, same token mechanism) or review the dry-run list by hand.
2. **Suppression is owner-supplied.** The runner skips addresses in the `suppressedEmails` list the owner pastes; it does not read Resend's suppression list by itself. Export Resend's suppressions (bounces, complaints) and pass them on every real run. Customers who unsubscribe are handled automatically (`news = false`).
3. **Settings page.** The preference toggle now merges into the live server-side preferences (a stale tab can no longer undo an unsubscribe). A person can still re-subscribe on purpose, which is consent.
4. **Per-instance rate limit** on the unsubscribe POST (300 per minute per address): many one-click POSTs from one mailbox-provider address could be answered 429 and retried by the provider.
5. **A lost response** never double-sends: the claim is written before the send, and the idempotency key `launch-2026-11:<userId>` protects a retry only for Resend's idempotency window (about 24 h); after that, only the claim protects, which is why an ambiguous delivery is never unclaimed.

## 10. Exact authorization request for the campaign (the owner sends this text; nothing earlier than all of it permits a send)

> **AUTHORIZE LAUNCH E-MAIL, stage 1 (seed):**
> (1) merge PR #425 and deploy the `send-email` Edge Function from `main` (owner step; then run «فحص البريد الإلكتروني للعملاء»);
> (2) seed accounts: `<up to 5 user ids the owner controls>`, each with «أخبار ونصائح بحثية» switched on and a confirmed address;
> (3) set `LAUNCH_EMAIL_ENABLED=on` on Vercel production for the seed run only, then unset it;
> (4) run `{"campaign":"launch-2026-11-seed","cap":5,"dryRun":false,"confirm":"SEND launch-2026-11-seed 5","onlyUserIds":[...]}`;
> (5) maximum recipients: **5**; stop on any failure; report the result and the phone/desktop inbox check.
>
> **Stage 2 (genuine audience) needs its own message** after the seed result, with: the dry-run eligible count (**0 today**), the double-opt-in decision of §9.1, the Resend suppression export of §9.2, the cap (at most 50 first), and the cost ceiling of §7.

