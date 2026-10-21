# Stage 1: every changed existing test, with old and new lines

Generated from `git diff origin/main` on branch `claude/price-per-record` (base `3c50c40`). Only existing test files are listed; the new test files have no old lines.
A line starting with `-` is an old line, a line starting with `+` is its replacement. Each changed test pinned the old whole-point price (for example 9 points a YouTube comment, 5 an X post, 3 a company), the old job-size results that followed from it (57 or 104 records at the 600 cap, the 500 and 1,000 record ceilings, the 30-page limit), or the old settlement-constant text.

## 1. Removed test lines: `git diff origin/main -- tests | grep '^-' | grep -v '^---'`

```
-    expect(res.planQuote?.targetVolumeMax).toBe(86);
- * the plan to 57. Now: what was asked, what fits one job now, and why in one plain sentence. No cap value is changed here.
-  it("2,000 comments asked: the text and the quote say 2,000 asked, 57 fit, and why; the goal line no longer says «up to 1,000»", async () => {
-    expect(quote.targetVolumeMax).toBe(57);
-    expect(reply.contentAr).toContain("طلبت ٢٠٠٠ سجل، والذي يناسب الطلب الواحد الآن ٥٧ سجل. يتحدد الحد بسبب سقف المهمة الحالي.");
-    expect(reply.contentAr).toContain("حتى ٥٧ تعليقاً إجمالاً");
-    expect(quote.summaryAr).toContain("٥٧");
-  it("no cap value, unit price or reserve changed: the same 57 comments, 9 points each, 590 held, cap 600 as before this fix", async () => {
-    expect(quote).toMatchObject({ targetVolumeMax: 57, unitPricePoints: 9, quotedPoints: 590, pointsCap: 600, pointsCapConstrained: true });
-  it("37,500 X posts: asked 37,500, fits 104, with the reason", async () => {
-    expect(reply.contentAr).toContain("طلبت ٣٧٥٠٠ سجل، والذي يناسب الطلب الواحد الآن ١٠٤ سجل.");
-    setProviderBalanceForTesting(0.01);
-  it("the customer's YouTube comment price in the table is the one a plan quotes (9 points) and TikTok's is 6", () => {
-    expect(committed).toMatch(/social-youtube-comments`\) \|[^|]+\| سجل \| 9 \|/);
-    expect(committed).toMatch(/social-tiktok-comments`\) \|[^|]+\| سجل \| 6 \|/);
-    // the number the customer wrote (2000) is the comment cap; the comments service's own limit (1000) applies first
-    expect(r.planQuote.requestedVolumeMax).toBe(1000);
-    expect(r.planQuote.targetVolumeMax).toBeLessThanOrEqual(1000);
-    it("a large social request gets the offer inside the plan message and on the quote, priced like the plan", async () => {
-        userId: "u_explore", message: "عايز ٣٠٠٠ تعليق من تيك توك عن كرة القدم في ٢٠٢٥", userBalance: 5000, personaProfile: { name: "سلمى" },
-      expect(offer.samplePoints).toBe(Math.ceil(offer.sampleUnits * unit * 1.15));
-import { recordsInOneJob, reserveInOneJob } from "../src/lib/jobSizing";
-const writerXPosts = async () => {
-  const res: any = await handler.handleUserMessage({ userId: "u_x", message: "هات ٥٠٠ تغريدة عن الغلاء على إكس آخر شهر", userBalance: 5000 });
-  it("posts on X: the public estimate says what the real quote says (104 posts, 598 held)", async () => {
-    const plan = await writerXPosts();
-    expect(plan.targetVolumeMax).toBe(104);
-    expect(plan.quotedPoints).toBe(598);
-    expect(estimateMission({ kind: "posts", platform: "x", volume: 500 })).toMatchObject({ maxVolumeInOneJob: 104, fitsInOneJob: false });
-    expect(estimateMission({ kind: "posts", platform: "x", volume: 104 })).toMatchObject({ reservePoints: 598, fitsInOneJob: true });
-    const fresh: any = estimateMission({ kind: "posts", platform: "x", volume: 500 });
-    const live: any = estimateMission({ kind: "posts", platform: "x", volume: 500, dailyCapPoints: 200 });
-    const detailed = computePublicCalculatorQuote("social-x-posts", 500, 500, undefined, undefined, undefined, undefined, 200);
-    expect(quote.targetVolumeMax).toBeLessThan(5000);
-    const withLive: any = await (await estimatePost(estimateRequest({ kind: "posts", platform: "x", volume: 500 }, "10.0.0.1"))).json();
-    const withDefault: any = await (await estimatePost(estimateRequest({ kind: "posts", platform: "x", volume: 500 }, "10.0.0.2"))).json();
-    expect(scaleValue("absoluteMaxPages", empty)).toBe(30);
-    expect(ABSOLUTE_MAX_PAGES).toBe(30);
-    expect(scaleValue("absoluteMaxPages", { LONG_JOB_MAX_PAGES: "abc" })).toBe(30);
-    expect(getSocialCapability("social-tiktok-comments")!.maxRows).toBe(1000);
-    expect(getSocialCapability("social-x-posts")!.maxRows).toBe(500);
-    expect(scaleValue("absoluteMaxPages", { NODE_ENV: "production" })).toBe(30);
-  it("the page ceiling times the rows of a chunk is the real size limit of a feed job today (30 x 50 = 1,500)", () => {
-    expect(maxPagesForJob(50_000, SOCIAL_ROWS_PER_CHUNK, "feed") * SOCIAL_ROWS_PER_CHUNK).toBe(1500);
-  it("DEFAULT ceilings: a 3,000-record job stops at the page ceiling with what it has (1,500), settled once for the delivered rows only", async () => {
-    expect(expected.expected).toBe(9);
-    expect(byId("youtube-comments").asSpecified).toMatchObject({ volume: 30, unitPricePoints: 9, quotedPoints: 311, settledIfAllDeliveredPoints: 270 });
-    expect(byId("tiktok-comments").asSpecified).toMatchObject({ volume: 30, unitPricePoints: 6, quotedPoints: 207, settledIfAllDeliveredPoints: 180 });
-    expect(byId("tiktok-channels-top-videos").asSpecified).toMatchObject({ volume: 120, cutToOneJob: true, volumeHeld: 86, quotedPoints: 594, settledIfAllDeliveredPoints: 516 });
-    expect(byId("x-posts-event").asSpecified).toMatchObject({ volume: 100, unitPricePoints: 5, quotedPoints: 575, settledIfAllDeliveredPoints: 500 });
-    expect(byId("facebook-page-posts").asSpecified).toMatchObject({ volume: 20, unitPricePoints: 11, quotedPoints: 253, settledIfAllDeliveredPoints: 220 });
-    expect(byId("companies").asSpecified).toMatchObject({ volume: 5, unitPricePoints: 3, quotedPoints: 18, settledIfAllDeliveredPoints: 15 });
-  it("the owner's two limits cannot both hold: only companies fit 20 points at the specified volume, and nothing can for decision makers", () => {
-    expect(over).toEqual(["youtube-comments", "tiktok-comments", "tiktok-channels-top-videos", "x-posts-event", "facebook-page-posts", "decision-makers"]);
-    expect(byId("youtube-comments").within20Points).toMatchObject({ volume: 1, quotedPoints: 11, settledIfAllDeliveredPoints: 9 });
-    expect(byId("tiktok-comments").within20Points).toMatchObject({ volume: 2, quotedPoints: 14, settledIfAllDeliveredPoints: 12 });
-    expect(byId("x-posts-event").within20Points).toMatchObject({ volume: 3, quotedPoints: 18, settledIfAllDeliveredPoints: 15 });
-    expect(byId("facebook-page-posts").within20Points).toMatchObject({ volume: 1, quotedPoints: 13, settledIfAllDeliveredPoints: 11 });
-    expect(byId("companies").within20Points).toMatchObject({ volume: 5, quotedPoints: 18, settledIfAllDeliveredPoints: 15 });
-    expect(adjusted.quote).toMatchObject({ volume: 80, cutToOneJob: false, quotedPoints: 552, settledIfAllDeliveredPoints: 480 });
-    for (const needle of ["0.02134", "0.01934", "552 points", "138", "193", "0.0084 (8)", "0.00288 (1)"]) expect(doc).toContain(needle);
-    const ok = await call({ kind: "comments", platform: "youtube", volume: 500 });
-    // 500 comments do not fit one request: the endpoint states the duration of the records ONE request holds
-  it("a 2,000-comment YouTube request: the plan has a labelled range, and still 57 comments at 9 points, 590 held, cap 600", async () => {
-    expect(plan.planQuote).toMatchObject({ targetVolumeMax: 57, unitPricePoints: 9, quotedPoints: 590, pointsCap: 600 });
-    // The live ledger for this exact request: reserve 11, charge 9.
-    expect(first.contentAr).toContain("التكلفة المتوقعة: ٩ نقطة");
-    const tapped = planOf(await conversation(["عايز كل تعليقات ٣ فيديوهات على يوتيوب عن منتخب مصر", answer("volume_cap_required", CAP_Q, "٥٠٠ تعليق")]));
-    expect(tappedHtml).toContain("طلبت ٥٠٠");
-  it("calculates 3 points per record and 18 points reserved for 5 company records based on verified live 0.00038 USD cost", () => {
-    // 0.00038 USD * 55 EGP * 10 markup / 0.10 EGP = 2.09 -> ceil = 3 points per unit
-    expect(quoteBreakdown.unitPricePoints).toBe(3);
-    // 5 * 3 = 15 raw points * 1.15 buffer = 17.25 -> ceil = 18 points reserved
-    expect(quoteBreakdown.reservedPoints).toBe(18);
-    expect(quoteBreakdown.chargedPoints).toBe(15);
-    expect(quoteBreakdown.reservedEgp).toBe(1.80);
-    expect(quoteBreakdown.chargedEgp).toBe(1.50);
-      plan: { summaryAr: "تعليقات مقطع", items: [{ capabilitySlug: cap.slug, params: {}, targetVolumeMin: 1, targetVolumeMax: 100 }], outputFormats: ["xlsx"] },
-    expect(quote.requestedVolumeMax).toBe(100);
-    expect(quote.targetVolumeMax).toBe(57);
-    expect(quote.expectedPoints).toBe(513);
-    expect(quote.quotedPoints).toBe(590);
-    expect(calcResult.reservedPoints).toBe(18);
-    expect(calcResult.chargedPoints).toBe(15);
-  it("a large social request is offered the priced exploration step", async () => {
-    const { responses } = await runConversation(["هات ٥٠٠ تغريدة عن كرة السلة في ٢٠٢٥"]);
-    // «عينة أولًا»: about 5% of the estimate, held between 100 and 300 points
-    expect(offer.samplePoints).toBeGreaterThanOrEqual(100);
-    expect(offer.samplePoints).toBeLessThanOrEqual(300);
-    expect(maxPagesForJob(600, 10)).toBe(ABSOLUTE_MAX_PAGES);
-    expect(readFileSync("src/functions/shared/providerSpend.ts", "utf8")).toContain("DEFAULT_JOB_POINTS_CAP = 600");
-    return handler.handleUserMessage({ userId: "user_rb", conversationId: "conv_rb", message: "٣٠ تعليق تيك توك عن كرة القدم في مصر خلال الشهر الماضي", userBalance: 5000 });
-    expect(response.planQuote.targetVolumeMax).toBe(30);
-    expect(response.planQuote.targetVolumeMax).toBeLessThan(30);
-    setRealBalanceReaderForTesting(async () => ({ usd: 0.02, at: Date.now() }));
-    expect(response.planQuote.targetVolumeMax).toBeLessThan(30);
-  it("an example bigger than one job says it needs several requests (no hidden cap)", () => {
-    const big = segmentExample(SEGMENTS.find((s) => s.slug === "researchers")!);
-    expect(res.planQuote.expectedPoints).toBe(res.planQuote.unitPricePoints * 20);
-    expect(res.planQuote.quotedPoints).toBe(Math.ceil(res.planQuote.expectedPoints * 1.15));
-    expect(item.targetVolumeMax).toBe(57);
-    expect(res.contentAr).toContain("٥٧");
-    expect(plan.planQuote.askedVolumeMax).toBe(DEFAULT_COMMENTS_CAP);
-    expect(plan.contentAr).toContain("لكن الطلب الواحد يتسع الآن لـ");
-    // 200 asked; the job's own points cap decides how many fit (unchanged), and the plan says so
-    expect(responses[0].planQuote.askedVolumeMax).toBe(200);
-    expect(responses[0].contentAr).toContain("طلبت ٢٠٠ سجل");
-    expect(plan.planQuote.askedVolumeMax).toBe(DEFAULT_RECORDS_CAP);
-  it("the cap is at least 5 cents and grows with the request", () => {
-    expect(socialReviewCapUsd(30)).toBe(0.05);
-    expect(socialReviewCapUsd(50)).toBe(0.05);
-    expect(socialReviewCapUsd(500)).toBe(0.3);
-    expect(socialReviewCapUsd(100000)).toBe(1);
-  const { calculateCapabilityUnitPricePoints, DEFAULT_PRICING_SETTINGS } = await import("../src/functions/shared/quotes");
-    it(`${cap.slug}: calculator unit price equals the quote writer's (customer rate when set, else cost basis)`, () => {
-      const basis = seed.customerPriceUsdPerItem && seed.customerPriceUsdPerItem > 0 ? seed.customerPriceUsdPerItem : seed.unitCostUsd;
-      const expected = calculateCapabilityUnitPricePoints(basis, DEFAULT_PRICING_SETTINGS);
-  it("the owner's comment rates still apply: 9 points a YouTube comment, 11 a Facebook comment", () => {
-    expect(computePublicCalculatorQuote("social-youtube-comments", 10).unitPricePoints).toBe(9);
-    expect(computePublicCalculatorQuote("social-facebook-comments", 10).unitPricePoints).toBe(11);
-  it("lists company research from the real live-priced source (0.00038 USD / 3 points per record)", () => {
-    expect(cap.pointsPerUnit).toBe(3);
-      const quote = calculateCapabilityQuote(tc.volume, cap.unitCostUsd, 100000, settings);
-    expect(plan.planQuote.askedVolumeMax).toBe(500);
```

## 2. Old and new lines per file (`git diff -U0`)

```
tests/brief-and-question-schema.test.ts
-    expect(res.planQuote?.targetVolumeMax).toBe(86);
+    // the explicit count (100) is held whole: 100 company records at 3.168 points (charge 317, reserve 365) fit the balance of 500 and the 600-point cap (the old whole-point price cut it to 86)
+    expect(res.planQuote?.targetVolumeMax).toBe(100);
tests/cap-text.test.tsx
- * the plan to 57. Now: what was asked, what fits one job now, and why in one plain sentence. No cap value is changed here.
+ * the plan to 57 (at the old whole-point price of 9 points a comment). Now: what was asked, what fits one job now, and why in one plain
+ * sentence. No cap value is changed here; at the per-record price of 0.275 points a comment the cap (600) holds 1,897 comments.
-  it("2,000 comments asked: the text and the quote say 2,000 asked, 57 fit, and why; the goal line no longer says «up to 1,000»", async () => {
+  it("2,000 comments asked: the text and the quote say 2,000 asked, 1,897 fit, and why; the goal line no longer says «up to 1,000»", async () => {
-    expect(quote.targetVolumeMax).toBe(57);
-    expect(reply.contentAr).toContain("طلبت ٢٠٠٠ سجل، والذي يناسب الطلب الواحد الآن ٥٧ سجل. يتحدد الحد بسبب سقف المهمة الحالي.");
-    expect(reply.contentAr).toContain("حتى ٥٧ تعليقاً إجمالاً");
+    expect(quote.targetVolumeMax).toBe(1897);
+    expect(reply.contentAr).toContain("طلبت ٢٠٠٠ سجل، والذي يناسب الطلب الواحد الآن ١٨٩٧ سجل. يتحدد الحد بسبب سقف المهمة الحالي.");
+    expect(reply.contentAr).toContain("حتى ١٨٩٧ تعليقاً إجمالاً");
-    expect(quote.summaryAr).toContain("٥٧");
+    expect(quote.summaryAr).toContain("١٨٩٧");
-  it("no cap value, unit price or reserve changed: the same 57 comments, 9 points each, 590 held, cap 600 as before this fix", async () => {
+  it("the plan numbers: 1,897 comments at 0.275 points each (522 charge), 600 held, the cap still 600", async () => {
-    expect(quote).toMatchObject({ targetVolumeMax: 57, unitPricePoints: 9, quotedPoints: 590, pointsCap: 600, pointsCapConstrained: true });
+    expect(quote).toMatchObject({ targetVolumeMax: 1897, unitPricePoints: 0.275, expectedPoints: 522, quotedPoints: 600, pointsCap: 600, pointsCapConstrained: true });
-  it("37,500 X posts: asked 37,500, fits 104, with the reason", async () => {
+  it("37,500 X posts: asked 37,500, fits 4,453 (the most whose reserve is within 600: 522 charge, 600 held), with the reason", async () => {
-    expect(reply.contentAr).toContain("طلبت ٣٧٥٠٠ سجل، والذي يناسب الطلب الواحد الآن ١٠٤ سجل.");
+    expect(reply.planQuote).toMatchObject({ targetVolumeMax: 4453, unitPricePoints: 0.11715, expectedPoints: 522, quotedPoints: 600, pointsCap: 600, pointsCapConstrained: true });
+    expect(reply.contentAr).toContain("طلبت ٣٧٥٠٠ سجل، والذي يناسب الطلب الواحد الآن ٤٤٥٣ سجل.");
tests/capacity-cut-reason.test.tsx
-    setProviderBalanceForTesting(0.01);
+    // 0.001 USD budget (0.0009 safe) holds 18 comments at 0.00005 USD each (the cost of one delivered comment), below the 30 asked
+    setProviderBalanceForTesting(0.001);
tests/coverage-doc.test.ts
-  it("the customer's YouTube comment price in the table is the one a plan quotes (9 points) and TikTok's is 6", () => {
-    expect(committed).toMatch(/social-youtube-comments`\) \|[^|]+\| سجل \| 9 \|/);
-    expect(committed).toMatch(/social-tiktok-comments`\) \|[^|]+\| سجل \| 6 \|/);
+  it("the customer's comment prices in the table are the ones a plan quotes: 0.275 points a YouTube comment and 0.275 a TikTok comment (0.00005 USD x 5,500)", () => {
+    expect(committed).toMatch(/social-youtube-comments`\) \|[^|]+\| سجل \| 0\.275 \|/);
+    expect(committed).toMatch(/social-tiktok-comments`\) \|[^|]+\| سجل \| 0\.275 \|/);
tests/dependent-mission.test.tsx
-    // the number the customer wrote (2000) is the comment cap; the comments service's own limit (1000) applies first
-    expect(r.planQuote.requestedVolumeMax).toBe(1000);
-    expect(r.planQuote.targetVolumeMax).toBeLessThanOrEqual(1000);
+    // the number the customer wrote (2000) is the comment cap; the comments service's own limit is now 2,000, so it is held whole up to what the 600-point cap holds
+    expect(r.planQuote.requestedVolumeMax).toBe(2000);
+    expect(r.planQuote.targetVolumeMax).toBe(1897);
tests/exploration-and-caps.test.ts
+import { reserveForUnits } from "../src/lib/recordPricing";
-    it("a large social request gets the offer inside the plan message and on the quote, priced like the plan", async () => {
+    it("a large request gets the offer inside the plan message and on the quote, priced like the plan", async () => {
+      // a social request can no longer reach the 1,500-point threshold (the most one job holds is 522 points at the per-record prices and the cap of 600);
+      // 500 companies are 1,584 points of charge, of which one job holds 164
-        userId: "u_explore", message: "عايز ٣٠٠٠ تعليق من تيك توك عن كرة القدم في ٢٠٢٥", userBalance: 5000, personaProfile: { name: "سلمى" },
+        userId: "u_explore", message: "عايز ٥٠٠ شركة كهرباء في مصر", userBalance: 5000, personaProfile: { name: "سلمى" },
-      expect(offer.samplePoints).toBe(Math.ceil(offer.sampleUnits * unit * 1.15));
+      // exact: ceil(records x unit price x 1.15)
+      expect(unit).toBe(3.168);
+      expect(offer.samplePoints).toBe(reserveForUnits(offer.sampleUnits, unit));
tests/job-sizing.test.ts
-import { recordsInOneJob, reserveInOneJob } from "../src/lib/jobSizing";
+import { limitedByServiceCeiling, recordsInOneJob, reserveInOneJob } from "../src/lib/jobSizing";
-const writerXPosts = async () => {
+const writerXPosts = async (asked = "٥٠٠") => {
-  const res: any = await handler.handleUserMessage({ userId: "u_x", message: "هات ٥٠٠ تغريدة عن الغلاء على إكس آخر شهر", userBalance: 5000 });
+  const res: any = await handler.handleUserMessage({ userId: "u_x", message: `هات ${asked} تغريدة عن الغلاء على إكس آخر شهر`, userBalance: 5000 });
+  it("a service's own record ceiling lowers one job's size and never raises it", () => {
+    const base = { unitPricePoints: 0.11715, capPoints: 600, safetyBuffer: BUFFER };
+    expect(recordsInOneJob(base)).toBe(4453);
+    expect(recordsInOneJob({ ...base, maxRecords: 500 })).toBe(500);
+    expect(recordsInOneJob({ ...base, maxRecords: 100000 })).toBe(4453);
+    expect(recordsInOneJob({ ...base, maxRecords: 0 })).toBe(4453);
+    expect(limitedByServiceCeiling({ ...base, maxRecords: 500 })).toBe(true);
+    expect(limitedByServiceCeiling({ ...base, maxRecords: 100000 })).toBe(false);
+    expect(limitedByServiceCeiling(base)).toBe(false);
+  });
+
-  it("posts on X: the public estimate says what the real quote says (104 posts, 598 held)", async () => {
-    const plan = await writerXPosts();
-    expect(plan.targetVolumeMax).toBe(104);
-    expect(plan.quotedPoints).toBe(598);
-    expect(estimateMission({ kind: "posts", platform: "x", volume: 500 })).toMatchObject({ maxVolumeInOneJob: 104, fitsInOneJob: false });
-    expect(estimateMission({ kind: "posts", platform: "x", volume: 104 })).toMatchObject({ reservePoints: 598, fitsInOneJob: true });
+  it("posts on X: the public estimate says what the real quote says (500 posts fit whole: 68 held; 40,000 asked are cut to 4,453: 600 held)", async () => {
+    const small = await writerXPosts();
+    expect(small.targetVolumeMax).toBe(500);
+    expect(small.quotedPoints).toBe(68);
+    expect(estimateMission({ kind: "posts", platform: "x", volume: 500 })).toMatchObject({ maxVolumeInOneJob: 4453, fitsInOneJob: true, reservePoints: 68 });
+    const large = await writerXPosts("٤٠٠٠٠");
+    expect(large.targetVolumeMax).toBe(4453);
+    expect(large.quotedPoints).toBe(600);
+    expect(estimateMission({ kind: "posts", platform: "x", volume: 40000 })).toMatchObject({ maxVolumeInOneJob: 4453, fitsInOneJob: false });
+    expect(estimateMission({ kind: "posts", platform: "x", volume: 4453 })).toMatchObject({ reservePoints: 600, fitsInOneJob: true });
+  });
+
+  it("companies: the public estimate says what the real quote says (the points cap holds 164: 598 held)", async () => {
+    const handler = new ChatHandler(createChatDb() as any);
+    (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be called"); });
+    const res: any = await handler.handleUserMessage({ userId: "u_c", message: "عايز ٥٠٠ شركة كهرباء في مصر", userBalance: 20000 });
+    expect(res.planQuote.targetVolumeMax).toBe(164);
+    expect(res.planQuote.quotedPoints).toBe(598);
+    expect(estimateMission({ kind: "companies", volume: 500 })).toMatchObject({ maxVolumeInOneJob: 164, fitsInOneJob: false });
+    expect(estimateMission({ kind: "companies", volume: 164 })).toMatchObject({ reservePoints: 598, fitsInOneJob: true });
-    const fresh: any = estimateMission({ kind: "posts", platform: "x", volume: 500 });
-    const live: any = estimateMission({ kind: "posts", platform: "x", volume: 500, dailyCapPoints: 200 });
+    // companies: the points cap, not the service's record ceiling, limits one job (164 records at the cap of 600, 54 at a live limit of 200)
+    const fresh: any = estimateMission({ kind: "companies", volume: 500 });
+    const live: any = estimateMission({ kind: "companies", volume: 500, dailyCapPoints: 200 });
-    const detailed = computePublicCalculatorQuote("social-x-posts", 500, 500, undefined, undefined, undefined, undefined, 200);
+    const detailed = computePublicCalculatorQuote("icypeas-companies-search", 500, 500, undefined, undefined, undefined, undefined, 200);
+    expect(live.maxVolumeInOneJob).toBe(54);
+    expect(fresh.maxVolumeInOneJob).toBe(164);
tests/large-counts.test.ts
-    expect(quote.targetVolumeMax).toBeLessThan(5000);
+    // at 0.275 points a comment the cap of 600 holds 1,897 comments (the service's ceiling is 2,000): reserve 600
+    expect(quote.targetVolumeMax).toBe(1897);
+    expect(quote.quotedPoints).toBe(600);
tests/live-cap-surfaces.test.ts
-    const withLive: any = await (await estimatePost(estimateRequest({ kind: "posts", platform: "x", volume: 500 }, "10.0.0.1"))).json();
+    // companies: the points cap, not the service's record ceiling, limits one job (54 records at a 200-point limit, 164 at 600)
+    const withLive: any = await (await estimatePost(estimateRequest({ kind: "companies", volume: 500 }, "10.0.0.1"))).json();
-    const withDefault: any = await (await estimatePost(estimateRequest({ kind: "posts", platform: "x", volume: 500 }, "10.0.0.2"))).json();
+    const withDefault: any = await (await estimatePost(estimateRequest({ kind: "companies", volume: 500 }, "10.0.0.2"))).json();
tests/long-job-scale-harness.test.ts
-    expect(scaleValue("absoluteMaxPages", empty)).toBe(30);
+    expect(scaleValue("absoluteMaxPages", empty)).toBe(300);
-    expect(ABSOLUTE_MAX_PAGES).toBe(30);
+    expect(ABSOLUTE_MAX_PAGES).toBe(300);
-    expect(scaleValue("absoluteMaxPages", { LONG_JOB_MAX_PAGES: "abc" })).toBe(30);
+    expect(scaleValue("absoluteMaxPages", { LONG_JOB_MAX_PAGES: "abc" })).toBe(300);
-    expect(getSocialCapability("social-tiktok-comments")!.maxRows).toBe(1000);
-    expect(getSocialCapability("social-x-posts")!.maxRows).toBe(500);
+    // the ceilings are what the 600-point cap holds: 1,897 comments, 4,453 X posts
+    expect(getSocialCapability("social-tiktok-comments")!.maxRows).toBe(2000);
+    expect(getSocialCapability("social-youtube-comments")!.maxRows).toBe(2000);
+    expect(getSocialCapability("social-x-posts")!.maxRows).toBe(4500);
+    expect(getSocialCapability("social-facebook-posts")!.maxRows).toBe(60);
+    expect(maxPagesForJob(5000, SOCIAL_ROWS_PER_CHUNK, "feed")).toBe(300);
+    setScaleOverridesForTesting({ absoluteMaxPages: 30 });
-    expect(scaleValue("absoluteMaxPages", { NODE_ENV: "production" })).toBe(30);
+    expect(scaleValue("absoluteMaxPages", { NODE_ENV: "production" })).toBe(300);
-  it("the page ceiling times the rows of a chunk is the real size limit of a feed job today (30 x 50 = 1,500)", () => {
-    expect(maxPagesForJob(50_000, SOCIAL_ROWS_PER_CHUNK, "feed") * SOCIAL_ROWS_PER_CHUNK).toBe(1500);
+  it("the page ceiling times the rows of a chunk is the real size limit of a feed job today (300 x 50 = 15,000; it was 30 x 50 = 1,500)", () => {
+    expect(maxPagesForJob(50_000, SOCIAL_ROWS_PER_CHUNK, "feed") * SOCIAL_ROWS_PER_CHUNK).toBe(15000);
+    // a full 600-point job fits: 4,453 X posts need 90 pages (270 with the slack of 3), 1,897 comments 38 pages (114)
+    expect(maxPagesForJob(4453, SOCIAL_ROWS_PER_CHUNK, "feed")).toBe(270);
+    expect(maxPagesForJob(1897, SOCIAL_ROWS_PER_CHUNK, "feed")).toBe(114);
-  it("DEFAULT ceilings: a 3,000-record job stops at the page ceiling with what it has (1,500), settled once for the delivered rows only", async () => {
+  it("a page ceiling of 30 (the previous default) stops a 3,000-record job at what it has (1,500), settled once for the delivered rows only", async () => {
+    setScaleOverridesForTesting({ absoluteMaxPages: 30 });
+  it("DEFAULT ceilings: the same 3,000-record job reaches its full 3,000 through 60 chunks", async () => {
+    installProvider(big());
+    const jobId = seedSocialJob({ target: 3000, videoCount: 20, perVideo: 150 });
+    const run = await driveToTheEnd(jobId, { maxTicks: 200 });
+    expect(run.finalStatus).toBe("completed");
+    expect(run.chunks).toBe(60);
+    expect(settledOnce(jobId).delivered_units).toBe(3000);
+  }, 60_000);
+
tests/low-balance-flow.test.ts
-    expect(expected.expected).toBe(9);
+    // 3 company records at 3.168 points: 9.504 -> charge 10; reserve ceil(9.504 x 1.15 = 10.93) = 11
+    expect(expected.unit).toBe(3.168);
+    expect(expected.expected).toBe(10);
tests/measurement-plan.test.ts
-    expect(byId("youtube-comments").asSpecified).toMatchObject({ volume: 30, unitPricePoints: 9, quotedPoints: 311, settledIfAllDeliveredPoints: 270 });
-    expect(byId("tiktok-comments").asSpecified).toMatchObject({ volume: 30, unitPricePoints: 6, quotedPoints: 207, settledIfAllDeliveredPoints: 180 });
-    expect(byId("tiktok-channels-top-videos").asSpecified).toMatchObject({ volume: 120, cutToOneJob: true, volumeHeld: 86, quotedPoints: 594, settledIfAllDeliveredPoints: 516 });
-    expect(byId("x-posts-event").asSpecified).toMatchObject({ volume: 100, unitPricePoints: 5, quotedPoints: 575, settledIfAllDeliveredPoints: 500 });
-    expect(byId("facebook-page-posts").asSpecified).toMatchObject({ volume: 20, unitPricePoints: 11, quotedPoints: 253, settledIfAllDeliveredPoints: 220 });
-    expect(byId("companies").asSpecified).toMatchObject({ volume: 5, unitPricePoints: 3, quotedPoints: 18, settledIfAllDeliveredPoints: 15 });
+    // per-record prices (cost per delivered record x 5,500): 0.275 a comment, 0.11715 an X post, 3.4485 a Facebook page post, 3.168 a company
+    expect(byId("youtube-comments").asSpecified).toMatchObject({ volume: 30, unitPricePoints: 0.275, quotedPoints: 10, settledIfAllDeliveredPoints: 9 });
+    expect(byId("tiktok-comments").asSpecified).toMatchObject({ volume: 30, unitPricePoints: 0.275, quotedPoints: 10, settledIfAllDeliveredPoints: 9 });
+    expect(byId("tiktok-channels-top-videos").asSpecified).toMatchObject({ volume: 120, cutToOneJob: false, volumeHeld: 120, quotedPoints: 38, settledIfAllDeliveredPoints: 33 });
+    expect(byId("x-posts-event").asSpecified).toMatchObject({ volume: 100, unitPricePoints: 0.11715, quotedPoints: 14, settledIfAllDeliveredPoints: 12 });
+    expect(byId("facebook-page-posts").asSpecified).toMatchObject({ volume: 20, unitPricePoints: 3.4485, quotedPoints: 80, settledIfAllDeliveredPoints: 69 });
+    expect(byId("companies").asSpecified).toMatchObject({ volume: 5, unitPricePoints: 3.168, quotedPoints: 19, settledIfAllDeliveredPoints: 16 });
-  it("the owner's two limits cannot both hold: only companies fit 20 points at the specified volume, and nothing can for decision makers", () => {
+  it("the owner's two limits: at the per-record prices only the channels mission, the Facebook page posts and decision makers quote above 20 points at the specified volume", () => {
-    expect(over).toEqual(["youtube-comments", "tiktok-comments", "tiktok-channels-top-videos", "x-posts-event", "facebook-page-posts", "decision-makers"]);
+    expect(over).toEqual(["tiktok-channels-top-videos", "facebook-page-posts", "decision-makers"]);
-    expect(byId("youtube-comments").within20Points).toMatchObject({ volume: 1, quotedPoints: 11, settledIfAllDeliveredPoints: 9 });
-    expect(byId("tiktok-comments").within20Points).toMatchObject({ volume: 2, quotedPoints: 14, settledIfAllDeliveredPoints: 12 });
-    expect(byId("x-posts-event").within20Points).toMatchObject({ volume: 3, quotedPoints: 18, settledIfAllDeliveredPoints: 15 });
-    expect(byId("facebook-page-posts").within20Points).toMatchObject({ volume: 1, quotedPoints: 13, settledIfAllDeliveredPoints: 11 });
-    expect(byId("companies").within20Points).toMatchObject({ volume: 5, quotedPoints: 18, settledIfAllDeliveredPoints: 15 });
+    expect(byId("youtube-comments").within20Points).toMatchObject({ volume: 30, quotedPoints: 10, settledIfAllDeliveredPoints: 9 });
+    expect(byId("tiktok-comments").within20Points).toMatchObject({ volume: 30, quotedPoints: 10, settledIfAllDeliveredPoints: 9 });
+    expect(byId("tiktok-channels-top-videos").within20Points).toMatchObject({ volume: 63, quotedPoints: 20, settledIfAllDeliveredPoints: 18 });
+    expect(byId("x-posts-event").within20Points).toMatchObject({ volume: 100, quotedPoints: 14, settledIfAllDeliveredPoints: 12 });
+    expect(byId("facebook-page-posts").within20Points).toMatchObject({ volume: 5, quotedPoints: 20, settledIfAllDeliveredPoints: 18 });
+    expect(byId("companies").within20Points).toMatchObject({ volume: 5, quotedPoints: 19, settledIfAllDeliveredPoints: 16 });
-    expect(adjusted.quote).toMatchObject({ volume: 80, cutToOneJob: false, quotedPoints: 552, settledIfAllDeliveredPoints: 480 });
+    expect(adjusted.quote).toMatchObject({ volume: 80, cutToOneJob: false, quotedPoints: 26, settledIfAllDeliveredPoints: 22 });
-    for (const needle of ["0.02134", "0.01934", "552 points", "138", "193", "0.0084 (8)", "0.00288 (1)"]) expect(doc).toContain(needle);
+    for (const needle of ["0.02134", "0.01934", "26 points", "138", "193", "0.0084 (8)", "0.00288 (1)"]) expect(doc).toContain(needle);
tests/mission-duration.test.tsx
-    const ok = await call({ kind: "comments", platform: "youtube", volume: 500 });
+    const ok = await call({ kind: "comments", platform: "youtube", volume: 5000 });
-    // 500 comments do not fit one request: the endpoint states the duration of the records ONE request holds
+    // 5,000 comments do not fit one request (the cap of 600 points holds 1,897 at 0.275 points): the endpoint states the duration of the records ONE request holds
-  it("a 2,000-comment YouTube request: the plan has a labelled range, and still 57 comments at 9 points, 590 held, cap 600", async () => {
+  it("a 2,000-comment YouTube request: the plan has a labelled range, and holds 1,500 comments (3 videos x 500, the most they can give) at 0.275 points, 475 held, cap 600", async () => {
-    expect(plan.planQuote).toMatchObject({ targetVolumeMax: 57, unitPricePoints: 9, quotedPoints: 590, pointsCap: 600 });
+    expect(plan.planQuote).toMatchObject({ targetVolumeMax: 1500, unitPricePoints: 0.275, quotedPoints: 475, pointsCap: 600 });
tests/owner-conversation-regression.test.ts
-    // The live ledger for this exact request: reserve 11, charge 9.
+    // 3 company records at 3.168 points (measured cost 0.000576 USD x 5,500): charge 10, reserve 11 (the live ledger of the old whole-point price was 9 and 11).
-    expect(first.contentAr).toContain("التكلفة المتوقعة: ٩ نقطة");
+    expect(first.contentAr).toContain("التكلفة المتوقعة: ١٠ نقطة");
tests/plan-default-labels.test.tsx
-    const tapped = planOf(await conversation(["عايز كل تعليقات ٣ فيديوهات على يوتيوب عن منتخب مصر", answer("volume_cap_required", CAP_Q, "٥٠٠ تعليق")]));
+    // a count tapped on the cap card that is larger than one job holds (5,000 asked; the service holds 1,000): the card says «طلبت»
+    const tapped = planOf(await conversation(["عايز كل تعليقات ٣ فيديوهات على يوتيوب عن منتخب مصر", answer("volume_cap_required", CAP_Q, "٥٠٠٠ تعليق")]));
-    expect(tappedHtml).toContain("طلبت ٥٠٠");
+    expect(tappedHtml).toContain("طلبت ٥٠٠٠");
tests/plan-editing-and-calculator.test.ts
+import { resetProviderBalanceCacheForTesting, setProviderBalanceForTesting } from "../src/functions/shared/providerSpend";
-  it("calculates 3 points per record and 18 points reserved for 5 company records based on verified live 0.00038 USD cost", () => {
-    // 0.00038 USD * 55 EGP * 10 markup / 0.10 EGP = 2.09 -> ceil = 3 points per unit
+  it("calculates 3.168 points per delivered company record (measured cost 0.000576 USD x 5,500): 5 records charge 16 and reserve 19", () => {
+    // the whole-point rule on the call price is unchanged for other services: 0.00038 USD * 55 EGP * 10 markup / 0.10 EGP = 2.09 -> ceil = 3
-    expect(quoteBreakdown.unitPricePoints).toBe(3);
+    expect(quoteBreakdown.unitPricePoints).toBe(3.168);
-    // 5 * 3 = 15 raw points * 1.15 buffer = 17.25 -> ceil = 18 points reserved
-    expect(quoteBreakdown.reservedPoints).toBe(18);
-    expect(quoteBreakdown.chargedPoints).toBe(15);
+    // 5 * 3.168 = 15.84 raw points -> charge ceil = 16; * 1.15 buffer = 18.216 -> reserve ceil = 19 points
+    expect(quoteBreakdown.reservedPoints).toBe(19);
+    expect(quoteBreakdown.chargedPoints).toBe(16);
-    expect(quoteBreakdown.reservedEgp).toBe(1.80);
-    expect(quoteBreakdown.chargedEgp).toBe(1.50);
+    expect(quoteBreakdown.reservedEgp).toBe(1.90);
+    expect(quoteBreakdown.chargedEgp).toBe(1.60);
+    // the provider side is out of the way (a high balance), so the 600-point job cap is the ceiling under test
+    setProviderBalanceForTesting(10);
-      plan: { summaryAr: "تعليقات مقطع", items: [{ capabilitySlug: cap.slug, params: {}, targetVolumeMin: 1, targetVolumeMax: 100 }], outputFormats: ["xlsx"] },
+      plan: { summaryAr: "تعليقات مقطع", items: [{ capabilitySlug: cap.slug, params: {}, targetVolumeMin: 1, targetVolumeMax: 3000 }], outputFormats: ["xlsx"] },
+    resetProviderBalanceCacheForTesting();
-    expect(quote.requestedVolumeMax).toBe(100);
-    expect(quote.targetVolumeMax).toBe(57);
-    expect(quote.expectedPoints).toBe(513);
-    expect(quote.quotedPoints).toBe(590);
+    expect(quote.requestedVolumeMax).toBe(3000);
+    // 0.275 points a comment: the most records whose reserve fits 600 is 1,897 (charge ceil(521.675) = 522, reserve ceil(599.9) = 600)
+    expect(quote.targetVolumeMax).toBe(1897);
+    expect(quote.expectedPoints).toBe(522);
+    expect(quote.quotedPoints).toBe(600);
-    expect(calcResult.reservedPoints).toBe(18);
-    expect(calcResult.chargedPoints).toBe(15);
+    expect(calcResult.reservedPoints).toBe(19);
+    expect(calcResult.chargedPoints).toBe(16);
tests/planning-quality.test.ts
+import { sampleTargetPoints } from "../src/lib/sampleFirst";
-  it("a large social request is offered the priced exploration step", async () => {
-    const { responses } = await runConversation(["هات ٥٠٠ تغريدة عن كرة السلة في ٢٠٢٥"]);
+  it("a large request is offered the priced exploration step", async () => {
+    // 500 companies are 1,584 points of charge: over the 1,500 that earns a sample offer (a social request cannot reach it any more: 500 posts are 59 points)
+    const { responses } = await runConversation(["عايز ٥٠٠ شركة كهرباء في مصر"]);
-    // «عينة أولًا»: about 5% of the estimate, held between 100 and 300 points
+    // «عينة أولًا»: the target is about 5% of the estimate, held between 100 and 300 points; the sample holds the most whole records whose reserve fits it
-    expect(offer.samplePoints).toBeGreaterThanOrEqual(100);
-    expect(offer.samplePoints).toBeLessThanOrEqual(300);
+    const target = sampleTargetPoints(offer.fullEstimatePoints);
+    expect(target).toBeGreaterThanOrEqual(100);
+    expect(target).toBeLessThanOrEqual(300);
+    expect(offer.samplePoints).toBeLessThanOrEqual(target);
+    expect(offer.samplePoints + r.planQuote.unitPricePoints * 1.15 + 1).toBeGreaterThan(target);
tests/provider-call-caps.test.ts
-    expect(maxPagesForJob(600, 10)).toBe(ABSOLUTE_MAX_PAGES);
+    expect(maxPagesForJob(600, 10)).toBe(180);
+    expect(maxPagesForJob(100000, 10)).toBe(ABSOLUTE_MAX_PAGES);
+    expect(ABSOLUTE_MAX_PAGES).toBe(300);
-    expect(readFileSync("src/functions/shared/providerSpend.ts", "utf8")).toContain("DEFAULT_JOB_POINTS_CAP = 600");
+    // the job cap is one shared constant (600); providerSpend reads it from there
+    expect(readFileSync("src/functions/shared/providerSpend.ts", "utf8")).toContain("DEFAULT_JOB_POINTS_CAP = JOB_MAX_POINTS_CAP");
+    expect(readFileSync("src/lib/jobPointsCap.ts", "utf8")).toContain("JOB_MAX_POINTS_CAP = 600");
tests/real-provider-balance.test.tsx
-    return handler.handleUserMessage({ userId: "user_rb", conversationId: "conv_rb", message: "٣٠ تعليق تيك توك عن كرة القدم في مصر خلال الشهر الماضي", userBalance: 5000 });
+    return handler.handleUserMessage({ userId: "user_rb", conversationId: "conv_rb", // 300 comments cost 0.015 USD at 0.00005 USD a delivered comment (30 comments cost 0.0015, which fits even the estimate balance)
+    message: "٣٠٠ تعليق تيك توك عن كرة القدم في مصر خلال الشهر الماضي", userBalance: 5000 });
-    expect(response.planQuote.targetVolumeMax).toBe(30);
+    expect(response.planQuote.targetVolumeMax).toBe(300);
-    expect(response.planQuote.targetVolumeMax).toBeLessThan(30);
+    expect(response.planQuote.targetVolumeMax).toBeLessThan(300);
-    setRealBalanceReaderForTesting(async () => ({ usd: 0.02, at: Date.now() }));
+    setRealBalanceReaderForTesting(async () => ({ usd: 0.01, at: Date.now() }));
-    expect(response.planQuote.targetVolumeMax).toBeLessThan(30);
+    expect(response.planQuote.targetVolumeMax).toBeLessThan(300);
tests/segment-pages.test.tsx
-  it("an example bigger than one job says it needs several requests (no hidden cap)", () => {
-    const big = segmentExample(SEGMENTS.find((s) => s.slug === "researchers")!);
+  it("an example bigger than one job says it needs several requests (no hidden cap); the real examples now fit one job whole", () => {
+    const researchers = SEGMENTS.find((s) => s.slug === "researchers")!;
+    const big = segmentExample({ ...researchers, estimate: { kind: "comments", platform: "youtube", volume: 100000 } });
+    for (const segment of SEGMENTS) expect(segmentExample(segment).notesAr, segment.slug).toEqual([]);
tests/social-plans.test.ts
-    expect(res.planQuote.expectedPoints).toBe(res.planQuote.unitPricePoints * 20);
-    expect(res.planQuote.quotedPoints).toBe(Math.ceil(res.planQuote.expectedPoints * 1.15));
+    // 0.275 points a comment (0.00005 USD x 5,500): 20 comments are 5.5 points -> charge 6; the reserve is ceil(5.5 x 1.15 = 6.325) = 7
+    expect(res.planQuote.unitPricePoints).toBe(0.275);
+    expect(res.planQuote.expectedPoints).toBe(6);
+    expect(res.planQuote.quotedPoints).toBe(7);
-    expect(item.targetVolumeMax).toBe(57);
-    expect(res.contentAr).toContain("٥٧");
+    // 100 comments are 27.5 points (reserve 32): they fit one job whole, so nothing is cut
+    expect(item.targetVolumeMax).toBe(100);
+    expect(res.planQuote.quotedPoints).toBe(32);
+    expect(res.contentAr).toContain("١٠٠");
tests/social-quantities-and-defaults.test.ts
-    expect(plan.planQuote.askedVolumeMax).toBe(DEFAULT_COMMENTS_CAP);
+    // the default (500 comments, 138 points of charge) fits one job whole: the plan holds it all and says no cut
+    expect(plan.planQuote.targetVolumeMax).toBe(DEFAULT_COMMENTS_CAP);
+    expect(plan.planQuote.askedVolumeMax).toBeUndefined();
-    expect(plan.contentAr).toContain("لكن الطلب الواحد يتسع الآن لـ");
+    expect(plan.contentAr).not.toContain("لكن الطلب الواحد يتسع الآن لـ");
-    // 200 asked; the job's own points cap decides how many fit (unchanged), and the plan says so
-    expect(responses[0].planQuote.askedVolumeMax).toBe(200);
-    expect(responses[0].contentAr).toContain("طلبت ٢٠٠ سجل");
+    // 200 asked (4 videos x 50): the whole request fits one job, so the plan holds 200 and says no cut
+    expect(responses[0].planQuote.targetVolumeMax).toBe(200);
+    expect(responses[0].planQuote.askedVolumeMax).toBeUndefined();
+    expect(responses[0].contentAr).not.toContain("طلبت ٢٠٠ سجل");
-    expect(plan.planQuote.askedVolumeMax).toBe(DEFAULT_RECORDS_CAP);
+    expect(plan.planQuote.targetVolumeMax).toBe(DEFAULT_RECORDS_CAP);
+    expect(plan.planQuote.askedVolumeMax).toBeUndefined();
tests/social-relevance-golden.test.ts
-  it("the cap is at least 5 cents and grows with the request", () => {
-    expect(socialReviewCapUsd(30)).toBe(0.05);
-    expect(socialReviewCapUsd(50)).toBe(0.05);
-    expect(socialReviewCapUsd(500)).toBe(0.3);
-    expect(socialReviewCapUsd(100000)).toBe(1);
+  it("the cap is 20% of the job's revenue: its expected charge in points at 0.10 EGP a point and 55 EGP a dollar", () => {
+    // X: unit 0.11715 points. 300 posts = 36 points = 3.6 EGP = 0.065454 USD; 20% = 0.013090 USD
+    expect(socialReviewCapUsd(30, 0.11715)).toBe(0.001454);
+    expect(socialReviewCapUsd(300, 0.11715)).toBe(0.01309);
+    expect(socialReviewCapUsd(500, 0.11715)).toBe(0.021454);
+    expect(socialReviewCapUsd(4000, 0.11715)).toBe(0.170545);
+    // comments: unit 0.275 points. 1,000 comments = 275 points = 27.5 EGP = 0.5 USD; 20% = 0.10 USD
+    expect(socialReviewCapUsd(300, 0.275)).toBe(0.030181);
+    expect(socialReviewCapUsd(1000, 0.275)).toBe(0.1);
+    expect(socialReviewCapUsd(20, 3.4485)).toBe(0.02509);
+    // never above the share, whatever the rounding
+    for (const [records, unit] of [[30, 0.11715], [777, 0.275], [123, 1.034], [5, 3.168], [4453, 0.11715]] as Array<[number, number]>) {
+      const revenueUsd = (Math.ceil(records * unit) * 0.1) / 55;
+      expect(socialReviewCapUsd(records, unit)).toBeLessThanOrEqual(revenueUsd * 0.2 + 1e-12);
+    }
+    // a job with no valid price has no review budget (fail closed)
+    expect(socialReviewCapUsd(10, 0)).toBe(0);
+    expect(socialReviewCapUsd(10, Number.NaN)).toBe(0);
+  });
+
+  it("with a call-cost estimate the budget is a ceiling: a call that would cross it is not started, and its rows stay unreviewed", async () => {
+    const seen: number[][] = [];
+    const rows = Array.from({ length: 75 }, (_, i) => row(i));
+    // budget 0.013 USD, a full call costs up to 0.0047: two full calls (0.0094) fit, a third (0.0141) would cross it
+    const outcome = await reviewSocialRows({ advisor: costly(0.0047, seen), customerRequest: "x", kind: "social-x-posts", rows, budgetUsd: 0.013, callCostEstimateUsd: 0.0047 });
+    expect(seen.map((batch) => batch.length)).toEqual([SOCIAL_REVIEW_ROWS_PER_CALL, SOCIAL_REVIEW_ROWS_PER_CALL]);
+    expect(outcome.costUsd).toBeCloseTo(0.0094, 6);
+    expect(outcome.costUsd).toBeLessThanOrEqual(0.013);
+    expect(outcome.unreviewed).toHaveLength(25);
+    expect(outcome.stoppedBy).toBe("cap");
+    // a budget below the cost of the call its rows need (2 rows: 0.0047 x 2 / 25 = 0.000376) reviews nothing at all
+    const none: number[][] = [];
+    const tiny = await reviewSocialRows({ advisor: costly(0.0047, none), customerRequest: "x", kind: "social-x-posts", rows: [row(0), row(1)], budgetUsd: 0.0003, callCostEstimateUsd: 0.0047 });
+    expect(none).toHaveLength(0);
+    expect(tiny.unreviewed).toEqual([0, 1]);
+    expect(tiny.stoppedBy).toBe("cap");
+  });
+
+  it("a call that turns out dearer than the estimate raises the estimate for the next one", async () => {
+    const seen: number[][] = [];
+    const rows = Array.from({ length: 100 }, (_, i) => row(i));
+    // first call 25 rows costs 0.006 (dearer than the 0.0047 estimate); budget 0.015 holds one more only if 0.0047 were used: 0.006 + 0.006 = 0.012 <= 0.015 allows the second, then 0.018 > 0.015 stops
+    const outcome = await reviewSocialRows({ advisor: costly(0.006, seen), customerRequest: "x", kind: "social-x-posts", rows, budgetUsd: 0.015, callCostEstimateUsd: 0.0047 });
+    expect(seen).toHaveLength(2);
+    expect(outcome.costUsd).toBeCloseTo(0.012, 6);
+    expect(outcome.costUsd).toBeLessThanOrEqual(0.015);
tests/social-sources.test.ts
-  const { calculateCapabilityUnitPricePoints, DEFAULT_PRICING_SETTINGS } = await import("../src/functions/shared/quotes");
+  const { unitPricePointsForCapability, DEFAULT_PRICING_SETTINGS } = await import("../src/functions/shared/quotes");
-    it(`${cap.slug}: calculator unit price equals the quote writer's (customer rate when set, else cost basis)`, () => {
+    it(`${cap.slug}: calculator unit price equals the quote writer's (the one shared pricing function)`, () => {
-      const basis = seed.customerPriceUsdPerItem && seed.customerPriceUsdPerItem > 0 ? seed.customerPriceUsdPerItem : seed.unitCostUsd;
-      const expected = calculateCapabilityUnitPricePoints(basis, DEFAULT_PRICING_SETTINGS);
+      const expected = unitPricePointsForCapability(seed, DEFAULT_PRICING_SETTINGS);
-  it("the owner's comment rates still apply: 9 points a YouTube comment, 11 a Facebook comment", () => {
-    expect(computePublicCalculatorQuote("social-youtube-comments", 10).unitPricePoints).toBe(9);
-    expect(computePublicCalculatorQuote("social-facebook-comments", 10).unitPricePoints).toBe(11);
+  it("the per-record rates: cost of one delivered record x 5,500, fractional; the two video services keep their whole-point rate", () => {
+    expect(computePublicCalculatorQuote("social-x-posts", 10).unitPricePoints).toBe(0.11715);
+    expect(computePublicCalculatorQuote("social-youtube-comments", 10).unitPricePoints).toBe(0.275);
+    expect(computePublicCalculatorQuote("social-tiktok-comments", 10).unitPricePoints).toBe(0.275);
+    expect(computePublicCalculatorQuote("social-facebook-comments", 10).unitPricePoints).toBe(1.034);
+    expect(computePublicCalculatorQuote("social-facebook-posts", 10).unitPricePoints).toBe(3.4485);
+    expect(computePublicCalculatorQuote("social-tiktok-videos", 10).unitPricePoints).toBe(6);
+    expect(computePublicCalculatorQuote("social-youtube-videos", 10).unitPricePoints).toBe(5);
tests/table-driven-quote-calculator-alignment.test.ts
-  it("lists company research from the real live-priced source (0.00038 USD / 3 points per record)", () => {
+  it("lists company research from the real live-priced source (0.00038 USD per call; 3.168 points per delivered record, cost 0.000576 USD x 5,500)", () => {
-    expect(cap.pointsPerUnit).toBe(3);
+    expect(cap.pointsPerUnit).toBe(3.168);
-      const quote = calculateCapabilityQuote(tc.volume, cap.unitCostUsd, 100000, settings);
+      const quote = calculateCapabilityQuote(tc.volume, cap.unitCostUsd, 100000, settings, cap.slug);
tests/template-mission-channels.test.ts
-    expect(plan.planQuote.askedVolumeMax).toBe(500);
+    expect(plan.planQuote.targetVolumeMax).toBe(500);
+    expect(plan.planQuote.askedVolumeMax).toBeUndefined();
```
