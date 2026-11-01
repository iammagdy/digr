# The 10 Antigravity benchmark requests

Supplied by the owner on 2026-11-01 (decision D10 of `docs/REDESIGN-PLAN.md`). Used by `docs/REDESIGN-PLAN.md` section 3 (SP-LIVE step 3) and by the harness of item 0.2: after every stage merges, each request is run as the TEST account in flag `test` mode, and its result is compared with the shape below.

The request text is what the customer types (Arabic). The English line under it is a description for engineers only and is never shown to a customer. "Minimum size" is the smallest run that proves the shape; it is not a limit.

## Checks that apply to EVERY request

1. **Delivered count equals the approved count.** The approved count is the one on the plan card (top-level items; replies are in addition and priced, `docs/AUDIT-2026-11.md` section 1C). A shortfall is allowed only with the code-computed truthful reason in the file and a charge for what was delivered.
2. **Comments are linked to their parent** (parent link and title on every comment row; zero orphans).
3. **Replies are present where the platform supports them** (replies sit under their comment, parent comment id on a reply). Where the platform has no reply source the plan can feed (Facebook, YouTube, LinkedIn, Reddit: `docs/HANDOFF.md:41`), the plan card must say so before approval (decision D7) and the file must not pretend otherwise. If the cross-tool search of item 1.5 finds a source that can, replies must be delivered.
4. **No provider names, endpoint ids, USD amounts or model vendor** in any customer text (plan card, notebook line, preview headers, notices, file text).
5. **Arabic only, Arabic-Indic numerals, no emoji** in customer text.
6. **Raw delivery:** nothing is dropped except an exact duplicate (same record id; for companies the same provider id or domain; for people the same profile URL or the same normalised name at the same company). Same text from different people is kept. Conditions the tool could not enforce appear as mark columns, not as missing rows.
7. **The request was built by code** from the understood record: the stored recipe records `built_by = code`, and every condition the chosen tool has a field for (date, language, country, account, count, replies, sort) is in the tool input.
8. **A condition the chosen tool cannot express** (date, topic, language, country): the agent first tried every other candidate tool; if none can, the plan card says so before approval and the customer chose.
9. **Nothing is spent before approval;** ledger rows `res_ / rel_ / chg_` balance for the mission; charge = ceil(delivered x unit), never above the reserve.
10. **Live sheet:** rows appear while the job runs (desktop sheet, mobile cards), the counter reads «X من N», and the final file's rows equal the rows watched.

---

## 1. Facebook: a page's posts about a topic, with all comments and replies

- **Request (Arabic):** «هات منشورات صفحة العربية على فيسبوك عن [الموضوع] آخر ٣ شهور، ومع كل منشور كل التعليقات وكل الردود عليها»
- **Topic:** chosen by whoever runs the test (suggested: «الذكاء الاصطناعي»); the same topic is used for every run so results are comparable.
- **Minimum size:** 2 posts.
- **Expected shape:**
  - Posts sheet: text, date and time, link, page, likes, comments, shares. Both posts are from the Al Arabiya page and fall in the last three months (period is a tool input where the tool has one; otherwise a mark «ضمن الفترة المطلوبة»).
  - Comments sheet: **every** comment of each post (the count on each post is stated next to what was delivered), parent post link and title on every row.
  - Replies: Facebook has no reply source the plan can feed (`docs/HANDOFF.md:41`). Expected: the plan card says so before approval; the customer chooses. Not expected: silently missing replies.
- **Watch for:** a page named in Arabic being matched by name only; comments of a post read to only one page.

## 2. YouTube: videos of an event from official broadcaster channels, with all comments and replies

- **Request (Arabic):** «هات فيديوهات نهائي كأس السوبر المصري بين الأهلي والزمالك من القنوات الرسمية للقنوات الناقلة، ومع كل فيديو كل التعليقات وكل الردود»
- **Minimum size:** 2 videos.
- **Expected shape:**
  - Videos sheet: title, channel, date, link, views, likes, comments. Both videos come from official broadcaster channels (account/channel is a tool input or the named-source mark «المصدر المسمّى»).
  - Comments sheet: all comments, parent video link and title on every row, comment date (relative dates converted to an approximate day with «تقريبًا»).
  - Replies: YouTube replies need a continuation token only the comment's own page carries (`docs/HANDOFF.md:41`). Expected: the plan card says so before approval unless another tool in the catalog can supply them.
- **Watch for:** unofficial re-uploads; a video with comments turned off (no paid fetch for a counter of 0).

## 3. TikTok: Arabic videos about a keyword, with all comments and replies

- **Request (Arabic):** «هات فيديوهات تيك توك بالعربي عن الذكاء الاصطناعي، من مصر أو المنطقة العربية، ومع كل فيديو كل التعليقات وكل الردود»
- **Keyword:** «الذكاء الاصطناعي». **Minimum size:** 2 videos.
- **Known failure to avoid:** an unfiltered search returned an English baby-names video. Expected: the region and language conditions go into the tool's own fields where it has them (`region`; date and sort presets where present); a video in another language, if the tool cannot filter it, is delivered only with the «لغة النص» mark and the plan card has said so before approval.
- **Expected shape:**
  - Videos sheet: link, description, author, date, views, likes, comments, shares.
  - Comments sheet: all comments, parent video link and title on every row.
  - Replies: TikTok has a usable reply source (`docs/HANDOFF.md:36`); every comment whose own reply counter is above zero has its replies, each right under its comment; a comment with counter 0 is never read.

## 4. Instagram: an account's posts with all comments and replies

- **Request (Arabic):** «هات منشورات حساب @alhadath على إنستجرام، ومع كل منشور كل التعليقات وكل الردود»
- **Minimum size:** 2 posts.
- **Expected shape:**
  - Posts sheet: text, kind, date and time, likes, comments, link, account. Both posts are from @alhadath (account is a tool input).
  - Comments sheet: all comments, parent post link and title on every row.
  - Replies: Instagram has reply sources (`docs/HANDOFF.md:37`); replies under their comment, parent comment id on a reply.
- **Watch for:** the account listing returning only the 12 latest posts without a session (`docs/AUDIT-2026-11.md` G11); with 2 posts requested this must not matter.

## 5. X: posts with a keyword, Arabic, one month, replies included

- **Request (Arabic):** «هات ٢٠ تغريدة فيها «العاصمة الإدارية» بالعربي في أكتوبر ٢٠٢٦، مع الردود»
- **Minimum size:** 20 posts.
- **Reference good request (what the code-built request should equal):** a query for `العاصمة الإدارية` with `since:` and `until:` (October 2026) and `lang:ar`, with `queryType` set to `Latest`, on the X search endpoint that documents those operators.
- **Expected shape:**
  - 20 rows: account, text, date and time, link, likes, reposts, replies, quotes, views; all dated in October 2026 and in Arabic (conditions in the query; the marks «ضمن الفترة المطلوبة» and «لغة النص» confirm it row by row).
  - "With replies" means replies are NOT excluded: a row that is a reply is delivered and marked «رد أم أصلي». X has no nested reply endpoint (`docs/HANDOFF.md:42`).
  - Delivered 20 of 20 (paged until the count is reached).
- **Watch for:** the cheaper endpoint that refuses topic queries without a login (`SESSION_RESTRICTED_SOURCES`); it must lose the ranking to one that works.

## 6. LinkedIn: people who post about a topic, with profile data and latest posts

- **Request (Arabic):** «هات ٢ من الأشخاص في مصر اللي بينشروا عن الطاقة المتجددة، مع بيانات ملفهم الشخصي وآخر منشوراتهم»
- **Minimum size:** 2 people.
- **Expected shape:**
  - People sheet: name, headline/title, company, place, profile link; posts sheet: each person's latest posts (text, date, link) linked to the person.
  - Both people are in Egypt (country as a tool input where the tool has one, else the mark «المكان»).
  - If no catalog source serves "people by what they post", the plan card says so honestly before approval (D7); a made-up person is never delivered.

## 7. Google Maps: places

- **Request (Arabic):** «هات ١٠ مستشفيات في الإسكندرية، مصر: الاسم والعنوان والتليفون والموقع الإلكتروني والتقييم»
- **Minimum size:** 10 places.
- **Expected shape:** 10 rows, one per place: name, address, phone, website, rating (and review count and map link when the source gives them); all in Alexandria; no duplicate place; place names in Arabic when the tool has a language field (the maps tool defaults to English unless the language is set, `docs/REDESIGN-PLAN.md` F2).
- **Closes** `docs/AUDIT-2026-11.md` G12 (places search never run live).

## 8. Companies with decision makers (found by search)

- **Request (Arabic):** «عايز ٢ شركات مبيعات عقارية و٢ شركات مقاولات في مصر. لكل شركة: الاسم والنشاط والموقع الإلكتروني والإيميل العام ورقم المقر الرئيسي، ومعاها ٢ من صناع القرار: الاسم والمسمى الوظيفي والإيميل والموبايل وحالة التوثيق»
- **Minimum size:** 4 companies (2 real-estate sales, 2 construction), 2 decision makers each = 8 people.
- **Expected shape:** the companies columns of `docs/AUDIT-2026-11.md` section 1A (name, activity, website, general e-mail, HQ phone) and per person: name, title, e-mail, mobile, verification status «موثّق» / «غير موثّق»; the mark «يعمل حاليًا في الشركة»; a company with no decision maker carries «لم نجد صناع قرار في هذه الشركة» and the count is filled by other employees.
- **Hard check:** **every company comes from a recorded provider search call, not from the model's memory.** Each company row has a source call in the mission's call log (read-only SELECT), and a company that no call returned fails the check.
- Found values are always delivered, marked; «غير متوفر» only after every relevant tool answered or the reserve ended.

## 9. B2B: a recycling company wants sellers and competitors

- **Request (Arabic):** «شركة مصرية بتعمل تدوير للكابلات عايزة ٢ شركات في مصر غالبًا عندها كابلات خردة للبيع (المقر الرئيسي والإيميل العام وصانع قرار بإيميله وموبايله)، و٢ منافسين لها في مصر»
- **Minimum size:** 2 likely scrap-cable holders + 2 competitors = 4 companies, each with HQ, general e-mail and 1 decision maker with e-mail and mobile.
- **Expected shape:** one sheet (or two linked sheets) where each company row says which group it belongs to («مصدر محتمل للخردة» / «منافس»); the assumptions on the plan card say which sectors were treated as likely holders of scrap cable (for example demolition, electrical contracting, telecom operators) so the customer can change them before approval; companies found by search, not by model memory (same hard check as request 8).

## 10. Medical research: papers and news

- **Request (Arabic):** «عايز أبحاث منشورة وأخبار عن استخدام الذكاء الاصطناعي في الكشف المبكر عن اعتلال الشبكية السكري، مع الروابط وملخص قصير للمنهجية»
- **Minimum size:** the owner gave no number; proposed minimum **٥ أبحاث و٣ أخبار** (owner may change).
- **Expected shape:** two groups in one file: papers (title, authors, journal, year, link, short methodology summary in Arabic) and news (title, outlet, date, link); every link is a real link returned by a source call; the methodology summary is plain Arabic and never claims more than the source's abstract says.
- **Honest outcome allowed:** if the sellable catalog has no scholarly or news source, the plan card says so before approval (D7) and the request ends without a charge. This is a pass for the shape check, not a failure.

---

## How a run is recorded

For each request, per run: date, stage that was merged, flag mode, mission id, approved count, delivered count, charged points, planning seconds, pass/fail for each check above, and the list of marks present in the file. Read-only SELECTs for the numbers are in `scripts/golden-live-checks.sql` (a proposal added by item 0.2; run by the owner).
