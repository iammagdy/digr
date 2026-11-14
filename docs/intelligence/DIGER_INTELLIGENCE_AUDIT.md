> **HISTORICAL DOCUMENT (status as of 11 Nov 2026).** Its implementation statuses are no longer current: Phases 0–5 and 5.3-A were built after it (code complete, offline verified, NOT enabled), Phase 5.3-B is stopped for owner approval, and Phase 6 is covered in `PHASE-5-3-AND-6.md`. Read `docs/HANDOFF.md` «CURRENT STATE», `PHASES-2-4-ACCEPTANCE.md`, `PHASE-5-CONTACTS-AND-REVERSE-LOOKUP.md` and `PHASE-5-3-AND-6.md` for what is true now. «Code complete» never means «enabled in production».

Read-only audit11 Nov 2026iammagdy/digr · main 001cbeb

# Diger Intelligence Audit

How a customer's Arabic request becomes a plan today, why worded-differently requests get dropped or refused, the real status of TREG, Firecrawl and Context.dev, and a PR-by-PR blueprint for a cheaper coding model. Nothing was implemented.

Evidence labels V-CODE · V-DB · V-DEPLOY · V-DOC-EXT REPORTED INFERRED UNKNOWN

Chapters

1. [·Chapter 1: Executive Summary (بالمصري)](#ch-1)
2. [·CHAPTER 2: CURRENT SYSTEM ARCHITECTURE (verified)](#ch-2)
3. [·Chapter 3: Llm Understanding Audit](#ch-3)
4. [·Chapter 4: Provider Integration Audit](#ch-4)
5. [·Chapter 5: Provider Capability Matrix](#ch-5)
6. [·CHAPTER 6: ROOT-CAUSE ANALYSIS: why Diger relies mainly on TREG, and what blocks real multi-provider research](#ch-6)
7. [7Continuous Provider Intelligence](#ch-7)
8. [8Intelligent Tool Routing](#ch-8)
9. [9Multi-Provider Execution](#ch-9)
10. [10Production Preservation](#ch-10)
11. [11Evaluation And Benchmarks](#ch-11)
12. [12Security And Financial Safeguards](#ch-12)
13. [13Performance And Reliability](#ch-13)
14. [14Prioritized Implementation Roadmap](#ch-14)
15. [15Dependencies And Decisions](#ch-15)
16. [16Implementation Handoff](#ch-16)
17. [17Final Architectural Recommendation](#ch-17)
18. [·Final Answers](#final-answers)

**Date:** 2026-11-11 · **Repository:** `iammagdy/digr` · **Audited commit:** `main` = `001cbeb` (merge of #445) **Mode:** READ-ONLY research. No source file, branch, commit, PR, flag, credential, deployment, database write or paid provider call was made. This report lives outside the repository (session scratchpad).

### Evidence labels used throughout

| Label | Meaning |
| --- | --- |
| **V-CODE** | Verified by reading the current code (file:line given) |
| **V-DB** | Verified by a read-only `SELECT` on production Supabase during this session (queries listed in Appendix A) |
| **V-DEPLOY** | Verified from Vercel deployment metadata (read-only) |
| **V-DOC-EXT** | Verified in the provider's official public documentation (URL given) |
| **V-TEST** | Verified by existing test definitions / fixtures (tests were **not run**) |
| **REPORTED** | Stated in a repository document or PR, not independently re-verified |
| **INFERRED** | Reasoned from verified facts; not directly observed |
| **UNKNOWN** | Could not be determined with the access available |

**Verification gaps (apply to the whole report):**

- **Heroku:** no access. The worker heartbeat reports `version: dev`, so its deployed commit is **UNKNOWN**. Its environment variables are also **UNKNOWN**.
- **Vercel:** environment variable values were not read (by design).
- **Supabase Storage:** delivered files and raw pages were not read.
- **Tests:** none were executed. Code behaviour on example sentences was derived by **reading** the regexes, not by running them.

---

## CHAPTER 1: EXECUTIVE SUMMARY (بالمصري)

**إيه اللي شغّال فعلًا ومُثبت؟**

- المنصة شغالة من أولها لآخرها: محادثة، ثم خطة، ثم سعر بالنقاط محسوب بالكود، ثم موافقة العميل، ثم تنفيذ على Heroku، ثم ملف Excel، ثم تسوية مالية.
- في الإنتاج اتسجلت 239 مهمة، منها 166 اكتملت. آخر مهمة مكتملة كانت يوم 8 نوفمبر، على تيك توك وإكس وإنستجرام وفيسبوك ويوتيوب.
- النظام المالي متين: دفتر حسابات لا يُعدَّل، أرقام معاملات ثابتة، الإرجاع قبل الخصم، والذكاء الاصطناعي ممنوع يكتب فلوس.
- نسخة Vercel الحالية مطابقة لآخر دمج (`001cbeb`).

**إيه اللي مش مُثبت؟**

- نسخة الكود اللي شغالة على Heroku غير معروفة، لأن الـ worker بيقول `dev`.
- 235 من الـ 239 مهمة جت من حساب واحد، والأغلب إنه حساب الاختبار. يعني مفيش دليل حقيقي كفاية على سلوك العملاء الفعليين.

**ليه الطلب الصح بيترفض أو بيتفهم غلط؟**

- السبب الأساسي مش ضعف الموديل. الموديل (Haiku) بيقرر نوع الرسالة بس: «طلب بيانات» ولا «سلام».
- كل المعنى، يعني المنصة والتعليقات والموضوع والدولة والفترة، بيتقرا بـ regex حرفي على النص الخام. والفهم بتاع الموديل بيترمي.
- أمثلة متأكد منها من الكود:
  - كلمة «كومنتات» أو «comments» مش بتتفهم إنها تعليقات. الخطة بتطلع فيديوهات من غير تعليقات، ومن غير ما حد ينبّه.
  - «تك توك» بمسافة غلط مش بتتعرف كمنصة.
  - «فمصر» و«اخر ٣ شهور» من غير مدّة بيضيعوا بصمت.
  - رسالة فيها «من انت…» زي «من انتخابات» بتتحوّل لمسار قديم ومش بيتعمل لها مهمة.
- كمان الملف اللي العميل بيرفعه للاستبعاد بيتقال له إنه اتقبل، لكن الوكيل عمره ما بيقراه.

**ليه الاعتماد كله على TREG؟**

- قرار المالك المكتوب: «TREG only for now». المسار الحالي للسوشيال مبني على أدوات TREG بس.
- Firecrawl وContext.dev متبرمجين كاملين، لكن كل الـ 71 محاولة في الإنتاج اترفضت بـ `source_unavailable`، لأن الـ worker على Heroku مش قادر يجيب المفتاح. آخر محاولة كانت يوم 30 أكتوبر.
- المفاجأة: TREG نفسه بيبيع خدمات Firecrawl وContext.dev (باسمها القديم Brand.dev) جوه الكتالوج بتاعه، وبنفس المفتاح. يعني أسهل طريق مفتوح أصلًا.

**الاتجاه المقترح**

- منبنيش من الأول، ومنضيفش framework جديد.
- نضيف طبقة «فهم المعنى»: الموديل يطلّع سجل منظّم للطلب، والكود يقارنه بالـ regex. الموديل يقدر **يضيف** متطلبات، لكن عمره ما يشيل متطلب أو يحوّل طلب ممنوع لطلب مسموح.
- نوحّد قاموس الكلمات العربية والتطبيع.
- نوسّع سجل الأدوات الموثّقة الموجود (tool cards) لسجل محايد يشمل الثلاث مزودين، بحالة تحقق لكل أداة.
- نخلّي محرك التنفيذ يوزّع كل مرحلة على المزود المناسب.
- كل ده وراء مفاتيح تشغيل مقفولة، ونجربه بإعادة تشغيل المهام المحفوظة قبل أي عميل.

---

## CHAPTER 2: CURRENT SYSTEM ARCHITECTURE (verified)

### 2.1 Deployed topology

| Component | Evidence | Status |
| --- | --- | --- |
| Next.js 15 site + API on Vercel, project `diger` | V-DEPLOY latest production deployment `dpl_Du9LF5…` built `001cbeb` = `main` HEAD, state READY | Verified |
| Heroku worker `agent/src/main.ts` (Procfile `--max-old-space-size=192`) | V-DB `agent_worker_heartbeat` latest beat 2026-11-11 07:59 UTC, `model claude-haiku-5-5/claude-haiku-5-5`, `version dev`, rss 221 MB, 0 active missions | Running; **commit UNKNOWN** |
| Supabase (Postgres, Auth, Storage) | V-DB 52 public tables, RLS on all | Verified |
| LLM | V-DB `settings_private.providers` = `LLM_PROVIDER anthropic`, `ANTHROPIC_MODEL claude-haiku-5-5`; worker heartbeat model = Haiku | Verified |
| TREG | V-DB `provider_api_keys.treg` v5 active; 5 `treg_pool_keys` | Verified |
| Firecrawl / Context.dev direct | V-DB `provider_api_keys` rows `firecrawl` v1 and `contextdev` v1 set 2026-10-23; `provider_limits` = `firecrawlDailyUsd 1, contextdevDailyUsd 1` | Keys stored; **unusable by the worker** (Chapter 4) |
| Resend e-mail | V-CODE `src/lib/server/sendPlatformEmail.ts:169-188` calls Supabase function `send-email` | Code verified; delivery not checked |
| CI | V-CODE no `.github/` directory | **No GitHub Actions**. Checks are run by agents locally, plus Vercel preview builds |

### 2.2 Live production flags (read-only, 2026-11-11)

| Key | Value | Effect |
| --- | --- | --- |
| `agent_settings.redesign_flags` | `x, tiktok, youtube, facebook, instagram: "on"`; `people, places, companies, social_posts, social_account, social_comments: "test"` | All five social platforms take the **compiled** path for every account V-DB |
| `agent_settings.social_discovery` | `"test"` | Catalog-derived tools only for test accounts V-DB |
| `settings_private.pricing` | markup 10, usdToEgp 55, jobMaxPointsCap 25,000, providerDailySpendCapUsd 0.80, llmDailySpendCapUsd 50 | V-DB |
| `settings_private.provider_limits` | dailyUsd 10, firecrawlDailyUsd 1, contextdevDailyUsd 1 | V-DB Note: the TREG `dailyUsd 10` here and the `providerDailySpendCapUsd 0.80` in pricing disagree. Which one the code resolves is per `providerLimits.ts` (not re-traced) |
| Env flags (`DIGER_STAGE3_COMPANIES`, `MULTI_PROVIDER_ENABLED`, `PROVIDER_KEYS_ENCRYPTION_KEY` on Heroku) | — | **UNKNOWN** (env not readable) |

### 2.3 End-to-end pipeline (as the code runs today)

```
CUSTOMER message
  │
  ▼  POST /api/chat (src/app/api/chat/route.ts) ── length, placeholder [..] check (W1), auth, rate, file parse
  ▼  ChatHandler.handleUserMessageInner (src/functions/shared/chatHandler.ts)
  │     ├─ isGreetingOrGeneralQuestion (briefManager.ts:35-49)  ← UNANCHORED regex (W2) ─► legacy hand-coded path
  │     ├─ identityQuestionKind (assistantIdentity.ts)          ← vendor-word regex (W3)
  │     └─ agent gate (chatHandler.ts:2712) AGENT_SERVES_CHAT=true
  ▼  agentChatTurn (src/lib/agentMission/chatTurn.ts:150-200)
  │     ├─ preModelAnswer: privacy / account / trust regex guards (guardRules.ts)
  │     ├─ decideTurn: LLM (Haiku, 400 tok) returns ONLY {type, reply, count}   ← the model's understanding stops here
  │     │      keyword classifier may override toward data_request
  │     └─ data_request → cancel previous unapproved mission → createCustomerMission(request_text = this message)
  ▼  missions row (status queued)  ──────────────────────────────►  HEROKU worker claims (agent_claim_mission)
                                                                     runPlanning (agent/src/runMission.ts:306+)
                                                                       ├─ platform = buildRequestContract(raw text) REGEX
                                                                       ├─ social & flag on  → COMPILED PATH (code only)
                                                                       │     buildAsk (regex) → count/account/channel cards
                                                                       │     → hand ToolCards (+ discovery for test) → pool read via treg_call
                                                                       │     → compilePlan → priceMissionByCode
                                                                       ├─ no platform → legacyRouteOf (regex):
                                                                       │     companies/places words → LEGACY MODEL PLANNER (Haiku SDK agent)
                                                                       │        tools: catalog_search, treg_call, (web tools only if key) , propose_plan
                                                                       │        any social endpoint in a model plan → request ENDED unsupported (tools.ts:584-589)
                                                                       │     social-looking → «من أنهي منصة؟» card ; else clarify card ; 2nd unclear → unserved
                                                                       └─ plan_ready (plan, plan_public, price)
CUSTOMER approves (POST /api/missions/[id] approve)
  ▼  approveMissionOnce → repriceStoredPlan (must equal) → create_quote_atomic → accept_quote_atomic
       (1 item "agent-mission", reserve res_<job>) → claim_job_chunk (lease 6 h, never renewed)
  ▼  HEROKU runExecution: JobCallBudget = 40% of reserve value
       engineOn (every stage has a TREG recipe) → deterministic engine (gateway.tregCall only)
       else → LLM execution with tools (treg_call, web tools)
       every call: budget → provider daily cap reserve → call → commit → raw page → mission_calls row
  ▼  settleExecution: ItemStore → buildMissionFiles (xlsx/csv) → publish → read-back count
       delivered = min(file rows, plan.price.deliveredRows) → complete_chunk → settle_job_atomic
       (rel_ first, then chg_ = min(ceil(delivered×unit), reserve, cap))
  ▼  sendMissionNotice → in-app notification + Resend e-mail (completed/partial/unserved/failed)
```

Sources: execution and money audit V-CODE, verified spot-checks below.

### 2.4 Who decides what

| Decision | LLM | Deterministic code |
| --- | --- | --- |
| Message type (data request vs greeting/question/edit) | ✅ Haiku (`conversationModel.ts:258-278`) | keyword override toward data_request; regex pre-filters run **before** the model |
| Platform, parent kind, comments, replies, topic, country, period, language, count, source | ❌ never | ✅ regex (`requestContract.ts`, `requestConditions.ts`, `foundation/ask.ts`) |
| Clarification questions (platform, count, account, channel, topic meaning, occurrence) | ❌ | ✅ code-triggered cards |
| Social tool choice | Haiku picks only among already-validated candidates (discovery, test accounts) | ✅ ranked hand cards |
| Companies/places plan | ✅ Haiku SDK agent composes the plan | validator `validateAndPricePlan` sends issues back |
| Price, reserve, charge, refund | ❌ | ✅ code + SQL functions (service_role only) |
| Row relevance review | ✅ Haiku for uncertain rows (budgeted) | rules first |

### 2.5 Production activity baseline (read-only)

V-DB `missions` by status: completed 166 · cancelled 30 · unserved 25 · failed 17 · plan_ready 1 (2026-10-28 → 2026-11-09). **Distribution:** one account (hash `3ab7…`) created 235 of 239 missions. Two other accounts created 2 each.

V-DB `mission_calls` (2,852 rows), by provider prefix. "OK" means the HTTP call succeeded; it does not mean usable rows.

| Provider prefix | Phase | Calls | OK | Cost USD |
| --- | --- | --- | --- | --- |
| anyapi | execution | 1,183 | 1,166 | 0.80 |
| anyapi | planning | 185 | 148 | 0.35 |
| aviato | execution | 154 | 95 | 0.53 |
| crawl4ai | planning | 140 | 83 | 0.06 |
| tikhub | execution | 139 | 137 | 0.14 |
| tikhub | planning | 134 | 110 | 0.14 |
| scrapecreators | execution | 110 | 98 | 0.19 |
| crawl4ai | execution | 109 | 99 | 0.06 |
| blitzapi | execution | 106 | 64 | 0.07 |
| tomba | execution | 85 | 83 | 0.27 |
| justoneapi | planning | 51 | 42 | **1.21** (≈ $0.024/call) |
| **contextdev** | planning + execution | **47** | **0** | 0 |
| **firecrawl** | planning | **24** | **0** | 0 |
| treg (routed `treg.*`) | both | 21 | 19 | 0.04 |

---

## CHAPTER 3: LLM UNDERSTANDING AUDIT

### 3.1 Models and configuration

| Role | File | Model | Limits | Notes |
| --- | --- | --- | --- | --- |
| Chat type classifier + reply (web) | `src/lib/agentMission/chatModel.ts:9-11,40-45` | `ANTHROPIC_MODEL ‖ LLM_MODEL ‖ claude-haiku-5-5` | max_tokens 400, timeout 12 s, thinking disabled | Returns `{type, reason, reply, count}` only V-CODE |
| Planning, legacy model path (companies/places) | `agent/src/modelConfig.ts:9-12`; `agentMission/constants.ts:48-56` | `planning_model` setting ∈ {Haiku, Sonnet}; default Haiku | 60 turns, 20 min, SDK budget 0.30 USD | Live: Haiku V-DB missions.planning_model |
| Row review / names / YouTube understand step / discovery selector | `agent/src/review.ts`, `namesAr.ts`, `runMission.ts:431,493` | Haiku (hard-coded) | small | V-CODE |
| Legacy web planner | `src/lib/modelPlanner/*` | Haiku | — | Dead while `AGENT_SERVES_CHAT=true` V-CODE |

**Hazard V-CODE + INFERRED.** `chatModel.ts:40` falls back to `LLM_MODEL`. If an operator sets `LLM_PROVIDER=openai` and `LLM_MODEL=gpt-…` without `ANTHROPIC_MODEL`, every chat call fails. The system then silently uses the keyword classifier only.

**Observation V-DB.** Since 2026-10-28 the `llm_usage` rows for chat turns are recorded as `model=deterministic, reason=agent_mission, cost 0`. So the chat model's real spend is **not visible** in `llm_usage`, and whether the chat model call succeeds in production is **UNKNOWN**.

### 3.2 Where meaning is decided

The single most important finding of the audit:

\> The LLM sees the customer's words but is asked only for the message **type**. Everything that defines the research (platform, what to collect, topic, country, period, language, quantities) is extracted by **raw-text regular expressions**. These feed a code compiler that has **no model fallback**. Its only questions are for platform, count, account/channel, topic-meaning (AI) and occurrence. \[V-CODE `conversationModel.ts:34`, `requestContract.ts:143-167`, `foundation/ask.ts:13` ("A value code cannot read stays null; nothing here guesses")\]

The design was deliberate: ROOT-CAUSE and FOUNDATION-PLAN moved meaning **out of** the model after 30 rounds of model-composed plans failing. That decision fixed plan *composition*, but it also moved *understanding* into brittle regex. The fix is not to give composition back to the model. The fix is to let the model **read** the request into a structured record that code then checks (Chapter 3.6).

### 3.3 Verified lexicon defects

These were verified by reading; sentences were not executed.

| # | Defect | Code | Effect |
| --- | --- | --- | --- |
| L1 | Comments are detected only by `/تعليق/` | `requestContract.ts:150` `commentsAsked = /تعليق/.test(text) && platform !== "x"` | «كومنتات», «كومنتس», «comments», «الكومنت» → `comments: "none"`. **The comments stage is silently dropped**, and the final contract gate cannot flag what the contract never saw |
| L2 | Inconsistent noun lexicons | `foundation/ask.ts:136` `COMMENT_NOUN` includes `كومنتات\|كومنت`, but is evaluated only `if c.comments !== "none"` (`ask.ts:210-212`); `requestCoverage.ts:167` includes `كومنتس` | The same word is understood in one module and ignored in the gate module |
| L3 | Platform spellings | `requestContract.ts:38-45` | Recognised: «تيك توك», «تيكتوك», «tiktok»; «انستجرام/انستغرام/انستا»; «فيس بوك/facebook»; X via `إكس\|اكس\|X\|تويتر\|تغريد\|twitter` **without the `i` flag**. **Missed:** «تك توك», «tik tok», «انستاجرام», «انستقرام», «insta», «الفيس», «fb», «Twitter» (capitalised), «tweets», «يوتوب», «ريديت/Reddit/لينكدإن» (not in the list at all) |
| L4 | No normalization before parsing | `requestContract.ts:143-145` (only whitespace and digits) vs `messageType.normalize`, `relevance.normalizeText` (fold ة/ى/أ) | «السعوديه», «باللغه العربيه», «اخر ٣ شهور» (no madda) fail; country requires `(في\|من\|داخل)\s+` so «فمصر», «بمصر» fail **silently** |
| L5 | Topic only after `عن\|حول\|بخصوص\|فيها\|فيه\|تذكر` (or opinion phrases) | `requestContract.ts:114-122` | «تعليقات فيديوهات تيك توك **الخاصة ب**السياحه», «فيديوهات **السياحة**», «… **على** فيديوهات السياحة» → topic `null`. **There is no topic question card** (`stage2/questionCards.ts:18`), so the pool is read without a keyword |
| L6 | E-mail lexicon false positives | `contacts.ts:13` `EMAIL_WORDS` contains bare `ميل` | «عميل», «جميل», «تحميل» are read as an e-mail request → send-backs to the planner |
| L7 | Chat classifier noun list | `messageType.ts:56` `STRONG_NOUN_RE` | Lacks «كومنت», «تك توك», «انستاجرام», «الفيس», «fb». The rescue override only works when the keyword list matches |

### 3.4 Rejection and drop paths (complete inventory)

Classes: **(a)** genuinely unsupported · **(b)** misunderstanding risk · **(c)** legitimate guard (keep).

| ID | Where | Trigger | Class | Smallest safe fix | Regression test |
| --- | --- | --- | --- | --- | --- |
| W1 | `src/lib/researchPlaceholders.ts:2-12`; `api/chat/route.ts:79` | bracketed token containing `@`, `_`, `عدد`, `count`, «N شهور» → HTTP 400 | b | Reject only true template placeholders (`[الموضوع]`, `<count>`); accept `[آخر ٣ شهور]`, `<@brand_eg>` | `placeholder-real-values.test.ts` |
| W2 | `briefManager.ts:42-48`; `chatHandler.ts:2712` | **unanchored** substrings `من انت`, `كيف تعمل`, `ماذا تقدم`, `هل يمكنك مساعدتي`, `بتعمل ايه` | **b (high)** | Anchor: the message must be short (≤ \~40 chars) or the phrase must be the whole question; never when a data noun or platform is present | «…من انتخابات مجلس النواب على تيك توك», «هل يمكنك مساعدتي في جمع تعليقات…» must reach the agent |
| W3 | `assistantIdentity.ts:16,26-28` | vendor word (`gpt`, `gemini`, `ديب سيك`…) + any `من/هل` in ≤120 chars | b | Require identity syntax (you/انت + vendor), not substring | «هات ١٠٠ تعليق من تيك توك عن ChatGPT» → mission |
| W4 | `guardRules.ts:13-25` privacy | personal-contact words without a business word | c (+b false positives) | Keep the guard. Add data-object exceptions («موبايلات سامسونج», «جروبات واتساب» as topics) **only** when a platform-content noun is the object | Both directions: «أرقام موبايل الناس اللي علقوا» stays refused |
| W5 | `guardRules.ts:42-53` account | `(ال)?شحن( \|$)` = top-up | b | Treat «شحن» as top-up only with wallet words (رصيد/نقاط/محفظة) | «قائمة مكاتب شحن في جدة» → data request |
| W6 | `guardRules.ts:72-77` trust | «نصب», «احتيال», «موثوق» as words | b | Only when the subject is Diger (2nd person / «المنصة دي») | «تعليقات عن حملات النصب الإلكتروني» → data request |
| W7 | `conversationModel.ts:272`; `messageType.ts:56` | model says non-data and keyword agrees | b | Shared lexicon (L-fixes) + interpreter (3.6) | paraphrase suite |
| W8 | `chatTurn.ts:122-137` | follow-up labelled `edit_of_open_request` → only `count` applied | b | Route edits through the interpreter. If anything other than count changed, **create a revised request** (carry context) instead of dropping it silently | «خليها ٥٠٠ تعليق من يوتيوب بدل تيك توك» changes platform |
| W9 | `chatTurn.ts:173-177` | free-text answer classified data_request cancels the open mission | b | When a card is waiting (`needs_input`), first try to read the message as the answer | answer-as-text test |
| W10 | `customerActions.ts:52-60` | >3 open missions / >20 per hour | c | keep | — |
| K1 | `runMission.ts:347-355` | platform flag not on | c/a | keep (flags are all `on` today V-DB) | — |
| K2 | `runMission.ts:359-381`; `platformQuestion.ts:18-37` | platform regex missed → platform/clarify card; **2nd unclear answer → unserved** | **b (high)** | Shared lexicon; the interpreter supplies the platform; a typed answer is re-read with the lexicon | «تك توك», «انستاجرام» |
| K3 | `agent/src/tools.ts:584-589` | a legacy-model plan touching **any** social endpoint → the whole request ends `unsupported` | **b (high)** | Do not end the request. Return to routing: split into a compiled social part, or state the part as not included. Example: «حسابات السوشيال لشركات المقاولات» is a **company enrichment** need, not a social-content need | companies + social links request |
| K4 | `runMission.ts:421-426` | customer chose cancel | c | keep | — |
| K5 | `compiled.ts` cannot-reasons | e.g. topic null → keyword-less pool | b | Ask the topic (new card) instead of reading a keyword-less pool | «تعليقات فيديوهات تيك توك الخاصة بالسياحه» |
| K6 | `refusal.ts:121-131` | model finished `cannot_serve` | a/b | keep, with recorded reason | — |
| K7 | `compilePlan.ts:619-625` | replies asked, comments missed → false note «لا توجد بعد أداة موثّقة لقراءة الردود» | b | fixed by L1; the note must name the real cause | «الكومنتس والردود» |
| K8 | `plan.ts:752,765` + `contacts.ts:13` | false e-mail ask → send-backs → turns exhausted | b | L6 | «آراء العملاء على تيك توك» |
| K9 | `runMission.ts:309` | restarts > max | c | keep | — |
| X1 | `chatHandler.ts:2063-2081` + `answerWithAgent` passes only `message` (`chatHandler.ts:1613`) | **uploaded exclusion/enrichment file is parsed, confirmed to the customer, and never used by the agent** (grep: no consumer in `agent/src` or `src/lib/agentMission`) | **b (trust)** | Short term: tell the customer honestly that the file is not applied. Then carry the file into the mission and apply it as a code filter at ingest | upload + mission test |

**Production evidence of the class-(b) rejections V-DB** (test account, `unserved`, *compiled: 0*, no provider or model call, ended in about 1 s):

- 2026-11-04: «عايز ١٠ منشورات من إنستجرام عن الذكاء الاصطناعي», «عايز ١٠ فيديوهات من يوتيوب عن الذكاء الاصطناعي» → «مصادرنا لا تخدم هذا الطلب». These were before #383/#385, which now ask for an account/channel. Topic search on Instagram is still available only through discovery, which is limited to test accounts REPORTED Round 33, V-DB flag.
- 2026-11-04: «استخرج لي بيانات حساب عام على تيك توك مع الإحصائيات العامة» → unserved, although TREG's catalog has 9 `tiktok.user.profile` endpoints and `capability_registry` has `tiktok-profile` enabled. **A missing card shape was reported as "unsupported".**
- 2026-11-09: a **Reddit** request reached the legacy model planner **only because it contained «الشركات»** (`COMPANIES_OR_PLACES` is checked before `OTHER_PLATFORM`, `platformQuestion.ts:31-37`) V-CODE. It then delivered nothing, because a default language filter removed all rows (#441 fixed that part).

### 3.5 The seven example requests (static walk-through)

| Request | What the code does today | Correct interpretation |
| --- | --- | --- |
| «عايز كومنتات فيديوهات تيكتوك عن السياحة» | platform tiktok, topic السياحة, **comments none** → videos-only plan, no warning | TikTok videos about tourism **+ their comments** |
| «هات تعليقات فيديوهات تيك توك الخاصة بالسياحه» | comments yes, **topic null** → keyword-less pool → likely no_rows/unsupported INFERRED | same as above |
| «محتاج comments بتاعة TikTok عن السياحة» | tiktok, topic yes, **comments none** → videos only | same |
| «عاوز الكومنتس والردود على فيديوهات السياحة» | platform null → «من أنهي منصة؟»; then comments none, replies yes, topic null → false "no replies tool" note | same + replies; platform must be **asked** (genuinely missing) |
| «عايز ٥٠ شركه مقاولات فمصر مع الاميلات» | legacy model planner; count 50 read; e-mail read; «فمصر» readable by `placesInText` in the B2B path, not in the social contract | 50 contracting companies in Egypt + official company e-mails (not employees' private e-mails) |
| «محتاج 50 contracting companies in Egypt and their official emails» | legacy model planner (B2B Ask returns null: `/شرك/` only) | same as above |
| «هات شركات المقاولات في مصر ووسائل التواصل العامة بتاعتها» | legacy model planner; **if the model proposes a social-profile endpoint → whole request ended (K3)** \[V path; model choice INFERRED\] | companies + official website + **public** social profile links (company enrichment); count must be asked |

Conclusion: the four tourism paraphrases produce **at least three different plans** today. The company paraphrases depend on Haiku's planning luck.

### 3.6 Recommended meaning-first understanding design

**Principle.** The model **reads**, code **decides**. A union rule protects explicit requirements, and the privacy check runs on both the original text and the interpretation.

**1. `ResearchIntent` record** (new pure type; zod-validated). Produced by one Haiku call with a forced tool / JSON schema, once per mission (re-run when an answer or edit arrives):

```
type ResearchIntent = {
  original_text: string;                // verbatim, never rewritten
  normalized_text: string;              // lexicon-normalized (ة/ه, أ/ا, digits, platform spellings)
  objective_ar: string;                 // one sentence, for the card
  family: "social_content" | "companies" | "people_b2b" | "places" | "reviews" | "web_pages" | "news" | "other";
  platform: "tiktok"|"x"|"instagram"|"facebook"|"youtube"|"reddit"|"linkedin"|null;
  parent: { kind: "videos"|"posts"|"tweets"|"reels"|"accounts"|"companies"|"places"|null; count: number|null; count_basis: "explicit"|"inferred"|null };
  children: { comments: "none"|"some"|"all"; comments_per_parent: number|null; replies: "none"|"some"|"all"; replies_per_comment: number|null };
  topic: string|null; topic_relation: "about"|"made_with"|null;
  source: { kind: "named"|"official"|"none"; text: string|null; url: string|null };
  constraints: { country: string|null; period: {from: string; to: string}|null; language: "ar"|"en"|null };
  wanted_fields: string[];              // e.g. ["official_email","hq_phone","website","social_links"]
  preferences: string[];                // optional "(لو متاح)" clauses
  budget_points: number|null;
  files: { exclusion: boolean; enrichment: boolean };
  evidence: Array<{ field: string; span: string }>;   // the customer's words that justify each non-null field
  assumptions: Array<{ field: string; value: string; why_ar: string }>;  // inferred, NOT confirmed
  missing: Array<{ field: string; question_ar: string; affects: "cost"|"scope"|"result"|"authorization" }>;
  sensitive_signals: string[];          // e.g. "private_person_contact"
};
```

**2. Reconciliation (pure code, `reconcileIntent(regexContract, modelIntent)`):**

- **Union for "asked" items.** If either the regex contract or the model says comments/replies/country/period/language were asked, they are asked. The model can never remove what code found.
- **Evidence check.** A model field without a matching `evidence.span` in `original_text` (after normalization) is downgraded to an `assumption`, shown on the card as «افترضنا…» and never silently applied to provider inputs.
- **Conflicts** (regex says X, model says Y) become one clarification question, unless the regex value is explicit and the model's is inferred.
- **Missing vs unsupported.** A required field the customer did not give is a **question**. A requirement no verified capability can carry is a **stated gap** on the card. Neither is a refusal.
- **Privacy.** `guardRules` runs on `original_text` **and** the interpretation. If *either* signals a private-person request, the request is refused exactly as today. The interpreter can never turn a refused request into an allowed one (test: «أرقام موبايلات الناس اللي علّقوا» stays refused even if the model labels it "comments").

**3. Persistence.** Store `intent` (and `intent_version`) in `missions.plan` or a run-state object. The compiled path reads `Ask` built **from the reconciled intent**. Quote and execution read the same object, so `original_text`, normalized intent, assumptions and gaps travel unchanged to the card, the methodology and the file.

**4. Multi-turn.** Answers and edits are merged into the intent (field-level patch), not appended as `answer_text` that replaces the previous answer. «لا، أقصد تيك توك مش يوتيوب» patches `platform`. The current earliest-match rule in `firstPlatform` is replaced by "latest explicit correction wins".

**5. When to ask.** Only for `missing[]` entries whose `affects` is cost, scope or authorization, and at most one card per turn (re-use the existing card mechanism, `stage2/questionCards.ts`). Never ask for a field that has evidence.

**6. Cost and latency.** One extra Haiku call per mission, plus one per answer. The repo's own planner price constant for Haiku is 0.10 USD / 0.50 USD per million input/output tokens (`src/lib/modelPlanner/constants.ts:33`, REPORTED in AUDIT-2026-11). At about 2,000 input and 400 output tokens that is ≈ 0.0004 USD per call. **This is an estimate to be measured in shadow, not a measurement.** Latency: the chat model already runs at a 12 s timeout. The interpreter runs on the worker at planning start (no Vercel 60 s pressure).

**Root-cause verdict (Objective A).** The cause is the interaction of **contracts + routing + pre-filters**, not model capability. No evidence suggests that replacing Haiku would help; the model is not asked to understand meaning in the first place.

---

## CHAPTER 4: PROVIDER INTEGRATION AUDIT

### 4.1 TREG

| Question | Answer | Evidence |
| --- | --- | --- |
| What is it? | A meta-API ("OpenRouter for agent tools"): one token, 4,114 endpoints from 126 providers; provider responses passed through unchanged | V-DOC-EXT [https://treg.to/llms.txt](https://treg.to/llms.txt), [https://treg.to/catalog](https://treg.to/catalog) |
| Integrated? | Yes. `agent/src/gateway.ts` (`treg_call`, 11 ordered checks), `src/functions/shared/tregClient.ts:184-236` (key pool, cost from `x-treg-cost-micro`), `tregKeyPool.ts` (Vault-encrypted pool, 3 hops) | V-CODE |
| Reachable by the worker? | Yes, always (`TREG_TOKEN` required, `agent/src/main.ts:29`) | V-CODE |
| Visible to the planner? | Yes: `catalog_search`, `describe_endpoint`, `treg_call`; compiled path cards | V-CODE |
| Catalog | Pinned snapshot `data/treg/treg_catalog_sellable.json`, "describe pass 2026-10-27", 3,276 sellable endpoints (+ 652 own-account, 29 write and 12 paused excluded), 1,018 distinct `capability` values, of which **1,004 endpoints have capability `None`**. Loaded once per process (`src/lib/treg/catalog.ts:127-132`); **no runtime refresh** | V-CODE + this session's count |
| Data policy | `data/treg/data_policy.json`: public 2,993 / b2b_contact 231 / sensitive 50 / blocked 278. Generator `scripts/treg/build-data-policy.mjs` is **not in the repo** | V-CODE |
| Used in production | \~95% of all recorded calls (anyapi, tikhub, crawl4ai, scrapecreators, tomba, aviato, …) | V-DB |
| Known limits | Pagination differs per sub-provider. Routed `treg.tiktok.search.videos` returns the first page only. Planning sample cap is 2 reads per source (`gateway.ts:40`, protected file) | V-DOC-EXT skill.md V-CODE |

### 4.2 Firecrawl

| Question | Answer | Evidence |
| --- | --- | --- |
| Integrated directly? | Yes. `src/lib/server/multiProvider/adapters/firecrawl.ts` (search `/v2/search`, map, scrape `/v2/scrape`, scrape_json); shared HTTP layer `httpCall.ts:40-111` (cap reserve → call → commit; no retry) | V-CODE |
| Reachable by the worker? | **Only** on the legacy model planner (companies/places), **only** when a key resolves (`webAvailability.ts`). Never on the compiled social path or the Stage-3 B2B code path (`compiled.ts:268` calls only `tregCall`) | V-CODE |
| Credentials | `provider_api_keys.firecrawl` ciphertext, decrypted with `PROVIDER_KEYS_ENCRYPTION_KEY`, else env `FIRECRAWL_API_KEY` (`providerKeys.ts:39-44,119-193`). The worker does not require that variable (`main.ts:29`) | V-CODE |
| Production result | **24 calls, 0 succeeded, all `refused: source_unavailable:firecrawl`**, 2026-10-29 → 2026-10-30; none since. The follow-up change **hides** the tools when no key resolves (`webAvailability.ts:4-9`) | V-DB |
| Daily cap | `firecrawlDailyUsd = 1` (not 0) | V-DB |
| Also inside TREG | `firecrawl.web.search` (0.01 USD/call, TREG-observed ok 0.9987, n=15,187), `firecrawl.web.scrape` (0.005/page, **ok 0.40**, n=165,704), `.map`, `.crawl`, `.batch-scrape`, all policy "public" | V-CODE catalog |
| Official capabilities | `/scrape` (many formats incl. json, changeTracking), `/search`, `/map`, `/crawl`, `/batch/scrape`, `/agent`, `/parse`, `/monitor`. **`/extract` deprecated, removed 2026-12-10.** No documented support for X/TikTok/Instagram/Facebook/YouTube comments; `403 UNSUPPORTED_SITE` exists | V-DOC-EXT docs.firecrawl.dev |

### 4.3 Context.dev (formerly Brand.dev, renamed 2026-03-21)

| Question | Answer | Evidence |
| --- | --- | --- |
| Integrated directly? | Yes. `adapters/contextdev.ts` (`/v1/web/search`, `/v1/web/urls`, `/v1/web/scrape`); `contextdevParse.ts` (20 prebuilt parsers, People Search `/v1/people/search`); agent tools `parse_page`, `web_search`, `web_scrape`, `people_search` (`agent/src/tools.ts:827-890`, `webGateway.ts`) | V-CODE |
| Reachable? | Same conditions as Firecrawl | V-CODE |
| Production result | **47 calls, 0 succeeded** (45 `source_unavailable:contextdev`, 2 `not_sellable`), last 2026-10-30 | V-DB |
| Daily cap | `contextdevDailyUsd = 1` | V-DB |
| Also inside TREG | as `branddev.*`: `branddev.web.search` (0.002534 = "1 credit", TREG-observed ok 0.994), `branddev.web.scrape` (ok 0.747), `.map`, `.crawl`, 13 `branddev.brand.*` (e.g. `brand.retrieve-by-name` → domain + socials + address; `brand.ai.query` structured website extraction, n=24,668, ok 0.9994) | V-CODE catalog; rename V-DOC-EXT changelog |
| Official capabilities | scrape (+ json, parse), search, crawl, map, answers, **parsers** incl. google-maps(-reviews ≤1,000), reddit-post/search/subreddit/user, yelp, tripadvisor, g2, app stores, instagram profile/post/feed, tiktok profile/video/feed/comments (**first 20 only**), emails, phone-numbers, links; People Search (no e-mail/phone fields); People Enrich (beta, returns `email`); Company Search. No X/Facebook/LinkedIn parser | V-DOC-EXT docs.context.dev |
| Price | The repo uses 0.00254 USD/credit (`catalog.ts:31-32`). The current public pricing implies 0.00075–0.004 per credit depending on plan; **0.00254 matches no current published figure** | V-DOC-EXT V-CODE |

### 4.4 Is the historical blocker still present?

**Yes V-DB + V-CODE.** The keys exist in the database and the daily caps are above 0. Every worker call was refused with `source_unavailable`, which is the refusal code for "no key resolved" (`webGateway.ts:91-92`). The documented cause is that `PROVIDER_KEYS_ENCRYPTION_KEY` could not be copied from Vercel (sensitive variable) to Heroku REPORTED `docs/ENGINE_AND_ITEM_STORE.md` §18; treg-key-pool README. No code since then gives the worker another decryption path; the later change only hides the tools. Whether someone has since set the variable or plain keys on Heroku is **UNKNOWN**. No call has been attempted since 2026-10-30, which is consistent with the tools being hidden.

### 4.5 The legacy multi-provider chain

`src/lib/multiProvider/*` and `src/lib/server/multiProvider/{chainRunner,chainAdapter,planRouting}` are gated by `MULTI_PROVIDER_ENABLED` and reachable only from the old planner and `/api/worker/chunk`. Both are bypassed while `AGENT_SERVES_CHAT=true` V-CODE. `multiStepOrchestrator.ts` is imported only by tests. **Recommendation: LEAVE UNTOUCHED now, DEPRECATE LATER.** Reuse only its adapters, `httpCall`, `callRecorder` and `policy.checkPublicReadUrl` (the agent already does).

---

## CHAPTER 5: PROVIDER CAPABILITY MATRIX

Five levels: **Adv** = advertised by the provider · **Impl** = implemented in Diger · **Reach** = reachable by the current worker for customers · **VerEv** = verified on stored real evidence (tests/fixtures) · **Prod** = approved for production (hand card verified or sold service).

| Capability | TREG (direct sub-providers / routed) | Firecrawl (direct) | Firecrawl via TREG | Context.dev (direct) | Context.dev via TREG (`branddev`) |
| --- | --- | --- | --- | --- | --- |
| X posts by keyword/date | Adv ✓ Impl ✓ Reach ✓ VerEv ✓ Prod ✓ (`anyapi.x.search.posts`) | ✗ | ✗ | ✗ | ✗ |
| X replies | ✓✓✓✓✓ (`anyapi.x.post.comments`) | ✗ | ✗ | ✗ | ✗ |
| TikTok videos / comments / replies | ✓✓✓✓✓ (tikhub, anyapi, crawl4ai cards) | ✗ (undocumented) | ✗ | Adv (comments first 20), Impl, Reach ✗ | ✗ in snapshot |
| Instagram account posts / comments / replies | ✓✓✓✓✓ (scrapecreators, anyapi) | ✗ | ✗ | Adv (profile/post/feed), Impl, Reach ✗ | ✗ |
| Instagram by topic (hashtag/reels search) | Adv ✓ Impl ✓ (discovery-derived) Reach **test only** VerEv partial Prod ✗ | ✗ | ✗ | ✗ | ✗ |
| Facebook page posts / keyword posts / comments | ✓✓✓✓✓ (justoneapi, anyapi, scrapecreators) | ✗ | ✗ | ✗ | ✗ |
| YouTube videos / comments / replies | ✓✓✓✓✓ (tikhub, crawl4ai, anyapi) | audio/video formats only | ✗ | transcripts only | ✗ |
| Reddit posts / comments | Adv ✓ (52 endpoints) Impl: generic only Reach: only via accidental legacy route Prod ✗ | ✗ | ✗ | Adv ✓ (4 parsers, ≤1,000) Impl ✗ (parser list predates them) | ✗ |
| Company discovery | ✓✓✓ (icypeas, tomba, aviato…) Prod ✓ (`icypeas-companies-search` sold) | Adv via Alexandria (Apollo…) | ✗ | Adv Company Search, Impl ✗ | ✗ |
| Company website enrichment (domain, socials, address) | `branddev.brand.retrieve(-by-name)` Adv ✓ Impl generic Reach (legacy planner only) | — | — | Adv Brand API Impl ✗ | ✓ Adv; Reach via `treg_call` on legacy path |
| Official company e-mail / HQ phone | `tomba.companies.emails.list`, source `phone_number` Adv ✓ Impl partial | — | — | `emails` / `phone-numbers` parsers (on-page) Impl ✓ Reach ✗ | — |
| People (decision makers) | `treg.people.search` Prod ✓ (sold) | Alexandria | — | People Search Impl ✓ Reach ✗ | — |
| Google Maps places | `crawl4ai.google.serp.maps` (TREG-observed n=2.24M, ok 0.9998, 0.00015), `treg.google.serp.maps`. Impl ✓ (Stage-3 cards) Reach: `companies/places` flag `test` → legacy planner Prod ✗ | ✗ | ✗ | google-maps parser Impl ✓ Reach ✗ | ✗ |
| Place reviews | `treg.google.maps.reviews`, `crawl4ai.google.maps.reviews`, tripadvisor, trustpilot… Adv ✓ Prod ✗ | ✗ | ✗ | google-maps-reviews ≤1,000, yelp, tripadvisor Impl (gm) Reach ✗ | ✗ |
| Web search | 28 `web.search` endpoints incl. `treg.web.search` (routed) Reach (legacy planner) | Impl ✓ Reach ✗ | `firecrawl.web.search` ✓ catalog | Impl ✓ Reach ✗ | `branddev.web.search` ✓ catalog |
| Web page extraction | 22 `web.extract` endpoints incl. routed `treg.web.extract` | Impl ✓ Reach ✗ | `firecrawl.web.scrape` (ok 0.40) | Impl ✓ Reach ✗ | `branddev.web.scrape` (ok 0.747) |
| News articles | `google.serp.news` (8 endpoints) Adv ✓ Prod ✗ (CAPABILITY_COVERAGE: unsupported) | via search | — | — | — |
| Change tracking | ✗ | `changeTracking`, `/monitor` Adv | — | Monitors Adv | — |

**Overlap analysis.**

- **Interchangeable:** web search, single-page extraction, site map. Here TREG already routes across Firecrawl, Context.dev, crawl4ai, exa and others, with observed success rates.
- **Complementary:** Context.dev's prebuilt parsers (Google Maps reviews ≤1,000, Reddit, Yelp/Tripadvisor, on-page e-mails/phones) and People Search. These are useful only where TREG lacks an equivalent with verified evidence; for most of them TREG has alternatives, verified there only by TREG's own stats.
- **Not overlapping:** all social *comments/replies* work. That is TREG-only in practice. Firecrawl documents no support; Context.dev covers TikTok comments (first 20 only) and Instagram top comments only.

**Pricing metadata available today:**

- TREG catalog: per endpoint `cost.usd/unit/type`, `cost_confidence` (verified 2,019 / documented 848 / unknown 158) and `observed.{ok_rate,p50_ms,samples}`.
- Diger's own measured cost: `mission_calls.cost_usd`.
- Firecrawl / Context.dev direct: constants in `multiProvider/catalog.ts` dated 2026-10-22, now partly stale.

---

## CHAPTER 6: ROOT-CAUSE ANALYSIS: why Diger relies mainly on TREG, and what blocks real multi-provider research

1. **Owner scope decision.** «TREG only for now. Firecrawl and Context.dev are out of scope» (`docs/REDESIGN.md:54`) V-CODE doc. The whole compiled foundation (#348 → #437) was built under this rule.
2. **The compiled social path is TREG by construction.** Hand ToolCards and discovery-derived cards come from the TREG snapshot only (`discovery/deriveCards.ts:31-36`). `roleGrammar.ts` has no `web.*` role, and the compiler calls only `gateway.tregCall` (`compiled.ts:268`) V-CODE.
3. **The deterministic engine is TREG-only.** `EngineDeps.gateway` is the TREG gateway (`engine/run.ts:46,548`); `spec.ts:97-98` skips non-TREG stages. `engineOn = every stage has an engine spec` (`runMission.ts:627`), so **a single web stage pushes the whole mission onto LLM-driven execution** V-CODE.
4. **Credentials.** The worker cannot decrypt the direct Firecrawl/Context.dev keys (§4.4). Since 2026-10-30 the tools are hidden, so the planner never sees them V-DB, V-CODE.
5. **Coverage is defined by hand cards and a 10-row sold-services registry, not by provider availability** V-DB `capability_registry`. TREG's catalog has maps, reviews, news, Reddit, web extraction and company enrichment endpoints, all policy-"public". But a request family is served only if someone wrote a card for its exact *shape*. Anything else is "unsupported" (§3.4 production evidence). 1,004 endpoints have no `capability` value, so they can never join a capability-based pool V-CODE, also REPORTED in FOUNDATION-PLAN §1.3.
6. **Single quote item.** One blended unit price per mission (`accept_quote_atomic:112-114`, `lifecycle.ts:48-53`). This works for multiple providers, but cannot express per-stage or per-provider lines. **Not a blocker**; it simply should not be changed now V-CODE.
7. **No provider-neutral registry.** Three separate lists describe "sources":
   - the TREG snapshot;
   - `src/lib/agentMission/sources.ts` (`WEB_SOURCES`, `PARSERS`);
   - `src/lib/multiProvider/catalog.ts` (`CAPABILITIES`).

The id namespaces collide: `firecrawl.search` vs TREG's `firecrawl.web.search`, and `contextdev.*` vs `branddev.*` V-CODE.

**Net:** genuine multi-provider research is blocked mostly by **architecture (TREG-only cards and engine) and coverage-by-hand-card**, then by **credentials**. Provider capability is not the bottleneck. The cheapest unblock is to use the Firecrawl/Context.dev endpoints **already resold inside TREG** through the existing gateway, which needs no new key, cap, ledger path or adapter.

---

## CHAPTER 7 — CONTINUOUS PROVIDER INTELLIGENCE

### 7.1 Update-discovery mechanisms that actually exist (V-DOC-EXT, fetched 2026-11-11)

| Mechanism | TREG | Firecrawl | Context.dev |
| --- | --- | --- | --- |
| Token-free catalog / list API | **Yes**: `GET https://treg.to/catalog/search?added_within_days=N&sort=newest`, `/catalog/endpoints/{id}` (params, cost, siblings, example) | Partial (Alexandria `find-tools`) | No (parser list = enum in OpenAPI) |
| OpenAPI | `/openapi.json` (treg's own API only, v0.0.1) | v2 / v1 / v0 specs | `https://docs.context.dev/openapi.json` v1.0.0 |
| Version id | `GET /meta` → `treg_version`, `app_version` | URL `/v2`, GitHub tags v2.11.x | URL `/v1`, spec 1.0.0 |
| Changelog feed | **None** (repo CHANGELOG undated "Unreleased") | RSS `https://www.firecrawl.dev/changelog/rss.xml`; Atom `github.com/firecrawl/firecrawl/releases.atom` | RSS `https://docs.context.dev/changelog/rss.xml` |
| Deprecation policy | none found | inline announcements (e.g. `/extract` removal 2026-12-10) | ≥ 90 days, changelog-announced |
| Status page | none found | status.firecrawl.dev (RSS/Atom/webhook) | status.context.dev |
| llms.txt / MCP | llms.txt, skill.md, MCP `/mcp/` | llms.txt + llms-full.txt, MCP | llms.txt + llms-full.txt, MCP |

**Drift already present V-CODE + V-DOC-EXT + INFERRED:** the pinned snapshot is from 2026-10-27 (3,969 endpoints before exclusions); TREG's public catalog now lists 4,114. Context.dev added Reddit, Yelp, Tripadvisor parsers (Oct 30–31) absent from `sources.ts` `PARSERS`. Firecrawl `/extract` (registry entry `firecrawl.extract`, unused) will be removed. The repo has **no** mechanism that would have noticed any of this.

### 7.2 Registry design — extend, do not duplicate

**Reuse:** `foundation/toolCards/*` (hand cards with `status: verified | catalog_only`), `toolCards/verify.ts` (`checkCardOnPage` against stored real pages), `discovery/deriveCards.ts` (card from catalog metadata or a rejection **with a reason**), `discovery/chain.ts` (chain validation), the TREG snapshot loader, `data_policy.json`, `blockList.ts`.

**Add one provider-neutral layer** — `src/lib/capabilities/registry.ts` (pure, data in repo) + `data/capabilities/registry.json` (generated, reviewed in PRs):

```
type CapabilityEntry = {
  id: string;                          // canonical: "<provider>.<path>" exactly as the gateway calls it (TREG ids unchanged; direct web sources keep "firecrawl.search"/"contextdev.parse.google-maps")
  provider: "treg" | "firecrawl" | "contextdev";
  via: "treg" | "direct";              // firecrawl.web.scrape via TREG vs firecrawl.scrape direct
  sub_provider?: string;               // tikhub, anyapi, branddev, …
  capability: string;                  // provider-neutral role: "social.tiktok.video.comments", "web.extract", "places.search", "places.reviews", "company.enrich", …
  inputs_schema: JSONSchema;  output_item_fields: string[];  list_path?: string; cursor_path?: string;
  constraints_carried: Array<"keyword"|"date_range"|"country"|"language"|"account"|"sort"|"limit">;
  pricing: { unit: "call"|"page"|"row"|"credit"; usd: number|null; basis: "verified"|"documented"|"estimated"|"unknown"; billed_on_failure: boolean|null };
  rate_limit?: { per_min?: number; concurrency?: number };
  schema_fingerprint: string;          // sha256 of normalized inputs + item_fields + list/cursor paths
  discovered_at: string; last_checked_at: string;
  verification: { status: "discovered"|"schema_checked"|"fixture_verified"|"live_verified"|"production_eligible"|"deprecated"|"broken";
                  evidence: Array<{ kind: "stored_page"|"test_mission"|"provider_doc"; ref: string; at: string }> };
  reliability?: { diger_calls: number; diger_ok: number; diger_rows_per_call_p50?: number; provider_observed_ok?: number };
  policy: "public"|"b2b_contact"|"sensitive"|"blocked";   // from data_policy / direct policy
  fallback_group?: string;             // entries that can substitute each other for the same capability + constraints
  card?: string;                       // ToolCard id when one exists
};
```

Rules: **customer-facing surfaces never read this file** (provider names, prices stay internal; `providerHosts.ts` scrubbing stays). `production_eligible` requires: policy ≠ blocked/sensitive, price basis verified or documented, `fixture_verified` (≥ 1 stored real page passes `checkCardOnPage`), and owner/PR approval. Reliability is fed from `mission_calls` (Diger's own numbers first; TREG's `observed` only as a weak prior).

### 7.3 Safe update lifecycle

```
sync script (read-only, no paid call)  ──► diff report (new / changed fingerprint / price change / removed / deprecated)
      │                                          │
      │                                    classify: additive | price | breaking-schema | removal | policy
      ▼                                          ▼
registry.json updated in a PR  ◄── impact check: which ToolCards / fallback_groups / stored plans reference the id
      │                              offline contract tests: replay stored real pages through the new schema (verify.ts)
      ▼
verification.status recomputed (never above fixture_verified automatically)
      │
      ▼  human-reviewed merge  ──►  production_eligible only by explicit PR field change
      │
      ▼  worker loads the registry at start (pinned, like the TREG snapshot today) — no runtime auto-activation
```

A breaking change on a `production_eligible` entry flips it to `broken` in the PR and the router falls back to the next entry of its `fallback_group`; if none, the capability's card states the gap. A provider outage never triggers registry edits — that is runtime health (7.4), separate from capability truth.

### 7.4 Continuous maintenance on existing infrastructure (no paid monitoring)

- **Sync script** `scripts/capabilities/sync.ts` (read-only HTTP GETs): TREG `/catalog/search?added_within_days=8&sort=newest` + `/catalog/endpoints/{id}` for every id the registry references; Firecrawl and Context.dev OpenAPI files (hash with `ETag`/`If-None-Match` where served) and their RSS feeds; writes `docs/capabilities/sync-<date>.md` + a proposed `registry.json`. Run **weekly** by the owner or a coding agent (there is no GitHub CI; Vercel crons are daily-only on this plan per `vercel.json` and would need write paths — avoid). Cost: zero provider spend; a few hundred KB of GETs.
- **Runtime health (already partly present):** `statsFromCalls` over `recentCalls` (runMission.ts:328) → per-endpoint rolling ok-rate and rows/call; extend to web sources; router demotes an endpoint whose last N calls failed (no registry write).
- **Documentation downtime:** sync keeps the last good registry; a failed fetch is reported, never treated as "removed".
- **Version pinning:** keep `/v2` (Firecrawl), `/v1` (Context.dev) URLs; record `treg_version` from `/meta` in each sync report.
- **Recover the missing generator** `scripts/treg/build-data-policy.mjs` (referenced by `data_policy.json`, absent from repo) before regenerating policy.

---

## CHAPTER 8 — INTELLIGENT TOOL ROUTING

### 8.1 Responsibilities

| LLM may | Trusted code must |
| --- | --- |
| produce `ResearchIntent`; propose operations and dependencies (e.g. "find companies → read their websites → extract emails"); choose among **already-validated** candidates (exists: `discovery/index.ts` `modelSelector`, answer accepted only if it names a candidate); explain stated gaps in Arabic | build the candidate set from the registry; enforce policy/data-policy/block list; check eligibility and verification status; validate the chain (`chain.ts`); price (`priceMissionByCode`); budget (`JobCallBudget`, daily caps); authorize every call (gateways); retries/fallback; validate rows; settle |

### 8.2 Algorithm (deterministic, lexicographic — no invented weights)

For each required operation of the reconciled intent:

1. **Hard filters (any failure = excluded, reason recorded):** capability matches the operation; `policy` allowed for the request (privacy guard result); `verification.status ≥ production_eligible` (or `≥ fixture_verified` for test accounts, under `CATALOG_ONLY_CAP_USD`); required inputs satisfiable from the intent or the previous stage's item fields (`chain.ts`); provider key/cap available (worker-side availability check must also check the cap — today `resolveWebAvailability` checks only the key); not demoted by runtime health.
2. **Rank, lexicographically:** a. **Constraint coverage** — count of the request's explicit constraints the endpoint *carries* in its inputs (`constraints_carried`), not merely states (fixes FOUNDATION-PLAN finding: topic/date not considered). b. **Evidence tier** — `production_eligible` hand card > live_verified > fixture_verified. c. **Diger-measured usable yield** — usable rows per call (needs ≥ N calls; until then use tier only). d. **Expected cost per usable row** (registry price ÷ measured yield; catalog price ÷ declared page size before measurement). e. **Latency p50**.
3. **Quality floor rule:** a cheaper candidate wins only if (a) and (b) are equal; a dearer one is chosen only by a higher (a) or (b) — this is exactly the owner's D7 rule (REDESIGN §2.2) generalized.

Existing code to reuse: `candidates.ts rankedCandidates`, `toolProfile.ts` coverage classes (add `topic`/`keyword`), `sourceRanking.ts rankByCoverage` (exists, currently test-only — wire it in), `compiled.ts rankedCards`.

**Calibration:** after every live mission, `mission_calls` gives cost and rows per endpoint; a weekly report (`scripts/capabilities/yield-report.ts`, read-only SELECT) updates `reliability` in the registry PR. Thresholds (e.g. "≥ 10 calls before yield is trusted") are **suggested**, to be tuned with data.

### 8.3 Single vs sequential vs parallel

- **Single provider** is the default whenever one candidate covers all constraints (all current social shapes).
- **Sequential** when the intent has dependent operations whose outputs feed inputs: companies (TREG `icypeas/tomba`) → website enrichment (`branddev.brand.retrieve` via TREG, or `treg.web.extract`) → on-page contacts (Context.dev `emails` parser, direct) — each step a stage with `parent_binding`.
- **Parallel** only when: the intent spans two platforms (each its own stage, no dependency) **or** a coverage-completion step is needed after the primary source is exhausted below the requested count. Never by default (duplicate cost, inconsistent schemas).

### 8.4 Fallback rules

| Situation | Action | Money rule |
| --- | --- | --- |
| Primary call fails (5xx/timeout) | retry once (exists: run.ts:549-557), then next validated candidate of the same `fallback_group` read once (exists in compiled path) | inside the same `JobCallBudget`; never re-price after approval |
| Gateway refusal (policy, cap, budget) | a **limit**, never worked around (existing rule) | — |
| Incomplete page / pagination ends early | continue on the next candidate only if it carries the same constraints and dedupe by source id is possible | budget-bounded |
| Output fails schema/mapping | mark the endpoint `broken` in runtime health; next candidate | — |
| No safe alternative | honest partial delivery + stated reason (existing methodology sentences) | charge only delivered rows (existing) |

### 8.5 Cross-provider deduplication

Key order: platform-native id (tweet/video/comment id) → canonical URL (strip tracking query, keep id params — existing `keepLinkQuery` lesson) → for companies: registered domain → normalized name + country. Keep **first occurrence** (existing `itemStore` rule) but record `sources: [endpoint_id…]` per item; on field conflict keep the value from the higher-tier source and record `field_provenance` for contact fields only (cost-bounded). Never drop a record because another provider disagrees; mark it.

---

## CHAPTER 9 — MULTI-PROVIDER EXECUTION

### 9.1 Recommended change (smallest that works)

1. **`SourceGateway` interface** in `agent/src/engine`: `call(sourceId, params) → {rows, cursor, cost, callId}` with two implementations: the existing `Gateway.tregCall` (unchanged, protected) and a thin adapter over the existing `webGateway` (direct Firecrawl/Context.dev). Dispatch by registry `provider`/`via`. **Firecrawl/Context.dev via TREG need no new gateway at all** — they are TREG ids.
2. **Engine spec for web sources** (`engine/spec.ts`): derive a recipe for registry entries with `list_path`/`item_fields`; until then such stages keep today's behaviour.
3. **Per-stage engine**: replace `engineOn = every stage has spec` with per-stage dispatch so one non-engine stage no longer pushes the whole mission to LLM execution (runMission.ts:627).
4. **Provenance**: add `_src` (endpoint id) and `_call` (call id) to each ingested row's internal marks (ingest.ts:146-148) — not written to customer columns (internal file sheet or admin only).
5. **Accounting hygiene (non-financial)**: web calls set `provider_cost_id` (webGateway.ts \~76); add `provider` to `mission_calls` rows or derive by prefix in reports; keep the `*_treg_usd` columns (renaming is a money-adjacent schema change → defer).

### 9.2 What stays untouched

`gateway.ts` checks, `price.ts`, `missionPricing.ts`, `finalize.ts` counting, all SQL money functions, `approval.ts`/`lifecycle.ts`, the single blended quote item. Multi-provider plans are priced exactly as today: per-stage measured cost summed into one unit price by code.

### 9.3 Recovery

Existing: item-store append-only segments, stream cursors, requeue limits, `runMissionSafely`. Multi-provider adds nothing new as long as each stage's cursor is stored per stage (it is: `items.streamState`).

### 9.4 Architectural risks to fix separately (financial, owner approval)

- **F1 — watchdog vs. job lease V-CODE:** mission jobs get a 6 h lease once at approval (`lifecycle.ts:70`, `AGENT_JOB_LEASE_SECONDS`), never renewed; the daily watchdog force-releases any queued/running job whose lease expired > 30 min ago (`api/cron/watchdog/route.ts` selection has no agent-mission exclusion). A mission that waits in the single-slot queue and then runs long can be released before settlement; files are already published → delivered uncharged (revenue leak, not customer harm). Fix: renew the job lease from the worker heartbeat **or** exclude `agent-mission` jobs from the watchdog.
- **F2 — schema drift REPORTED/V-CODE:** `missions`, `mission_calls`, `agent_claim_mission` and the 25,000 cap SQL exist only in `docs/proposals/*`; repo migrations still hold 600. Capture as baseline migrations (no-op on prod) before any new migration.
- **F3 — single global advisory lock** for provider spend (`fix_provider_spend_scope.sql:17`) serializes all providers; fine at current volume.

---

## CHAPTER 10 — PRODUCTION PRESERVATION

### 10.1 Baseline of what works (documented, to be frozen as tests)

| Workflow | Evidence |
| --- | --- |
| Five social platforms, compiled path, parents + comments + replies | V-DB completed missions 2026-11-06…08 on all five (test account), e.g. `msn_2f8e608223e900541f31` (TikTok), `msn_370244ca05ab9dc44ce1` (X), `msn_d7450f19f3a81b5a145e` (Instagram reels), `msn_6a8834fb05b45fec854d` (Facebook), `msn_f96f3b76ec6ac31c4c51` (YouTube) |
| Companies by legacy planner | V-DB `msn_6c4c069b63b730f13826` (5 software companies, Cairo) completed |
| Quote/approval/settlement | V-CODE + V-DB charged points present on completed missions; tests listed in Appendix B |
| Stage-4 review/edit add-ons | V-DB `msn_a5414ff583eebc1d41fd`, `msn_9f481ec19dc446930b1e` completed (flags) |
| Regression assets | V-TEST 934 test files; fixtures: 39 anonymised live missions (`tests/fixtures/live/missions`), `replay-missions.json` (20), `understanding-requests.json` (40), `ask-requests.json` (46), `stored-plans/`, flags-off digests (`flags-off-digests.json`, `foundation-flags-off.json`, `stage2-card-flags-off.json`, `stage3-flags-off.json`) |

Not proven: behaviour for real (non-test) customers at volume; Heroku revision.

### 10.2 Incremental strategy

Every new behaviour gets an `agent_settings` key with modes `off | shadow | test | on`, read once per run (the existing `redesign_flags` pattern; add keys inside the same jsonb or a sibling key `intelligence_flags`): `ask_lexicon`, `intent_interpreter`, `registry_router`, `web_via_treg`, `multi_stage_engine`. Default **off**; `test` = test accounts only; `shadow` = compute and record, never act. The **flags-off digests** fixtures already prove byte-identical behaviour when a flag is off — every PR must keep them green.

### 10.3 Shadow planning (offline first)

- **Offline replay harness** `tests/shadow/` : for every request in `understanding-requests.json`, `ask-requests.json`, `replay-missions.json` and the 39 live fixtures, run (a) current `buildRequestContract`/`buildAsk`/routing and (b) the new lexicon / reconciled intent (with a **recorded** model response fixture, not a live call), and diff: platform, kind, comments, replies, topic, country, period, language, count, route, clarification asked, rejection. Output a table; known improvements are asserted, regressions fail.
- **Recorded model fixtures:** produce interpreter outputs once (owner-approved, capped, e.g. ≤ 0.05 USD total for \~100 requests at the estimated ≈ 0.0004 USD each) and commit them; afterwards the shadow suite runs with zero model spend.
- **Live shadow (later, approval required):** `intent_interpreter=shadow` records the intent as an internal mission event without changing the plan; cap via a daily count limit.

### 10.4 Regression gates (objective)

The new layer is accepted for a step only if, on the replay corpus: zero lost constraints vs. current (every asked item the current contract finds is still found); zero new rejections; tool selection identical for the 20 replay missions unless the diff is an asserted improvement; price function untouched (existing price tests green); flags-off digests identical; no customer-visible text containing provider names (existing scrub tests).

### 10.5 Rollout and rollback

1. Offline (tests only) → 2. `test` mode on the test account → 3. owner-run acceptance missions under a ceiling (existing practice, e.g. 0.20 USD) → 4. `on` per platform/family. Rollback = flip the key to `off` (no deploy). **Deploy discipline:** Heroku restarts requeue running missions (SIGTERM → `abortActiveRuns`, `main.ts:96-98`); merge/deploy only when `agent_worker_heartbeat.active_missions = 0` and no mission is `executing` (read-only check), and record the Heroku release id (today the worker reports `version: dev` — fix by exporting `HEROKU_SLUG_COMMIT`/`SOURCE_VERSION` into the heartbeat; trivial, non-financial).

---

## CHAPTER 11 — EVALUATION AND BENCHMARKS

### 11.1 Shared rules for every scenario (to avoid repeating them 35 times)

- **Budget enforcement (all):** price by `priceMissionByCode` only; reserve via `accept_quote_atomic`; execution bounded by `JobCallBudget` (40% of reserve value) and provider daily caps; fallback never raises the approved price; charge = delivered unique rows × unit, ≤ reserve.
- **Quality checks (all):** required columns per `taskContracts.ts`/`deliveryContract.ts`; source link and source id per row; parent link on child rows; exact-duplicate removal by native id; dates exact or marked «تقريبي»; requested vs collected vs validated vs unique vs delivered counts in the methodology; no provider name in customer text.
- **Offline test template:** `tests/semantic/<id>.test.ts` → (1) `buildRequestContract` + `buildAsk` (+ reconciled intent with recorded model fixture) equals the expected structured intent; (2) routing decision equals expected route/clarification; (3) where a REAL stored page exists, `compilePlan` + engine + workbook over that page (pattern of `tests/round33-acceptance-real.test.ts`); else a SIMULATED page built from the catalog example (labelled SIMULATED, never claimed as verified).
- **Fixture availability:** REAL = anonymised raw pages in `tests/fixtures/live/missions/*` (TikTok, YouTube, Facebook, Instagram, X missions of PR #347); SIM = catalog example only.

### 11.2 The 35 scenarios

| # | Example (Egyptian Arabic) | Correct interpretation → key intent fields | Clarification | Candidate verified tools (registry ids) & rationale | Deps / contract | If unavailable | Fixture |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | «هات ١٠٠ تغريدة عن العاصمة الإدارية الشهر اللي فات» | X, tweets 100, topic, period = previous Cairo month | none | `anyapi.x.search.posts` (carries keyword+since/until; verified card) | single; tweet text/author/date/link/engagement | partial + reason | REAL |
| 2 | «عايز ٢٠ تويتة عن الدوري مع الردود بتاعتها» | X, 20 originals, replies some | replies per tweet? (count affects cost) | search → `anyapi.x.post.comments` | parent→replies; `-filter:replies` on parents | stated gap per tweet | REAL |
| 3 | «فيديوهات تك توك عن الأكل الشعبي، ١٠ فيديوهات» | TikTok («تك توك» typo of spelling), videos 10, topic | none | `tikhub.tiktok.search.videos` / `anyapi.tiktok.search.videos` (country input where carried) | single | partial | REAL |
| 4 | «هات الكومنتات والريبلايز على فيديوهات تيكتوك عن السياحة» | TikTok, videos, **comments all + replies all**, topic | count of videos (cost) | search → `anyapi.tiktok.video.comments` → `anyapi.tiktok.comment_replies` | 3-stage chain; thread sheet | per-video counters vs delivered | REAL |
| 5 | «بيانات حساب انستاجرام بتاع وزارة السياحة وآخر ١٠ بوستات» | Instagram («انستاجرام»), named account, profile + 10 posts | confirm the exact handle if ambiguous | `scrapecreators.instagram.user.posts` (verified); profile = an `instagram.user.profile` endpoint (16 in catalog, **none carded** → card needed) | profile→posts | profile part stated as not included until carded | REAL (posts) |
| 6 | «منشورات صفحة الأهلي الرسمية على الفيس آخر شهر» | Facebook («الفيس»), named page, period 1 month | none | `anyapi.facebook.user.posts` (no date input → period as filter + honest line) | single | period limits stated | REAL |
| 7 | «كل التعليقات على بوستات فيسبوك عن غلاء الأسعار» | Facebook keyword posts + comments all | number of posts | `justoneapi.x.facebook-search-post-v1` (keyword+dates) → `scrapecreators.x.v1-facebook-post-comments` / `anyapi.facebook.post_comments` | chain; relevance gate on parents | empty-comments posts replaced by spares | REAL |
| 8 | «فيديوهات قناة الجزيرة على يوتيوب عن غزة الشهر ده» | YouTube, named channel, topic, period | channel pick if several match (existing card) | `tikhub.x.youtube-web-search-channel` (verified) | single | stated | REAL |
| 9 | «كومنتات فيديو يوتيوب ده [https://youtu.be/…](https://youtu.be/…)» | YouTube comments of one video (+ replies?) | replies yes/no only if cost material | `crawl4ai.youtube.video.comments` / `tikhub.youtube.video.comments` → `anyapi.youtube.comment_replies` | link → comments | source counter vs delivered | REAL |
| 10 | «٥٠ شركه مقاولات فمصر» | companies, 50, sector contracting, country EG («فمصر») | none | `icypeas.companies.search` (sold) / `tomba.companies.search.reveal` | single | partial | SIM |
| 11 | «ومعاها الموقع الرسمي لكل شركة» (follow-up to 10) | patch: wanted_fields += website | none | company source field; else `branddev.brand.retrieve-by-name` **via TREG** | companies → enrich | «غير متاح» per cell | SIM |
| 12 | «الإيميل العام ورقم المقر لكل شركة» | official e-mail + HQ phone (company-level, not personal) | none | `tomba.companies.emails.list`; source `phone_number`; on-page `contextdev.parse.emails` (direct, once key fixed) | companies → contacts | empty + reason; never personal mailboxes | SIM |
| 13 | «صيدليات في المعادي على خرايط جوجل» | places, pharmacies, area Maadi | count | `crawl4ai.google.serp.maps` (TREG-observed n≈2.2M, ok 0.9998, 0.00015) / `treg.google.serp.maps` | single | partial | SIM |
| 14 | «تقييمات مطعم X على جوجل ماب، آخر ٢٠٠ ريفيو» | reviews of one place, 200, newest | confirm the place if several | `treg.google.maps.reviews` / `crawl4ai.google.maps.reviews`; alt `contextdev.parse.google-maps-reviews` (≤1,000) | place search → reviews | stated limit | SIM |
| 15 | «٣ مديرين من كل شركة برمجيات في السعودية مع إيميلات الشغل» | companies → decision makers, work e-mails | count of companies | `icypeas.companies.search` → `treg.people.search` → finders (existing contact chain) | 3-stage | unverified marked «غير موثّق» | REPORTED live runs |
| 16 | «شركات الطاقة الشمسية في مصر ومواقعهم وصفحاتهم على السوشيال» | companies + website + public social links | count | TREG companies → `branddev.brand.retrieve-by-name` (returns socials) via TREG | 2 providers' data (Context.dev via TREG); **not** a social-content plan (K3 must not fire) | per-cell «غير متاح» | SIM |
| 17 | «شركات تسويق في دبي + الإيميلات اللي على مواقعهم» | companies → website → on-page e-mails | count | TREG companies → `treg.web.extract` → `contextdev.parse.emails` (direct) | 3 complementary capabilities (only if Context.dev direct key fixed; else 2) | stated | SIM |
| 18 | «كومنتات تيك توك عن رمضان» while primary comments source fails | TikTok comments | — | primary `anyapi.tiktok.video.comments` fails → `tikhub.tiktok.video.comments` (same fallback_group) | same budget | partial + reason | REAL + injected failure |
| 19 | «عايز رسايل الواتساب بتاعة جروب الشغل» | private messages | — | none (private) | — | **refuse** (privacy guard) | n/a |
| 20 | «هات تعليقات فيديوهات تيك توك الخاصة بالسياحه» | = #4 without replies; topic «السياحة» | count | as #4 | as #4 | — | REAL |
| 21 | «عايز الكومنتس بتاعة التك توك عن الاكل» (voice transcript) | TikTok comments, topic food | count | as #4 | as #4 | — | REAL |
| 22 | «محتاج 200 comments من TikTok videos عن AI في مصر» | TikTok, comments total 200, topic AI, country EG | topic relation (about vs made-with — existing card) | as #4 + country-carrying search | as #4 | country gap stated if not carried | REAL |
| 23 | «عايز داتا عن رأي الناس في الذكاء الاصطناعي» | opinions; platform missing | **platform** (genuinely missing) | after answer: per platform | — | — | REAL (live msn_04afab34…) |
| 24 | «هات ٢٠ فيديو يوتيوب… لا خليهم تيك توك» | patch platform → TikTok | none | TikTok search | — | — | SIM |
| 25 | «اعمل لي تعليقات تيك توك عن السياحة بس استبعد الحسابات اللي في الملف» + exclusion.xlsx | exclusion file applies to authors | none | as #4 + code filter on author handles | ingest filter | if the file is not applied: **say so** (today it is silently ignored) | SIM |
| 26 | «عندي ليستة شركات في الملف، كمّل لي إيميلاتهم ومواقعهم» + list.xlsx | enrichment of uploaded companies | confirm the name/domain columns | `branddev.brand.retrieve-by-name` via TREG; `tomba.companies.emails.list` | file → enrich | not supported today → stated gap until built | SIM |
| 27 | «تغريدات عن الانتخابات من ١ لـ ١٥ أكتوبر ٢٠٢٦ بس» | X, strict Cairo-day range | none | `anyapi.x.search.posts` (since/until with Cairo offset — existing #341) | single + period filter | rows outside the range never delivered | REAL |
| 28 | «فيديوهات تيك توك من السعوديه بس» | country SA strict («السعوديه» with ه) | none | search with `region` where carried; country mark/filter otherwise | — | gap line if no tool carries country | REAL |
| 29 | «بالظبط ٥٠٠ تعليق، لا أكتر ولا أقل» | strict count | none | as #4 | count cap at ingest (exists) | partial + reason; charge delivered only | REAL |
| 30 | «عايز ١٠٠٠٠ تعليق وميزانيتي ٣٠٠ نقطة» | budget limit \< price | offer the size that fits (existing budget card, `budgetFit.ts`) | — | — | — | SIM |
| 31 | «أرقام موبايلات الناس اللي علّقوا على البوست ده» | private personal contact of commenters | — | none | — | **refuse** — the interpreter must not reframe it as "comments" | n/a |
| 32 | «اسحب لي اللي الناس كاتباه تحت فيديوهات عمرو أديب» | = comments on a named creator's videos | which videos / count | channel/account videos → comments | chain | — | REAL |
| 33 | TREG adds `x.tiktok.video.comments.v2` (new tool) | — | — | sync detects → `discovered`; replay stored pages → `fixture_verified`; **not** routable for customers until PR sets `production_eligible` | — | — | SIM |
| 34 | Provider renames `comments` → `items` list path | — | — | sync: fingerprint change on a carded endpoint → `broken` in PR; router uses next in fallback_group | — | stated gap if none | REAL page + mutated copy |
| 35 | Two providers give different phone numbers for one company | — | — | keep higher-tier value, record field provenance, mark conflict | dedupe by domain | never delete the record | SIM |

### 11.3 Semantic paraphrase sets (must resolve to the same intent)

- **S-A (TikTok tourism comments):** «عايز كومنتات فيديوهات تيكتوك عن السياحة» · «هات تعليقات فيديوهات تيك توك الخاصة بالسياحه» · «محتاج comments بتاعة TikTok عن السياحة» · «عاوز الكومنتس على فيديوهات السياحة في تك توك». Expected: tiktok / videos / comments≥some / topic «السياحة». (Replies only in the variant that says «والردود».)
- **S-B (contracting companies + official e-mails):** «عايز ٥٠ شركه مقاولات فمصر مع الاميلات» · «محتاج 50 contracting companies in Egypt and their official emails» · «هات ٥٠ شركة مقاولات في مصر وإيميلاتها الرسمية». Expected: companies / 50 / contracting / EG / wanted official_email (company-level).
- **S-C (non-equivalent on purpose):** «إيميلات الموظفين في شركات المقاولات» ≠ S-B — people/b2b contact path with its own policy; «إيميلات الناس اللي علقوا» → refuse.

### 11.4 Metrics and baselines

| Metric | Definition | Baseline evidence today | How to collect | Suggested acceptance (not measured) |
| --- | --- | --- | --- | --- |
| Intent accuracy | fields equal to the labelled intent | none (only `ask-requests.json`, 46 labelled) | label 150 requests (paraphrase sets + 35 scenarios + stored live requests) | ≥ 95% per field on the labelled set |
| Constraint preservation | asked items kept end-to-end into the plan | ROOT-CAUSE replay: 14/20 stored plans lost or mis-stated something (pre-fix) | replay harness | 100% (no asked item lost silently) |
| Paraphrase consistency | identical intent within a set | none | S-A/S-B sets | 100% |
| Unnecessary rejection rate | unserved/unsupported where a verified capability existed | V-DB 25 unserved; ≥ 4 examined were class (b) | classify every `unserved` weekly from `missions` | trending to 0 for class (b) |
| Clarification accuracy | questions asked only for `missing[]` affecting cost/scope/auth | none | replay | ≤ 1 card per turn; 0 questions for evidenced fields |
| Tool eligibility violations | calls refused by gateway for policy/sellable after planning | `mission_calls` refused_reason | SQL | 0 policy refusals from router-chosen tools |
| Unnecessary calls | planning calls not used by the final plan | `mission_calls` planning vs plan stages | SQL | tracked; no threshold until baseline |
| Delivered vs requested | delivered unique / requested | `missions.delivered_units` vs plan | SQL | report only (source-limited) |
| Provenance completeness | rows with `_src` and `_call` | 0% today (not stored) | after 9.1(4) | 100% |
| Cost per usable row | provider+model USD / delivered rows | derivable from `missions` + `mission_calls` | weekly report | no worse than current per family |
| Settlement correctness | charge = ceil(delivered × unit) ≤ reserve | `missions.error` mismatch notes; existing tests | SQL + tests | 0 mismatches |
| Worker interruptions | requeues by cause | run_state counters | storage/SQL | tracked |

---

## CHAPTER 12 — SECURITY AND FINANCIAL SAFEGUARDS

**Invariants preserved (verified in code):** append-only ledger (triggers `block_ledger_mutation/truncate`), deterministic ids `res_/rel_/chg_<job>`, release-first `settle_job_atomic`, `LEAST(CEIL(units×unit), reserve, cap)`, no charge before `accept_quote_atomic`, money RPCs `service_role` only, the model never prices (`tools.ts:573` "You never state a price", `price.ts:10`), provider spend reserved before every call.

| New risk | Mitigation |
| --- | --- |
| Dynamic discovery activates a paid tool | discovery writes only `discovered`; `production_eligible` only via reviewed PR; worker loads a pinned registry; derived tools stay `catalog_only` + `CATALOG_ONLY_CAP_USD` for test accounts (existing) |
| Interpreter reframes a sensitive request | privacy guard on original text AND intent; union rule (model can't remove constraints, can't relabel); regression tests #19, #31, S-C |
| Prompt injection from crawled pages (web extract, reviews, comments) | provider content never enters a model prompt that can call tools; review model receives rows as data with forced tool output (exists: `review.ts` forced `verdicts`); planner gets shape digests only (exists); strip/escape instructions in extracted markdown before any model sees it; never follow links from content |
| Agent-selected tools | model chooses only among validated candidates (exists in `modelSelector`); gateway re-checks everything |
| Cross-provider enrichment of people | contact fields only through `b2b_contact` policy endpoints and existing verification (`contacts.ts` company-domain rule); never personal mailboxes |
| Schema changes | fingerprint + replay before eligibility; broken → fallback/stated gap |
| Retries/failover cost | one retry, one fallback read, all inside `JobCallBudget` |
| Multi-provider accounting | per-provider daily caps (exist); add `provider_cost_id` on web calls; no new money writes |
| Secrets | Heroku key fix must use the same secret mechanism as TREG's pool (Vault-encrypted key fetched by service role) rather than copying a Vercel sensitive var; never log keys |
| Provider terms | Firecrawl/Context.dev terms forbid unlawful personal-data processing and note public ≠ reusable; TREG binds to upstream terms V-DOC-EXT → keep `data_policy` and privacy guard as hard filters |

Owner approval required for: F1 watchdog/lease fix, F2 baseline migrations, any change to caps, the Heroku secret change, enabling any new provider path for customers.

---

## CHAPTER 13 — PERFORMANCE AND RELIABILITY

**Measured V-DB:**

- Social planning model cost is now ≈ 0.0001–0.0002 USD/mission (compiled path); planning provider cost 0.0005–0.0928 USD (Facebook keyword search via `justoneapi` is the outlier: 51 planning calls cost 1.21 USD ≈ 0.024 USD/call).
- Unserved-by-routing missions end in \~1 s with no spend (good: cheap refusals; bad: they are often wrong).
- Worker RSS \~221–256 MB on a 512 MB dyno, 192 MB heap flag; 0 active missions at audit time.
- Call reliability (Diger's own, "ok" = HTTP success): anyapi execution 98.6% (1,166/1,183); tikhub execution 98.6%; scrapecreators execution 89%; crawl4ai planning 59%; aviato execution 62%; blitzapi execution 60%.

**Reported, not re-measured:** legacy model planning median 86 s, p90 219 s, tail to 598 s (AUDIT-2026-11 G14, driven by output tokens).

**Known bottlenecks V-CODE:** single mission at a time (`AGENT_CONCURRENCY` default 1), so a long execution blocks every other customer's planning; mixed-provider stage disables the deterministic engine; 2-sample planning cap limits candidate choice; job lease not renewed (F1).

**Hypotheses (unverified):** queue wait will dominate perceived latency as real customers grow; LLM-executed fallback missions are the slowest and costliest path.

**Improvements:** interpreter runs once per mission on the worker (no extra Vercel time); deterministic routing for fully understood intents (no model in routing); cache registry in memory (as the snapshot is); per-stage engine dispatch (§9.1); raise `AGENT_CONCURRENCY` to 2 only after memory measurement (existing guards at 300/580 MB); reuse validated plans for identical intents within a short window only if the owner approves (pricing implications).

---

## CHAPTER 14 — PRIORITIZED IMPLEMENTATION ROADMAP (for a cheaper coding model)

**Ordering rationale:** understanding fixes give the largest customer impact at the lowest risk and touch no provider or money code, so they come first. Provider work starts with the zero-credential path (endpoints TREG already resells). The engine change waits for a registry to drive it. Financial fixes run on a separate, owner-approved track.

**Rules for every PR (future coding agent):** read `README.md` and the top rounds of `docs/HANDOFF.md` first; branch from the then-current `main`; one focused PR per task; regression tests first (red), then code; run `npm ci`, `npm test`, `npm run agent:typecheck`, `npx tsc --noEmit`, `npm run build` (includes the client-bundle secret scan); never weaken or delete a test; never push to `main`; keep every `*flags-off*` fixture byte-identical; review the exact diff and head SHA before merge; merge only with green checks **and** `agent_worker_heartbeat.active_missions = 0` and no mission `executing`; afterwards verify Vercel production SHA = merge SHA and record the Heroku release; report anything unverifiable. **There is no GitHub Actions CI** — run the suite locally and paste the summary into the PR.

Complexity: S (\< 1 day) / M (days) / L (several PRs). "Owner" = explicit owner approval required.

#### PHASE 0 — Baseline and harness (no behaviour change)

- **PR-0.1 Semantic regression harness** (tests only) — Chapter 16 brief #1. S. Owner: no.
- **PR-0.2 Worker version in heartbeat:** write `HEROKU_SLUG_COMMIT ?? SOURCE_VERSION ?? "dev"` into `agent_worker_heartbeat.version` (`agent/src/worker.ts`). Unit test on the resolver. S. Owner: enable Heroku dyno metadata.
- **PR-0.3 Unserved classifier report:** read-only script `scripts/reports/unserved.ts` (SELECT only) classifying each `unserved` mission as (a)/(b)/(c) with its routing reason. S. Owner: no.

#### PHASE 1 — Semantic understanding

- **PR-1.1 Shared lexicon + normalization behind `ask_lexicon`** — brief #2. M. Owner: flag flip.
- **PR-1.2 Pre-filter and silent-drop guards** — brief #3. M. Owner: flag flip.
- **PR-1.3 `ResearchIntent` interpreter, offline shadow:** `src/lib/intent/{types,interpret,reconcile}.ts`; forced-tool Haiku call in `agent/src/intent.ts` (not wired into planning); recorded fixtures `tests/fixtures/intent-recorded/*.json`; shadow diff test; flag `intent_interpreter` (off|shadow|test|on). Tests: union rule, evidence downgrade, privacy invariants (#19, #31, S-C), flags-off digests. M. Owner: **yes** — spend to record fixtures (estimate ≤ 0.05 USD).
- **PR-1.4 Interpreter in `test` mode + multi-turn patching:** Ask built from reconciled intent; answers/edits patch fields; latest correction wins; fixes W8/W9. M. Owner: flag flip.
- **PR-1.5 K3 re-route:** `agent/src/tools.ts:584-589` returns a structured "social part" signal instead of ending the request; `runMission` sends that part to the compiled path or states it as not included; company "social links" become an enrichment field. M. Owner: no.

#### PHASE 2 — Provider integration readiness

- **PR-2.1 Web via TREG (test accounts):** registry/card entries for `treg.web.extract`, `branddev.brand.retrieve-by-name`, `branddev.web.search`, `firecrawl.web.search` (TREG ids → existing gateway, key, caps, ledger); the companies path may plan an enrichment stage with them; flag `web_via_treg`. Tests: gateway untouched, policy check, flags-off identical. M. Owner: flag + one capped live capture (≤ 0.20 USD).
- **PR-2.2 Hygiene:** `webAvailability.ts` checks key **and** cap > 0; refresh dated price constants (`multiProvider/catalog.ts`, `agentMission/sources.ts`); drop `firecrawl.extract` (removed upstream 2026-12-10); list Context.dev `reddit-*`, `yelp-*`, `tripadvisor-reviews` parsers as `discovered` only. S. Owner: no.
- **PR-2.3 Direct-key path for the worker (decision D3):** Firecrawl/Context.dev keys under the Vault-encrypted scheme the TREG pool already uses (`tregKeyPool.ts:188-192`) instead of copying `PROVIDER_KEYS_ENCRYPTION_KEY`. M. Owner: **yes** (secrets, migration).
- **PR-2.4 Web-call accounting:** set `provider_cost_id` on web `mission_calls` rows; provider label in admin traces. S. Owner: no.

#### PHASE 3 — Verified capability registry

- **PR-3.1 Registry generator (pure):** `scripts/capabilities/build-registry.ts` → `data/capabilities/registry.json` from TREG snapshot + data policy + ToolCards + `sources.ts`, with fingerprints and statuses; tests: every carded endpoint present, no blocked/sensitive endpoint eligible. M.
- **PR-3.2 Statuses wired to `toolCards/verify.ts`;** `production_eligible` only from an explicit reviewed list. S.
- **PR-3.3 Reliability report** from `mission_calls` (read-only) into registry PRs. S.
- **PR-3.4 Recover `scripts/treg/build-data-policy.mjs`** (test reproduces `data_policy.json`). M.

#### PHASE 4 — Intelligent tool routing

- **PR-4.1** add `topic/keyword` coverage class (`toolProfile.ts`); wire `rankByCoverage` (`sourceRanking.ts:248`) into ranking behind `registry_router`; the 20 replay missions must stay identical except asserted improvements. M.
- **PR-4.2…4.6 Family cards** (data PRs, each with one capped live capture → owner): places search (`crawl4ai.google.serp.maps`), place reviews (`treg.google.maps.reviews`), TikTok/Instagram public profile, Instagram topic search for all accounts (promote discovery cards), Reddit (`crawl4ai.reddit.search.posts`, `crawl4ai.reddit.post.comments`) + `reddit` in the platform lexicon (removes the accidental companies route). S–M each.

#### PHASE 5 — Multi-provider execution

- **PR-5.1 `SourceGateway` + per-stage engine dispatch** (`engine/run.ts`, `spec.ts`, `runMission.ts:627`) behind `multi_stage_engine`; existing engine replays unchanged. L.
- **PR-5.2 Row provenance marks** (`_src`, `_call`; admin-only). S.
- **PR-5.3 Exclusion/enrichment files reach missions;** exclusion = ingest filter; enrichment = parent list. M.

#### PHASE 6 — Provider update intelligence

- **PR-6.1 Weekly read-only sync script + drift report** (§7.4). M.
- **PR-6.2 Breaking change → `broken` + fallback test.** S.

#### PHASE 7 — Regression and shadow evaluation (continuous from Phase 1)

- **PR-7.1 Admin-only shadow diff view** of interpreter events. S. Live shadow needs an owner-approved daily cap.

#### PHASE 8 — Controlled activation

Offline → test account → owner acceptance missions under a ceiling → `on` per family/platform. Rollback = flag `off`. Never deploy during active execution.

#### FINANCIAL TRACK (isolated; owner brief for each)

- **PR-F1** renew the mission job lease from the heartbeat **or** exclude `agent-mission` jobs from the watchdog; test reproduces the 6 h 30 m race. S–M.
- **PR-F2** baseline migrations for `missions`, `mission_calls`, `agent_claim_mission`, 25,000-cap SQL as already applied (verify read-only first). M.

| Phase | Objective | Flags | Rollback | Size | Owner approval |
| --- | --- | --- | --- | --- | --- |
| 0 | baseline, harness, version | none | revert | S | dyno metadata |
| 1 | meaning-first understanding | `ask_lexicon`, `prefilter_v2`, `intent_interpreter` | flag off | M | fixture spend, flips |
| 2 | providers reachable safely | `web_via_treg` | flag off | M | secrets, captures |
| 3 | registry | data only | revert | M | eligibility list |
| 4 | routing + family cards | `registry_router` | flag off | M | captures |
| 5 | multi-provider engine | `multi_stage_engine` | flag off | L | no |
| 6 | update intelligence | none | revert | M | no |
| 7 | shadow evaluation | `intent_interpreter=shadow` | flag off | S | live cap |
| 8 | activation | all | flag off | — | yes |
| F | financial fixes | — | revert | S–M | **yes** |

---

## CHAPTER 15 — DEPENDENCIES AND DECISIONS

**Blocking order:** PR-0.1 → any Phase 1 PR; PR-1.1 → PR-1.3; PR-3.1 → PR-4.1 and PR-5.1; PR-2.3 (or decision "stay TREG-only") → any direct Context.dev parser; PR-F2 → any new migration.

**Owner decisions (one-line recommendation each):**

- **D1** Lift «TREG only for now» (REDESIGN.md:54)? → Yes, first **through TREG-resold endpoints** (no new key path).
- **D2** One Haiku interpreter call per mission (≈ 0.0004 USD estimate, to be measured)? → Yes, after offline shadow passes.
- **D3** Direct Firecrawl/Context.dev keys on the worker (Vault scheme) vs. TREG-only? → Vault scheme, only for Context.dev parsers/People Search lacking a verified TREG equivalent.
- **D4** Spend for recorded interpreter fixtures (≤ 0.05 USD) and capped captures per new card (≤ 0.20 USD)? → Approve per PR.
- **D5** Live shadow on real traffic with a daily cap? → After two weeks of test-account use.
- **D6** Financial PRs F1/F2? → Yes, before raising customer volume.
- **D7** Which families become sold services (places, reviews, Reddit, enrichment)? → Owner approves the service list; pricing formula unchanged.

**Open questions:** Heroku env (`PROVIDER_KEYS_ENCRYPTION_KEY`, `DIGER_STAGE3_COMPANIES`, `AGENT_CONCURRENCY`); effective TREG daily cap (10 vs 0.80); whether the chat model call succeeds in production; whether the 25,000-cap SQL and `agent_claim_mission` live definitions match the proposals.

---

## CHAPTER 16 — IMPLEMENTATION HANDOFF (first three PRs — planning only, NOT executed)

### Brief #1 — PR-0.1 «Semantic regression harness» (tests only)

- **Goal:** pin current understanding behaviour and list every known gap so later PRs prove improvements. **No source change.**
- **Read first:** `README.md`; top of `docs/HANDOFF.md`; `src/lib/agentMission/{requestContract,requestConditions,platformQuestion,messageType,guardRules}.ts`; `src/lib/agentMission/foundation/ask.ts`; `src/functions/shared/briefManager.ts` (`isGreetingOrGeneralQuestion`); `src/lib/assistantIdentity.ts`; `tests/fixtures/{ask-requests,understanding-requests}.json`.
- **Add:** `tests/fixtures/semantic-paraphrases.json` (\~80 entries: `{id, text, expected:{platform, kind, comments, replies, topic, country, period_present, language, count, route, prefilter}, known_gap?}`) covering S-A/S-B/S-C, every row of §3.3/§3.4, and the 35 scenario texts; `tests/semantic-paraphrases.test.ts` calling the pure functions (`buildRequestContract`, `buildAsk`, `legacyRouteOf`, `classifyMessage`, `isGreetingOrGeneralQuestion`, `identityQuestionKind`, `preModelAnswer`). Known gaps use vitest `it.fails` so the suite stays green and the gap list is explicit; a later fix turns it red and it must become a normal assertion.
- **Constraints:** no network/model/DB; no source or existing-test edits.
- **Acceptance:** suite green; ≥ 20 `known_gap` cases including «كومنتات», «comments», «تك توك», «انستاجرام», «Twitter», «فمصر», «اخر ٣ شهور», «السعوديه», «الخاصة بالسياحه», «عميل» (false e-mail), «…من انتخابات… تيك توك», «تعليقات تيك توك عن ChatGPT», «مكاتب شحن», «حملات النصب»; privacy cases #19/#31 asserted **refused**.
- **Rollback:** delete the two files.

### Brief #2 — PR-1.1 «Shared Arabic lexicon + normalization» (flag `ask_lexicon`, default off)

- **Goal:** one lexicon + one matching-normalizer for the contract, conditions, Ask comment numbers and chat keyword classifier; fixes L1–L4, L6, L7 when on.
- **New `src/lib/agentMission/lexicon.ts` (pure):** `matchingCopy(text)` folds أ/إ/آ→ا, ى→ي, ة→ه, strips tatweel/diacritics, Arabic-Indic→ASCII digits, separates fused `ف/ب/ل/و` before known country/platform names — **the original text is still what is sent to providers as the topic/keyword**. Lexicons: TikTok (`تيك ?توك|تيكتوك|تك ?توك|tik ?-?tok|tiktok`), Instagram (`انستجرام|انستغرام|انستاجرام|انستقرام|انستا|insta(gram)?`), Facebook (`فيس ?بوك|الفيس|facebook|\bfb\b`), YouTube (`يوتيوب|يوتوب|youtube`), X (`اكس|إكس|\bX\b|تويتر|twitter|tweets?|تغريد|تويت`, case-insensitive), Reddit (`ريديت|ريدت|reddit` — recognised, not compiled → clarify path); comments (`تعليق|كومنت(ات|س)?|comments?`); replies (existing + `ريبلاي(ز)?|replies`); e-mail without bare `ميل`; country with `(في|من|داخل|ف|ب)\s*`; period with `اخر|آخر` + number words.
- **Change:** optional `opts?: {lexicon?: "v1"|"v2"}` on `buildRequestContract`, `conditionsOfRequest`, `buildAsk`, `classifyMessage`; default `"v1"` is byte-identical to today. Worker reads `agent_settings.intelligence_flags.ask_lexicon` (`off|test|on`, unknown = off) once per run (pattern of `readRedesignFlags`); the web side reads it through the existing cached settings reader.
- **Tests:** PR-0.1 gaps L1–L4/L6/L7 pass under v2 and remain `it.fails` under v1; all flags-off fixtures identical; the 20 replay missions identical under v2 except asserted improvements; `matchingCopy` idempotent; provider keyword keeps the customer's spelling.
- **Acceptance:** suite green; zero change with the flag off. Enabling (owner, not the PR): `insert into agent_settings(key,value) values('intelligence_flags','{"ask_lexicon":"test"}') on conflict (key) do update set value = agent_settings.value || excluded.value;`
- **Security/finance:** none. **Rollback:** flag off.

### Brief #3 — PR-1.2 «Pre-filter and silent-drop guards» (flag `prefilter_v2`, default off)

- **Goal:** remove verified class-(b) interceptions and silent drops that need no model.
- **Scope (one commit + test each):**
  1. `briefManager.ts`: a general question only if the trimmed message is ≤ 40 chars or the pattern matches the whole message, **and** no platform/data noun is present. (If the reviewer treats this region as owner-protected per Round 24, stop and ask.)
  2. `assistantIdentity.ts`: require second-person + vendor (`انت|إنت|انتو|you` … `gpt|كلود|…`) or `بتستخدم|مبني على`.
  3. `guardRules.ts`: top-up only with a wallet word (`رصيد|نقاط|محفظة|محفظه`); trust answer only when Diger is the subject (`انتو|المنصة|المنصه|الموقع ده|ديجر|diger`). **Privacy rules unchanged.**
  4. `researchPlaceholders.ts`: reject only pure template tokens (`[الموضوع]`, `[العدد]`, `<count>`, `<topic>`).
  5. **Topic card:** compiled path with `topic === null` and no named source asks «عن أي موضوع تحب أجمع؟» (new kind `topic` in `stage2/questionCards.ts`) instead of reading a keyword-less pool.
  6. `compilePlan.ts:619-625`: when replies are asked but comments were not detected, say that comments were not detected (offer to add them), not «لا توجد أداة موثّقة لقراءة الردود».
  7. Exclusion upload: until PR-5.3, the chat confirmation says the file is saved but **not yet applied** to research.
- **Tests:** W1–W6 and L5 gaps pass with the flag on; privacy refusals (#19, #31, «رسائل خاصة», «الرقم القومي») refused with the flag on **and** off; flags-off fixtures identical; e2e: TikTok request without a topic → topic card, zero provider calls.
- **Acceptance:** suite green; no money/gateway file touched; customer text Arabic only, no provider names.
- **Rollback:** flag off.

---

## CHAPTER 17 — FINAL ARCHITECTURAL RECOMMENDATION

**One architecture: «Meaning-first Ask on the existing compiled foundation, TREG as the primary gateway, plus a verified provider-neutral registry».**

```
Customer ─► chat (anchored pre-filters) ─► Haiku: type + ResearchIntent (reads meaning)
                                   │
              reconcile with regex contract (union, evidence spans, privacy on both)
                                   │
          clarify only missing[] affecting cost/scope/authorization (existing cards)
                                   │
   Ask (from intent) ─► pinned verified registry ─► router (hard filters → lexicographic rank)
                                   │
   compilePlan (existing) ─► priceMissionByCode (unchanged) ─► card ─► approval (unchanged SQL)
                                   │
   engine, per-stage SourceGateway: treg_call (unchanged) | webGateway (direct, optional)
                                   │
   ingest (+provenance) ─► workbook/methodology ─► settle (unchanged) ─► notify
                                   ▲
   weekly read-only sync ─► registry PR (discovered → fixture_verified → production_eligible)
```

**Why it fits:** it keeps everything the last 445 PRs proved (compiled path, verify-on-real-pages, gateway checks, code pricing, atomic SQL money, item store, flags-off invariance); it fixes the real root cause (meaning read only by regex) with one small model call whose output code checks; it opens Firecrawl and Context.dev capabilities with zero new credential or ledger risk via endpoints TREG already resells; it adds no framework, no microservice, no paid monitoring; every step is a flag with instant rollback.

**Rejected alternatives:** (1) return plan composition to the model — repeats the 30-round failure in ROOT-CAUSE/FOUNDATION-PLAN; (2) a new agent framework/orchestrator — duplicates worker, leases, gateway and settlement and loses existing money-invariant test coverage; (3) direct-provider-first — new secret path, caps and accounting for capabilities TREG already offers with observed reliability; (4) a bigger model — today the model is not asked to understand meaning, so a bigger one changes nothing.

### Component verdicts (brief §18)

| Component | Verdict | Reason |
| --- | --- | --- |
| `requestContract.ts`, `requestConditions.ts` | EXTEND (lexicon v2) | gate idea right, lexicon too narrow |
| `foundation/ask.ts` | EXTEND (built from intent) | the central record already exists |
| `chatModel.ts`, `conversationModel.ts` | EXTEND (intent output) | model already called; understanding discarded |
| pre-filters (`briefManager`, `assistantIdentity`, non-privacy `guardRules`) | REPAIR | unanchored / over-broad |
| privacy rules in `guardRules` | LEAVE UNTOUCHED (+tests) | legitimate guard |
| `platformQuestion.ts` `legacyRouteOf` | REPAIR | companies-before-platform misroute |
| `foundation/toolCards/*`, `verify.ts` | REUSE AS IS → feed registry | proven verification |
| `discovery/*` | EXTEND (web roles, statuses) | right shape, TREG-only |
| `compilePlan.ts`, `agent/src/compiled.ts` | EXTEND (topic card, notes) | production path |
| `agent/src/gateway.ts` | LEAVE UNTOUCHED | protected, verified |
| `agent/src/webGateway.ts` + adapters | REUSE after key fix; REPAIR accounting | implemented, unreachable |
| `engine/run.ts`, `engine/spec.ts` | EXTEND (SourceGateway, per-stage) | TREG-only blocker |
| legacy `multiProvider` chain, `multiStepOrchestrator.ts` | DEPRECATE LATER | bypassed / tests only |
| `capability_registry` table | LEAVE UNTOUCHED (sold-services list) | distinct from internal registry |
| `price.ts`, `missionPricing.ts`, `finalize.ts`, SQL money, `approval.ts`, `lifecycle.ts` | LEAVE UNTOUCHED | invariants; financial track only |
| `/api/cron/watchdog` | REPAIR (F1, owner) | lease race |
| TREG snapshot loader | REUSE + sync | pinned; stale |
| `data_policy.json` | REUSE; recover generator | hard filter |
| `exclusionFileParser.ts` | REUSE; wire into missions | parsed, unused |
| `src/lib/modelPlanner/*` | LEAVE UNTOUCHED | legacy rollback path |

---

## FINAL ANSWERS

1. **Why mainly TREG?** Owner scope («TREG only for now», `docs/REDESIGN.md:54`); the compiled social path, its cards, discovery and the deterministic engine call only `treg_call`; the worker cannot decrypt the direct Firecrawl/Context.dev keys; coverage = hand cards built from the TREG snapshot.
2. **Are Firecrawl and Context.dev usable by the production agent?** Directly: **no** — 71/71 recorded calls refused `source_unavailable` (last 2026-10-30); tools now hidden when no key resolves. Via TREG: **technically yes** — `firecrawl.web.*` and `branddev.*` (Context.dev's former name) are sellable, policy-public TREG endpoints, but no plan has ever chosen them (0 calls).
3. **What prevents selection?** No worker-side key; TREG-only compiled path and engine; no card/role for `web.*` or company enrichment; only the companies path's model planner could pick them; that planner ends any plan touching a social endpoint.
4. **Does the LLM understand semantically?** It is not asked to: it labels the message type; meaning is extracted by regex and its reading is discarded.
5. **Why does harmless wording cause rejection?** Narrow raw-text lexicons (كومنتات/comments, تك توك, انستاجرام, فمصر, اخر, topic markers), unanchored pre-filters («من انت» inside «من انتخابات»), regex routing that ends requests, missing card shapes reported as "unsupported", answers that replace instead of patch.
6. **Improvements that keep safeguards?** Shared lexicon + normalization; anchored pre-filters; topic card; `ResearchIntent` with union reconciliation, evidence spans and privacy checks on original text and intent; field-level multi-turn patching.
7. **How to choose among providers?** Hard filters (capability, policy, verification, inputs, key/cap, health) → lexicographic rank (constraint coverage → evidence tier → Diger-measured usable yield → cost per usable row → latency). TREG-resold route first for web search/extract/enrichment; Context.dev direct only for parsers/people search with no verified TREG equivalent; Firecrawl only where it uniquely carries a constraint (its TREG-observed scrape success is the lowest, 0.40).
8. **When to combine?** Dependent operations (discover → enrich → extract) or multiple platforms; parallel only to complete a short count under the same budget; never by default.
9. **Staying aware of updates?** Weekly read-only sync: TREG `/catalog/search?added_within_days=…`, `/catalog/endpoints/{id}`, `/meta`; Firecrawl/Context.dev OpenAPI hashes and changelog RSS; Firecrawl GitHub releases Atom; diffs land as registry PRs.
10. **Preventing breakage?** Pinned registry; schema fingerprints; replay of stored real pages before eligibility; `broken` → fallback group or stated gap; no runtime auto-activation; flags-off digests.
11. **Preserving production?** `off|shadow|test|on` flags, byte-identical flags-off fixtures, offline replay (39 live fixtures, 20 replay missions, 86 labelled requests), test-account rollout, deploy only with zero active missions, rollback by flag.
12. **Best improvement for least risk/cost?** PR-1.1 lexicon/normalization and PR-1.2 pre-filters + topic card + honest file message; then PR-2.1 web via TREG.
13. **Implement first?** PR-0.1 harness → PR-1.1 → PR-1.2 (Chapter 16).
14. **Approvals needed?** D1–D7, every flag flip to `on`, the financial track.
15. **Not independently verified:** Heroku commit and env; whether the chat model call succeeds in production; effective TREG daily cap (10 vs 0.80); live definitions of the 25,000-cap SQL and `agent_claim_mission`; delivered files and raw pages (Storage); real-customer behaviour (235/239 missions from one account); runtime output of the regexes on the example sentences (derived by reading, not execution).

### Five most important findings (by customer impact)

1. Meaning is read only by narrow regex and the model's understanding is discarded → silent loss of comments/topic/country/period and misroutes (`requestContract.ts:150`, `conversationModel.ts`).
2. Unanchored chat pre-filters and over-broad guards divert real research requests away from the agent (W2, W3, W5, W6).
3. "Missing card shape" is told to customers as "unsupported" although verified TREG capabilities exist (Instagram topic, TikTok profile, places, reviews, Reddit).
4. Uploaded exclusion files are confirmed to the customer but never applied (X1).
5. Firecrawl/Context.dev direct integrations are dead in production (71/71 refused) while the same capabilities sit unused inside TREG; the TREG-only engine blocks mixed plans.

### Minimum viable path

PR-0.1 → PR-1.1 (test) → PR-1.2 (test) → owner acceptance on the test account → flags `on` → PR-1.3/1.4 interpreter (shadow → test) → PR-3.1 registry → PR-2.1 web via TREG + PR-4.1 coverage routing → PR-4.x family cards → PR-5.1 per-stage SourceGateway → PR-2.3 direct key only if a needed parser is missing from TREG → PR-6.1 weekly sync. Financial track F1/F2 in parallel under owner briefs.

### Five lines for the owner

1. المُثبت: المنصة شغالة من الطلب للملف للتسوية على الخمس منصات، والفلوس محمية بالكود والقاعدة، وVercel مطابق لآخر دمج.
2. الناقص: الفهم ماشي بكلمات ثابتة فـ«كومنتات» و«تك توك» و«فمصر» بيضيعوا بصمت، وFirecrawl وContext.dev عمرهم ما اشتغلوا فعليًا من Heroku.
3. الحل: الموديل يقرا المعنى في سجل منظم والكود يراجعه ويقرر، وسجل أدوات موثّقة للتلات مزودين، ونشغّل Firecrawl وContext.dev الأول من جوه TREG.
4. أهم خطر: أي تعديل في الفهم ممكن يغيّر خطط شغالة، فلازم كل حاجة وراء مفتاح مقفول وتتجرب على المهام المحفوظة قبل أي عميل.
5. أول خطوة: PR اختبارات بس يثبّت حوالي ٨٠ صيغة طلب ويحدد كل نقطة فهم غلط، من غير ما يغيّر أي سطر في الإنتاج.

---

### Appendix A — read-only queries run this session

Supabase (SELECT only): `agent_settings` (secret-like keys redacted); `information_schema.columns` for 9 tables; `mission_calls` grouped by provider prefix/phase; `provider_api_keys` (provider, has-key boolean, date, version — no ciphertext); `settings_private`/`settings_public` (redacted); `mission_calls` for `firecrawl%`/`contextdev%` by status/refusal; `agent_worker_heartbeat` (last 5); `missions` by status; unserved/failed missions (truncated text); `mission_events` for three unserved missions; missions per user (md5 only); latest 25 missions; `llm_usage` by model/reason; `capability_registry`. Vercel: `list_projects`, `list_deployments` (production, 3). GitHub: `list_pull_requests` (open; recent closed). Provider documentation: public pages only, no API calls.

### Appendix B — existing financial-invariant tests (names; not run)

`agent-price-and-settlement`, `engine-settlement`, `quantity-and-settlement`, `replica-money-properties`, `standard-request-price`, `cap-25000-default`, `job-call-budget`, `agent-planning-budget`, `provider-call-caps`, `ledger`, `atomic-reserve-concurrency.mock`, `release-integration`, `money-migrations`, `explicit-quote-approval`, `quote-hash-binding`, `accept-quote-concurrency`, `money7a-*`, `stage4-concurrency-approval`, `agent-gateway`, `agent-web-gateway`, `execution-restart-replay`, `multi-provider-*`; SQL replica/local-pg suites in `tests/sql/` (reported to skip in the normal run).

*End of report. Nothing was implemented. Awaiting owner approval for the next phase.*

Prepared from the repository at commit 001cbeb, read-only production queries, Vercel deployment records and the providers' public documentation. Heroku state and Supabase Storage were not accessible.