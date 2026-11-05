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

Template variable names (`{{ .Name }}`, `{{ .SiteURL }}`) are illustrative: confirm them against `templateVariables()` in `supabase/functions/send-email/templates.ts` when the template is written.

**Call to action (single):** «افتح لوحتك» → `{{ .SiteURL }}/dashboard`.

## 3. How e-mail works in this repository (read from code, nothing executed)

| Piece | File | Fact |
|---|---|---|
| Sender helper | `src/lib/server/sendPlatformEmail.ts` | `sendPlatformEmail(template, to, vars, idempotencyKey?)` posts to `<SUPABASE_URL>/functions/v1/send-email` with the service role; never throws; failures are logged as fixed reason codes |
| Edge Function | `supabase/functions/send-email/` (`index.ts`, `authorize.ts`, `templates.ts`, `resendHeaders.ts`) | renders an Arabic template and calls **Resend**; sender fixed `Diger <noreply@diger.tech>`; passes `Idempotency-Key` to Resend |
| Templates today | `PlatformEmailTemplateId`: `welcome`, `topup-received/approved/rejected`, `job-done`, `refund`, `job-update`, `admin-topup-alert` | **there is no announcement/«news» template**: a send needs a new template added in BOTH copies (`src/functions/shared/emailTemplates.ts` and `supabase/functions/send-email/templates.ts`, HANDOFF notes both must change) and an Edge Function deploy (owner only) |
| Consent | `isEmailPreferenceEnabled` + `TEMPLATE_CATEGORY_MAP`; preferences in the user's auth metadata `prefs.notif`; UI `src/app/dashboard/settings/page.tsx` | categories `topup`, `done`, `refund` default **on**; **`news` («أخبار ونصائح بحثية») defaults to OFF** and sends only when the user turned it on |
| Unsubscribe | the same settings toggle | **there is no one-click unsubscribe link or `List-Unsubscribe` header** in the code (`resendHeaders.ts` sets only authorization, content type and idempotency key). The footer link points to the settings page |
| Deployed? | `docs/HANDOFF.md` (~line 1330): `send-email` was deployed as version 4; an older section says not deployed | **UNVERIFIED today** (run the admin check «فحص البريد الإلكتروني للعملاء» in `/admin/settings`, which is read-only apart from one self-addressed test e-mail the owner triggers) |

## 4. Intended audience and consent checks

- **Audience (proposed):** users with a verified e-mail who have `prefs.notif.news === true` (explicit opt-in). That is the repository's only marketing-style consent. Users who never touched the setting have `news` off and must **not** receive this e-mail.
- **Not eligible:** guests (`user_metadata.is_guest`), unverified addresses, test accounts (`src/lib/server/testAccounts.ts`) except the seed list, any address whose last send returned `resend_rejected`/bounce.
- **OWNER DECISION:** whether the launch announcement may be treated as a service notice to all verified customers (then `news` is ignored) — **not recommended**: it contradicts the default-off preference and there is no one-click unsubscribe. Default of this plan: opt-in only.
- Recipient count: **UNVERIFIED** (not readable without a production query; the owner or a read-only session counts users with `news = true` and a verified e-mail, no addresses exported).

## 5. Suppression and unsubscribe

1. Build the list at send time from auth metadata (`news === true`, verified, not guest, not test) — never from a stored list.
2. Suppress anyone whose preference changed after list-building: re-read the preference per recipient immediately before each send (`getRecipient(adminClient, userId, "news")` already returns null when disabled).
3. Keep a send-log of `userId` + idempotency key + result code only (no address, no body).
4. **Gap:** no one-click unsubscribe/`List-Unsubscribe` header exists. Before any bulk send the owner should decide to add it (code change in the Edge Function, deploy needed) or accept the settings-page link; recommended: add `List-Unsubscribe` in `resendHeaders.ts`.

## 6. Safe sending plan (through the EXISTING path; not executed)

1. Pre-requisites: §3 «Deployed?» verified; a `news` template added, reviewed and deployed (owner); the checklist features it names are READY.
2. **Stage 0 — render only:** unit-test the template rendering (no send); read the Arabic text twice for RTL and for unsupported promises.
3. **Stage 1 — seed list:** 3–5 owner-controlled test accounts (`iam.magdy+N@outlook.com`), real inbox check on mobile and desktop (links, RTL, subject).
4. **Stage 2 — 1% (at most 50 recipients)**, wait 24 h: watch bounces/`resend_rejected`, complaints, support replies.
5. **Stage 3 — batches of 500** with a pause between batches, only if Stage 2 is clean.
6. **Idempotency:** idempotency key `launch-2026-11:<userId>` for every send, so a retry or a re-run sends at most one e-mail per user (Resend honors `Idempotency-Key`; the key is already supported by `sendPlatformEmail`). Also record the key in the send-log and skip users already logged.
7. **Stop conditions** (stop the run, do not resume without the owner): any bounce rate above 2%; any spam complaint; two consecutive `resend_rejected`/`function_unavailable`; any wrong-content report; the Resend monthly limit within 20% of exhausted.
8. Never send from a script outside the existing helper; never include customer data beyond the display name.

## 7. Cost estimate and proposed limit

- Provider: **Resend**, sender domain `diger.tech` (from `supabase/functions/send-email` and `docs/proposals/10_email_delivery_setup.md`).
- The repository records the **limit** the owner works under: «50,000 e-mails per month» (`docs/REDESIGN.md`). The **price/plan** of the Resend account is **UNVERIFIED** (not in the repository; do not guess).
- Formula: `cost ≈ plan_monthly_price × (announcement_recipients / included_monthly_emails)` for the share of the monthly allowance the send consumes; if the account is on a plan with a fixed monthly fee, the marginal cost is 0 until the allowance is exceeded, and the risk is **starving transactional e-mails** (job-done, top-up).
- **Proposed cap:** announcement recipients ≤ **20% of the monthly allowance** (e.g. ≤ 10,000 if the allowance is 50,000) and never in the last week of the billing month; plus a hard stop if the month's usage passes 80%.
- Real recipient count and plan: owner to fill: recipients ______; plan/allowance ______; used this month ______.

## 8. Pre-send checklist

☐ Features named in the body are READY (checklist §10) and their flags are on for everyone  ☐ Sentences of disabled features deleted  ☐ `send-email` deployed and the admin check passed (owner)  ☐ `news` template reviewed in Arabic (both copies identical)  ☐ Seed sends received and rendered correctly on a phone  ☐ Audience = `news === true`, verified, not guest/test; recipient count recorded  ☐ Unsubscribe decision made (header or settings link)  ☐ Idempotency keys set; send-log ready  ☐ Cost cap and stop conditions agreed  ☐ Owner's explicit «send» for Stage 1, then Stage 2, then Stage 3  ☐ **No e-mail sent before all boxes above are ticked.**
