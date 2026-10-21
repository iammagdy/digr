# Existing tests changed by the 5,000-point cap and per-record pricing

Old = `-`, new = `+`. From `git diff origin/main -U0 -- tests`, modified files only (new test files are not listed). Each is a pin of the old cap (600), the old rounded unit price or the old flag-only driver, replaced by an equally strict assertion of the new value.

### tests/accept-after-failed-job.test.ts
```diff
-      expect(result.errorAr).toBe("رصيدك الحالي (٥٠ نقطة) غير كافٍ لتغطية تكلفة هذا العرض. يرجى شحن الرصيد أولاً.");
+      expect(result.errorAr).toBe("رصيدك الحالي (٥٠ نقطة) لا يكفي لحجز كامل هذا الطلب. اشحن رصيدك من صفحة الشحن ثم عُد لتوافق على الخطة.");
```

### tests/activity-events-and-failures.test.ts
```diff
-    expect(db.rpcCalls.find((call) => call.name === "settle_job_atomic")?.args).toMatchObject({ p_points_cap: 600 });
+    expect(db.rpcCalls.find((call) => call.name === "settle_job_atomic")?.args).toMatchObject({ p_points_cap: 5000 }); // the shared job cap (it was 600)
```

### tests/brief-and-question-schema.test.ts
```diff
-    expect(res.planQuote?.targetVolumeMax).toBe(86);
+    // the explicit count (100) is held whole: 100 company records at 3.168 points (reserve 365) fit the 5,000-point cap (the old 600-point cap cut it to 86)
+    expect(res.planQuote?.targetVolumeMax).toBe(100);
```

### tests/cap-text.test.tsx
```diff
-import { describe, expect, it, vi } from "vitest";
+import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
+import { resetProviderBalanceCacheForTesting, setProviderBalanceForTesting } from "../src/functions/shared/providerSpend";
```
```diff
- * Never shrink silently. With 2,000 comments asked, the plan used to say «up to 1,000» (a service ceiling) while the job cap cut
- * the plan to 57. Now: what was asked, what fits one job now, and why in one plain sentence. No cap value is changed here.
+ * Never shrink silently. When the plan holds fewer records than asked, it says what was asked, what fits one job now, and why in one
+ * plain sentence. (With 2,000 comments asked and the old 600-point cap the plan was cut to 57; at the 5,000-point cap and a per-record
+ * price of 0.275 points the same request fits whole, so the cut is shown with 37,500 X posts, which the cap holds only 37,113 of.)
```
```diff
+  // the provider side is out of the way, so the 5,000-point job cap is the limit under test
+  beforeEach(() => setProviderBalanceForTesting(10));
+  afterEach(() => resetProviderBalanceCacheForTesting());
+
```
```diff
-  it("2,000 comments asked: the text and the quote say 2,000 asked, 57 fit, and why; the goal line no longer says «up to 1,000»", async () => {
+  it("2,000 comments asked: they fit one job whole (reserve 633), so nothing is cut and no limit sentence is shown; the goal line says 2,000, not «up to 1,000»", async () => {
```
```diff
-    expect(quote.askedVolumeMax).toBe(2000);
-    expect(quote.targetVolumeMax).toBe(57);
-    expect(reply.contentAr).toContain("طلبت ٢٠٠٠ سجل، والذي يناسب الطلب الواحد الآن ٥٧ سجل. يتحدد الحد بسبب سقف المهمة الحالي.");
-    expect(reply.contentAr).toContain("حتى ٥٧ تعليقاً إجمالاً");
+    expect(quote.askedVolumeMax).toBeUndefined();
+    expect(quote.targetVolumeMax).toBe(2000);
+    expect(reply.contentAr).not.toContain(VOLUME_LIMIT_REASON_AR);
+    expect(reply.contentAr).toContain("حتى ٢٠٠٠ تعليقاً إجمالاً");
```
```diff
-    expect(quote.summaryAr).toContain("٥٧");
+    expect(quote.summaryAr).toContain("٢٠٠٠");
```
```diff
-  it("no cap value, unit price or reserve changed: the same 57 comments, 9 points each, 590 held, cap 600 as before this fix", async () => {
+  it("the plan numbers: the same 2,000 comments at 0.275 points each (550 charge), 633 held, the shared cap 5,000", async () => {
```
```diff
-    expect(quote).toMatchObject({ targetVolumeMax: 57, unitPricePoints: 9, quotedPoints: 590, pointsCap: 600, pointsCapConstrained: true });
+    expect(quote).toMatchObject({ targetVolumeMax: 2000, unitPricePoints: 0.275, expectedPoints: 550, quotedPoints: 633, pointsCap: 5000, pointsCapConstrained: false });
```
```diff
-  it("37,500 X posts: asked 37,500, fits 104, with the reason", async () => {
+  it("37,500 X posts: asked 37,500, fits 37,113 (the most whose reserve is within 5,000), with the reason", async () => {
```
```diff
-    expect(reply.contentAr).toContain("طلبت ٣٧٥٠٠ سجل، والذي يناسب الطلب الواحد الآن ١٠٤ سجل.");
+    expect(reply.planQuote).toMatchObject({ targetVolumeMax: 37113, expectedPoints: 4348, quotedPoints: 5000, pointsCap: 5000, pointsCapConstrained: true });
+    expect(reply.contentAr).toContain("طلبت ٣٧٥٠٠ سجل، والذي يناسب الطلب الواحد الآن ٣٧١١٣ سجل.");
```

### tests/capacity-cut-reason.test.tsx
```diff
-    setProviderBalanceForTesting(0.01);
+    // 0.001 USD budget (0.0009 safe) holds 18 comments at 0.00005 USD each, below the 30 asked
+    setProviderBalanceForTesting(0.001);
```

### tests/clarification-skip.test.ts
```diff
-    expect(responses[2].planQuote.askedVolumeMax).toBe(2000);
+    // 2,000 comments fit one job whole (reserve 633), so the count carries through as the plan's own: nothing is cut and no «asked» is needed
+    expect(responses[2].planQuote.targetVolumeMax).toBe(2000);
+    expect(responses[2].planQuote.askedVolumeMax).toBeUndefined();
```

### tests/composite-plan-pricing.test.ts
```diff
-    expect(quote.items[0].targetVolumeMax).toBe(57);
-    expect(quote.items[0].rawPoints).toBe(513);
-    expect(quote.items[0].itemReservation).toBe(590);
+    // 139 comments at 9 points = 1,251 charge, 1,439 reserve: they fit the 5,000-point cap whole, so nothing is cut
+    expect(quote.items[0].targetVolumeMax).toBe(139);
+    expect(quote.items[0].rawPoints).toBe(1251);
+    expect(quote.items[0].itemReservation).toBe(1439);
```
```diff
-    expect(quote.quotedPoints).toBe(589);
-    expect(quote.pointsCapConstrained).toBe(true);
+    // the whole plan (1,265 + 575 = 1,840) fits the 5,000-point cap, so it is not cut; the balance (500) is what falls short
+    expect(quote.quotedPoints).toBe(1840);
+    expect(quote.pointsCapConstrained).toBe(false);
```

### tests/coverage-doc.test.ts
```diff
-  it("the customer's YouTube comment price in the table is the one a plan quotes (9 points) and TikTok's is 6", () => {
-    expect(committed).toMatch(/social-youtube-comments`\) \|[^|]+\| سجل \| 9 \|/);
-    expect(committed).toMatch(/social-tiktok-comments`\) \|[^|]+\| سجل \| 6 \|/);
+  it("the customer's comment prices in the table are the ones a plan quotes: 0.275 points a YouTube comment and 0.275 a TikTok comment (0.00005 USD x 5,500)", () => {
+    expect(committed).toMatch(/social-youtube-comments`\) \|[^|]+\| سجل \| 0\.275 \|/);
+    expect(committed).toMatch(/social-tiktok-comments`\) \|[^|]+\| سجل \| 0\.275 \|/);
```

### tests/decision-makers-plan.test.ts
```diff
-    expect(q.quotedPoints).toBe(Math.min(600, Math.ceil(q.expectedPoints * 1.15)));
+    // 5 people x 193 = 965 charge; the reserve is ceil(965 x 1.15) = 1,110 (the 5,000-point cap does not clip it)
+    expect(q.expectedPoints).toBe(965);
+    expect(q.quotedPoints).toBe(Math.min(5000, Math.ceil(q.expectedPoints * 1.15)));
+    expect(q.quotedPoints).toBe(1110);
```

### tests/degraded-mode.test.ts
```diff
-  it("busy 15 s, model switch 30 s, driver 300 s; all public and with a stale window", async () => {
+  it("busy 15 s, model switch 30 s, driver 30 s (shorter than the 3-minute heartbeat window); all public and with a stale window", async () => {
```
```diff
-    expect((await driverStatus()).headers.get("cache-control")).toBe("public, s-maxage=300, stale-while-revalidate=300");
+    expect((await driverStatus()).headers.get("cache-control")).toBe("public, s-maxage=30, stale-while-revalidate=30");
```

### tests/dependent-mission.test.tsx
```diff
-    // the number the customer wrote (2000) is the comment cap; the comments service's own limit (1000) applies first
-    expect(r.planQuote.requestedVolumeMax).toBe(1000);
-    expect(r.planQuote.targetVolumeMax).toBeLessThanOrEqual(1000);
+    // the number the customer wrote (2000) is the comment cap; it is within the comments service's own limit (20,000) and the job cap, so it is held whole
+    expect(r.planQuote.requestedVolumeMax).toBe(2000);
+    expect(r.planQuote.targetVolumeMax).toBe(2000);
```

### tests/exploration-and-caps.test.ts
```diff
+import { reserveForUnits } from "../src/lib/recordPricing";
```
```diff
-        userId: "u_explore", message: "عايز ٣٠٠٠ تعليق من تيك توك عن كرة القدم في ٢٠٢٥", userBalance: 5000, personaProfile: { name: "سلمى" },
+        userId: "u_explore", message: "عايز ٨٠٠٠ تعليق من تيك توك عن كرة القدم في ٢٠٢٥", userBalance: 5000, personaProfile: { name: "سلمى" },
```
```diff
-      expect(offer.samplePoints).toBe(Math.ceil(offer.sampleUnits * unit * 1.15));
+      // exact: ceil(records x 0.275 x 1.15); the request is 8,000 comments = 2,200 points of charge, over the 1,500 that earns a sample offer
+      expect(unit).toBe(0.275);
+      expect(offer.samplePoints).toBe(reserveForUnits(offer.sampleUnits, unit));
```
```diff
-  it("the live cap is still 600", () => {
-    expect(DEFAULT_JOB_POINTS_CAP).toBe(600);
+  it("the live cap is the shared 5,000; the older 2,000 proposal is below it and changes nothing", () => {
+    expect(DEFAULT_JOB_POINTS_CAP).toBe(5000);
```
```diff
-    expect(getConfiguredJobPointsCap()).toBe(600);
+    expect(getConfiguredJobPointsCap()).toBe(5000);
+    expect(resolveJobPointsCap(getConfiguredJobPointsCap(), { enabled: true, customerConfirmedLarge: true })).toBe(5000);
```

### tests/extraction-benchmark.test.ts
```diff
-    // 4 x 83 + 3 x 55 + 2 x 55 = 607, capped at the job maximum of 600
-    expect(people.people!.chargePoints).toBe(600);
+    // 4 x 83 + 3 x 55 + 2 x 55 = 607: below the job maximum of 5,000 points, so nothing is clipped
+    expect(people.people!.chargePoints).toBe(607);
```

### tests/job-sizing.test.ts
```diff
-import { describe, it, expect, vi, beforeEach } from "vitest";
+import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
+import { resetProviderBalanceCacheForTesting, setProviderBalanceForTesting } from "../src/functions/shared/providerSpend";
```
```diff
-const writerXPosts = async () => {
+const writerXPosts = async (asked = "٥٠٠") => {
```
```diff
-  const res: any = await handler.handleUserMessage({ userId: "u_x", message: "هات ٥٠٠ تغريدة عن الغلاء على إكس آخر شهر", userBalance: 5000 });
+  const res: any = await handler.handleUserMessage({ userId: "u_x", message: `هات ${asked} تغريدة عن الغلاء على إكس آخر شهر`, userBalance: 20000 });
```
```diff
-  beforeEach(() => clearBriefCacheForTesting());
+  // The provider side is out of the way (a high balance, and a daily limit in points far above the cap), so the 5,000-point job cap is the ceiling
+  // that both the real quote and the public estimate show.
+  beforeEach(() => { clearBriefCacheForTesting(); setProviderBalanceForTesting(10); });
+  afterEach(() => resetProviderBalanceCacheForTesting());
```
```diff
-  it("decision makers: the public estimate says what the real quote says (3 people, 600 points held), for any size asked", async () => {
+  it("decision makers: the public estimate says what the real quote says (25 people, 5,000 points held), for any size asked", async () => {
```
```diff
-      expect(plan.targetVolumeMax).toBe(3);
-      const estimate: any = estimateMission({ kind: "people", volume: Number(asked.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))) });
+      // floor(5000 / 193) = 25 people (4,825 points of charge); the buffered hold is clipped to the cap
+      expect(plan.targetVolumeMax).toBe(25);
+      expect(plan.quotedPoints).toBe(5000);
+      const estimate: any = estimateMission({ kind: "people", volume: Number(asked.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))), dailyCapPoints: 100000 });
```
```diff
-      expect(estimateMission({ kind: "people", volume: plan.targetVolumeMax })).toMatchObject({ reservePoints: plan.quotedPoints, fitsInOneJob: true, jobsNeeded: 1 });
+      expect(estimateMission({ kind: "people", volume: plan.targetVolumeMax, dailyCapPoints: 100000 })).toMatchObject({ reservePoints: plan.quotedPoints, fitsInOneJob: true, jobsNeeded: 1 });
```
```diff
-  it("posts on X: the public estimate says what the real quote says (104 posts, 598 held)", async () => {
-    const plan = await writerXPosts();
-    expect(plan.targetVolumeMax).toBe(104);
-    expect(plan.quotedPoints).toBe(598);
-    expect(estimateMission({ kind: "posts", platform: "x", volume: 500 })).toMatchObject({ maxVolumeInOneJob: 104, fitsInOneJob: false });
-    expect(estimateMission({ kind: "posts", platform: "x", volume: 104 })).toMatchObject({ reservePoints: 598, fitsInOneJob: true });
+  it("posts on X: the public estimate says what the real quote says (500 posts fit whole: 68 held; 40,000 are cut to 37,113 posts, 5,000 held)", async () => {
+    const small = await writerXPosts();
+    expect(small.targetVolumeMax).toBe(500);
+    expect(small.quotedPoints).toBe(68);
+    expect(estimateMission({ kind: "posts", platform: "x", volume: 500, dailyCapPoints: 100000 })).toMatchObject({ maxVolumeInOneJob: 37113, fitsInOneJob: true, reservePoints: 68 });
+    const large = await writerXPosts("٤٠٠٠٠");
+    expect(large.targetVolumeMax).toBe(37113);
+    expect(large.quotedPoints).toBe(5000);
+    expect(estimateMission({ kind: "posts", platform: "x", volume: 40000, dailyCapPoints: 100000 })).toMatchObject({ maxVolumeInOneJob: 37113, fitsInOneJob: false });
+    expect(estimateMission({ kind: "posts", platform: "x", volume: 37113, dailyCapPoints: 100000 })).toMatchObject({ reservePoints: 5000, fitsInOneJob: true });
```
```diff
-      for (const dailyCapPoints of [undefined, 600, 200]) {
+      for (const dailyCapPoints of [undefined, 100000, 600, 200]) {
```
```diff
-    expect(detailed.cappedReservedPoints).toBe(600);
+    // 579 x 1.15 = 665.85 -> 666 held (the 5,000-point cap does not clip it)
+    expect(detailed.cappedReservedPoints).toBe(666);
```
```diff
-    const fresh: any = estimateMission({ kind: "posts", platform: "x", volume: 500 });
-    const live: any = estimateMission({ kind: "posts", platform: "x", volume: 500, dailyCapPoints: 200 });
-    expect(fresh.jobCapPoints).toBe(600);
+    const fresh: any = estimateMission({ kind: "posts", platform: "x", volume: 50000, dailyCapPoints: 100000 });
+    const live: any = estimateMission({ kind: "posts", platform: "x", volume: 50000, dailyCapPoints: 200 });
+    expect(fresh.jobCapPoints).toBe(5000);
```
```diff
-    const detailed = computePublicCalculatorQuote("social-x-posts", 500, 500, undefined, undefined, undefined, undefined, 200);
+    const detailed = computePublicCalculatorQuote("social-x-posts", 50000, 50000, undefined, undefined, undefined, undefined, 200);
```
```diff
+    // with no live reading both use the provider's default daily limit in points (0.80 USD = 4,400), which is below the cap
+    const unread: any = estimateMission({ kind: "posts", platform: "x", volume: 50000 });
+    expect(unread.jobCapPoints).toBe(4400);
+    expect(computePublicCalculatorQuote("social-x-posts", 50000, 50000).maxCapPoints).toBe(4400);
```

### tests/large-counts.test.ts
```diff
+import { resetProviderBalanceCacheForTesting, setProviderBalanceForTesting } from "../src/functions/shared/providerSpend";
```
```diff
-  it("٥ آلاف تعليق: asked 5000, planned within the job's ceiling, the reason said plainly, the topic without «آلاف»", async () => {
+  it("٥ آلاف تعليق: 5,000 comments are held whole (1,375 points of charge, 1,582 held), the topic without «آلاف»", async () => {
```
```diff
-    expect(quote.askedVolumeMax).toBe(5000);
-    expect(quote.targetVolumeMax).toBeLessThan(5000);
-    expect(quote.pointsCapConstrained).toBe(true);
-    expect(quote.quotedPoints).toBeLessThanOrEqual(600);
+    expect(quote.askedVolumeMax).toBeUndefined();
+    expect(quote.targetVolumeMax).toBe(5000);
+    expect(quote.pointsCapConstrained).toBe(false);
+    expect(quote.expectedPoints).toBe(1375);
+    expect(quote.quotedPoints).toBe(1582);
```
```diff
-    expect(body.contentAr).toContain("طلبت ٥٠٠٠");
```
```diff
+  it("٣٠ ألف تعليق: asked 30,000, cut to what the service and the job cap hold (15,810), the reason said plainly", async () => {
+    setProviderBalanceForTesting(10);
+    try {
+      const body = await ask("big_3", "٣٠ ألف تعليق على تيك توك عن كرة القدم خلال الشهر الماضي");
+      const quote = body.planQuote;
+      expect(quote.askedVolumeMax).toBe(30000);
+      expect(quote.targetVolumeMax).toBe(15810);
+      expect(quote.pointsCapConstrained).toBe(true);
+      expect(quote.quotedPoints).toBe(5000);
+      expect(quote.items[0].params.query).toBe("كرة القدم");
+      expect(body.contentAr).toContain("طلبت ٣٠٠٠٠");
+    } finally {
+      resetProviderBalanceCacheForTesting();
+    }
+  });
+
```

### tests/live-cap-surfaces.test.ts
```diff
-    expect(withDefault.result.jobCapPoints).toBe(600);
+    // no live reading: the provider's default daily limit in points (0.80 USD = 4,400), below the 5,000-point job cap
+    expect(withDefault.result.jobCapPoints).toBe(4400);
```

### tests/long-job-chunk-sizing.test.ts
```diff
-  it("the rows of a chunk: 50 today, configurable between 10 and 500, the default unchanged", () => {
-    expect(SOCIAL_ROWS_PER_CHUNK).toBe(50);
-    expect(socialRowsPerChunk()).toBe(50);
+  it("the rows of a chunk: 100 by default (it was 50), configurable between 10 and 500", () => {
+    expect(SOCIAL_ROWS_PER_CHUNK).toBe(100);
+    expect(socialRowsPerChunk()).toBe(100);
```
```diff
-  it("a fast source with the default chunk (50 rows): 60 chunks for 3,000 rows, at most four calls each (three pages of comments and the video search), as before", async () => {
-    setScaleOverridesForTesting({ absoluteMaxPages: 200 });
+  it("a fast source with a 50-row chunk (the earlier default): 60 chunks for 3,000 rows, at most four calls each (three pages of comments and the video search), as before", async () => {
+    setScaleOverridesForTesting({ absoluteMaxPages: 200, socialRowsPerChunk: 50 });
```

### tests/long-job-running-set.test.ts
```diff
-  beforeEach(() => { restore = setupEnv(); setScaleOverridesForTesting({ absoluteMaxPages: 200 }); });
+  // these scenarios are about the running records, written for 50-row chunks: the chunk size is set explicitly (the platform default is now 100)
+  beforeEach(() => { restore = setupEnv(); setScaleOverridesForTesting({ absoluteMaxPages: 200, socialRowsPerChunk: 50 }); });
```

### tests/long-job-scale-harness.test.ts
```diff
-beforeEach(() => { restore = setupEnv(); });
+// the scenarios below were written for 50-row chunks; the platform default is now 100, so the chunk size is set explicitly where a scenario depends on it
+beforeEach(() => { restore = setupEnv(); setScaleOverridesForTesting({ socialRowsPerChunk: 50 }); });
```
```diff
-describe("the configuration of the ceilings: the defaults are today's numbers", () => {
-  it("every ceiling defaults to what the platform runs on, and every value is clamped", () => {
+describe("the configuration of the ceilings: the defaults are sized for the 5,000-point job cap", () => {
+  it("every ceiling defaults to the number that fits the job cap (800 pages of 100 rows, 50 videos), and every value is clamped", () => {
+    setScaleOverridesForTesting(null); // the file sets 50-row chunks for its scenarios; this test reads the real defaults
```
```diff
-    expect(scaleValue("absoluteMaxPages", empty)).toBe(30);
+    expect(scaleValue("absoluteMaxPages", empty)).toBe(800);
```
```diff
-    expect(scaleValue("maxVideosPerJob", empty)).toBe(20);
+    expect(scaleValue("maxVideosPerJob", empty)).toBe(50);
+    expect(scaleValue("socialRowsPerChunk", empty)).toBe(100);
```
```diff
-    expect(ABSOLUTE_MAX_PAGES).toBe(30);
+    expect(ABSOLUTE_MAX_PAGES).toBe(800);
```
```diff
-    expect(scaleValue("absoluteMaxPages", { LONG_JOB_MAX_PAGES: "abc" })).toBe(30);
+    expect(scaleValue("absoluteMaxPages", { LONG_JOB_MAX_PAGES: "abc" })).toBe(800);
```
```diff
-    // with nothing set, the services keep their documented ceilings
-    expect(getSocialCapability("social-tiktok-comments")!.maxRows).toBe(1000);
-    expect(getSocialCapability("social-x-posts")!.maxRows).toBe(500);
+    // with nothing set, the services carry the ceilings sized to the 5,000-point job cap (the most records one job's reserve holds:
+    // 37,113 X posts, 15,810 comments, 4,204 Facebook comments) and the source-limited ones keep theirs
+    expect(getSocialCapability("social-tiktok-comments")!.maxRows).toBe(20000);
+    expect(getSocialCapability("social-youtube-comments")!.maxRows).toBe(20000);
+    expect(getSocialCapability("social-facebook-comments")!.maxRows).toBe(5000);
+    expect(getSocialCapability("social-x-posts")!.maxRows).toBe(40000);
```
```diff
-    expect(maxPagesForJob(5000, SOCIAL_ROWS_PER_CHUNK, "feed")).toBe(30);
+    expect(maxPagesForJob(50_000, SOCIAL_ROWS_PER_CHUNK, "feed")).toBe(800);
```
```diff
-    expect(maxPagesForJob(5000, SOCIAL_ROWS_PER_CHUNK, "feed")).toBe(300); // ceil(5000/50) x allowance 3, under the new ceiling
-    expect(scaleValue("absoluteMaxPages", { NODE_ENV: "production" })).toBe(30);
+    expect(maxPagesForJob(50_000, SOCIAL_ROWS_PER_CHUNK, "feed")).toBe(400); // ceil(50,000/100) x allowance 3 = 1,500, under the lower ceiling
+    expect(maxPagesForJob(5000, SOCIAL_ROWS_PER_CHUNK, "feed")).toBe(150); // ceil(5000/100) x allowance 3
+    expect(scaleValue("absoluteMaxPages", { NODE_ENV: "production" })).toBe(800);
```
```diff
-  it("the page ceiling times the rows of a chunk is the real size limit of a feed job today (30 x 50 = 1,500)", () => {
-    expect(maxPagesForJob(50_000, SOCIAL_ROWS_PER_CHUNK, "feed") * SOCIAL_ROWS_PER_CHUNK).toBe(1500);
+  it("the page ceiling times the rows of a chunk is the real size limit of a feed job (800 x 100 = 80,000 rows: about twice the 37,113 posts the job cap holds)", () => {
+    expect(maxPagesForJob(50_000, SOCIAL_ROWS_PER_CHUNK, "feed") * SOCIAL_ROWS_PER_CHUNK).toBe(80_000);
```
```diff
-  it("DEFAULT ceilings: a 3,000-record job stops at the page ceiling with what it has (1,500), settled once for the delivered rows only", async () => {
+  it("the EARLIER ceilings (30 pages of 50 rows, set explicitly): a 3,000-record job stops at the page ceiling with what it has (1,500), settled once for the delivered rows only", async () => {
+    setScaleOverridesForTesting({ absoluteMaxPages: 30, socialRowsPerChunk: 50 });
```
```diff
-  it("RAISED page ceiling (test config only): the same job reaches its full 3,000 through 60 chunks", async () => {
-    setScaleOverridesForTesting({ absoluteMaxPages: 200 });
+  it("DEFAULT ceilings now: the same 3,000-record job reaches its full 3,000 through 30 chunks of 100 rows, settled once", async () => {
+    setScaleOverridesForTesting(null);
+    installProvider(big());
+    const jobId = seedSocialJob({ target: 3000, videoCount: 20, perVideo: 150 });
+    const run = await driveToTheEnd(jobId, { maxTicks: 200 });
+    expect(run.finalStatus).toBe("completed");
+    expect(run.chunks).toBeLessThanOrEqual(40);
+    const job = settledOnce(jobId);
+    expect(job.delivered_units).toBe(3000);
+    expect(new Set(finalRows(jobId).map((row) => row.comment_id)).size).toBe(3000);
+    for (const seconds of db.chunkSeconds) expect(seconds).toBeLessThanOrEqual(45);
+  }, 60_000);
+
+  it("RAISED page ceiling with 50-row chunks (test config): the same job reaches its full 3,000 through 60 chunks", async () => {
+    setScaleOverridesForTesting({ absoluteMaxPages: 200, socialRowsPerChunk: 50 });
```

### tests/long-mission-progress-and-notices.test.tsx
```diff
-  it("the driver-status endpoint reports the flag and defaults to «tab»", async () => {
+  it("the driver-status endpoint defaults to «tab», and says «cron» only with the flag AND a fresh tick", async () => {
```
```diff
-      expect(await (await driverStatus()).json()).toEqual({ mode: "tab" });
+      expect(await (await driverStatus()).json()).toEqual({ mode: "tab", configured: "tab" });
+      // the flag alone is not enough: no tick was ever recorded here, so the page must stay open
```
```diff
-      expect(await (await driverStatus()).json()).toEqual({ mode: "cron" });
+      expect(await (await driverStatus()).json()).toEqual({ mode: "tab", configured: "cron" });
```
```diff
-      expect(await (await driverStatus()).json()).toEqual({ mode: "tab" });
+      expect(await (await driverStatus()).json()).toEqual({ mode: "tab", configured: "tab" });
```
```diff
-    expect(readFileSync("src/app/api/chat/accept-quote/route.ts", "utf8")).toContain("driverMode: longJobDriverMode()");
-    expect(readFileSync("src/hooks/useDriverMode.ts", "utf8")).toContain('useState<DriverMode>(cached ?? "tab")');
+    expect(readFileSync("src/app/api/chat/accept-quote/route.ts", "utf8")).toContain("driverMode: await currentDriverMode(adminClient)");
+    const hook = readFileSync("src/hooks/useDriverMode.ts", "utf8");
+    expect(hook).toContain('useState<DriverMode>("tab")');
+    expect(hook).toContain('.catch(() => { if (alive) setMode("tab"); })');
+    expect(hook).toContain("setInterval(read, REFRESH_MS)");
```

### tests/low-balance-flow.test.ts
```diff
+    // 3 company records at 3.168 points: 9.504 -> charge 10; reserve ceil(9.504 x 1.15 = 10.93) = 11
+    expect(expected.unit).toBe(3.168);
```
```diff
-    expect(expected.expected).toBe(9);
+    expect(expected.expected).toBe(10);
```

### tests/measurement-plan.test.ts
```diff
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
```
```diff
-  it("the owner's two limits cannot both hold: only companies fit 20 points at the specified volume, and nothing can for decision makers", () => {
+  it("the owner's two limits: at the per-record prices only the channels mission, the Facebook page posts and decision makers quote above 20 points at the specified volume", () => {
```
```diff
-    expect(over).toEqual(["youtube-comments", "tiktok-comments", "tiktok-channels-top-videos", "x-posts-event", "facebook-page-posts", "decision-makers"]);
+    expect(over).toEqual(["tiktok-channels-top-videos", "facebook-page-posts", "decision-makers"]);
```
```diff
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
```
```diff
-    expect(adjusted.quote).toMatchObject({ volume: 80, cutToOneJob: false, quotedPoints: 552, settledIfAllDeliveredPoints: 480 });
+    expect(adjusted.quote).toMatchObject({ volume: 80, cutToOneJob: false, quotedPoints: 26, settledIfAllDeliveredPoints: 22 });
```
```diff
-    for (const needle of ["0.02134", "0.01934", "552 points", "138", "193", "0.0084 (8)", "0.00288 (1)"]) expect(doc).toContain(needle);
+    for (const needle of ["0.02134", "0.01934", "26 points", "138", "193", "0.0084 (8)", "0.00288 (1)"]) expect(doc).toContain(needle);
```

### tests/mission-duration.test.tsx
```diff
-    // 37,500 posts at 50 a call is 750 calls and 750 chunks of 50: the pages of a day, said honestly
+    // 37,500 posts at 50 a call is 750 calls in 375 chunks of 100 rows: about 1 to 15 hours with the page open, said honestly
```
```diff
-    expect(big.chunks).toBe(750);
-    expect(big.exceedsDay).toBe(true);
-    expect(view(posts(37500)).longNoteAr).toContain("أكثر من يوم");
+    expect(big.chunks).toBe(375);
+    expect(big.exceedsDay).toBe(false);
+    expect(view(posts(37500)).rangeAr).toBe("من ساعة إلى ١٥ ساعة");
+    // a request of 100,000 posts is more than a day and says so
+    expect(duration(posts(100000)).exceedsDay).toBe(true);
+    expect(view(posts(100000)).longNoteAr).toContain("أكثر من يوم");
```
```diff
-    expect(view(comments(50000)).longNoteAr).toContain("أكثر من يوم");
+    expect(view(comments(100000)).longNoteAr).toContain("أكثر من يوم");
```
```diff
-    expect(render(baseQuote({ duration: view(comments(50000)) }))).toContain('data-testid="plan-duration-long"');
+    expect(render(baseQuote({ duration: view(comments(100000)) }))).toContain('data-testid="plan-duration-long"');
```
```diff
-    const ok = await call({ kind: "comments", platform: "youtube", volume: 500 });
+    const ok = await call({ kind: "comments", platform: "youtube", volume: 30000 });
```
```diff
-    // 500 comments do not fit one request: the endpoint states the duration of the records ONE request holds
+    // 30,000 comments do not fit one request: the endpoint states the duration of the records ONE request holds
```
```diff
-  it("a 2,000-comment YouTube request: the plan has a labelled range, and still 57 comments at 9 points, 590 held, cap 600", async () => {
+  it("a 2,000-comment YouTube request: the plan has a labelled range, and holds 1,500 comments (3 videos x 500, the most they can give) at 0.275 points, 475 held, cap 5,000", async () => {
```
```diff
-    expect(plan.planQuote).toMatchObject({ targetVolumeMax: 57, unitPricePoints: 9, quotedPoints: 590, pointsCap: 600 });
+    expect(plan.planQuote).toMatchObject({ targetVolumeMax: 1500, unitPricePoints: 0.275, quotedPoints: 475, pointsCap: 5000 });
```

### tests/mission-estimate.test.ts
```diff
-  it("a request bigger than one job's limit says so, with the jobs needed", () => {
-    const r = estimateMission({ kind: "comments", platform: "youtube", volume: 5000 });
+  it("a request bigger than one job's limit says so, with the jobs needed (30,000 comments: one job holds 13,913 at the default limit of 4,400 points)", () => {
+    const r = estimateMission({ kind: "comments", platform: "youtube", volume: 30000 });
```
```diff
-    expect(r.jobsNeeded).toBeGreaterThan(1);
+    expect(r.maxVolumeInOneJob).toBe(13913);
+    expect(r.jobsNeeded).toBe(3);
```
```diff
+  it("5,000 comments fit one job whole (reserve 1,582 points)", () => {
+    const r = estimateMission({ kind: "comments", platform: "youtube", volume: 5000 });
+    expect(r.status === "ok" && r.fitsInOneJob && r.jobsNeeded === 1 && r.reservePoints === 1582).toBe(true);
+  });
+
```

### tests/owner-conversation-regression.test.ts
```diff
-    // The live ledger for this exact request: reserve 11, charge 9.
+    // 3 company records at 3.168 points (measured cost 0.000576 USD x 5,500): charge 10, reserve 11 (the live ledger of the old whole-point price was 9 and 11).
```
```diff
-    expect(first.contentAr).toContain("التكلفة المتوقعة: ٩ نقطة");
+    expect(first.contentAr).toContain("التكلفة المتوقعة: ١٠ نقطة");
```
```diff
-    expect(reply.contentAr).toContain("الحجز المتوقع ٦٠٠ نقطة");
+    expect(reply.contentAr).toContain("الحجز المتوقع ٦٦٦ نقطة");
```
```diff
-    expect(reply.contentAr).toContain("الحجز المتوقع ٦٠٠ نقطة");
+    expect(reply.contentAr).toContain("الحجز المتوقع ٦٦٦ نقطة");
```
```diff
-    expect(card.match(/onStart\(quote\)/g)!.length).toBe(1);
-    expect(card).toContain("onClick={() => onStart(quote)}");
+    expect(card.match(/onStart\(quote/g)!.length).toBe(1);
+    // the approve click also carries the customer's own confirmation of a reserve above 600 points (a tick), never an inferred one
+    expect(card).toContain("onClick={() => onStart(quote, { confirmedLargeReserve: !needsLargeConfirm || largeReserveConfirmed })}");
```

### tests/p2-execution-and-plans.test.ts
```diff
-    // 2. Edit 1: change limit to 300
+    // 2. Edit 1: change limit to 3000 (3 points a record: the 5,000-point cap alone would hold 1,449; the provider's default daily limit,
+    //    0.80 USD with a 10% margin, holds 0.72 / 0.0005 = 1,440 records, which is the lower ceiling here)
```
```diff
-      { action: "set_limit", capabilitySlug: "x-keyword-search", targetVolumeMax: 300 },
+      { action: "set_limit", capabilitySlug: "x-keyword-search", targetVolumeMax: 3000 },
```
```diff
-    expect(quote2.targetVolumeMax).toBe(173);
+    expect(quote2.targetVolumeMax).toBe(1440);
+    expect(quote2.quotedPoints).toBe(4968);
```

### tests/people-settlement-readiness.test.ts
```diff
-  it("prices three people at 579 points and caps only the buffered reserve at 600", async () => {
+  it("prices three people at 579 points and holds 666 (the 5,000-point cap does not clip it)", async () => {
```
```diff
-    expect(quote.quotedPoints).toBe(600);
+    // 579 x 1.15 = 665.85 -> 666 held; the 5,000-point cap does not clip it (it clipped to 600 before)
+    expect(quote.quotedPoints).toBe(666);
+    expect(quote.pointsCapConstrained).toBe(false);
+    expect(client.insertedQuotes[0].total_reserved_credits).toBe(666);
+  });
+
+  it("26 people are 5,018 points of charge: the plan is cut to 25 people (4,825 points) and only the buffered reserve is capped at 5,000", async () => {
+    const client = makeQuoteClient(async (name, args) => name === "settle_people_job_atomic"
+      ? { data: null, error: { code: "P0001", message: `Job ${args.p_job_id} not found` } }
+      : { data: null, error: { code: "PGRST202", message: "Could not find the function" } });
+    const quote = await createAndSaveManagedQuote(client as any, {
+      conversationId: "offline-twenty-six-people",
+      userId: "offline-test-user",
+      plan: {
+        summaryAr: "ثلاثة صناع قرار في مصر",
+        items: [{
+          capabilitySlug: "professional-people-search",
+          endpointId: "treg.people.search",
+          params: { requiredContactFields: ["work_email", "phone"], country: "EG" },
+          targetVolumeMin: 26,
+          targetVolumeMax: 26,
+        }],
+        outputFormats: ["xlsx"],
+      },
+      userBalance: 10000,
+      capabilities: [peopleCapability],
+      pricingSettings: DEFAULT_PRICING_SETTINGS,
+    });
+    expect((quote.items[0] as any).contactUnitPricesPoints).toEqual({ basePerson: 83, workEmail: 55, phone: 55 });
+    expect(quote.items[0].unitPricePoints).toBe(193);
+    // the charge is cut to the cap first (floor(5000 / 193) = 25 people = 4,825), then only the buffered reserve is clipped to the cap
+    expect(quote.expectedPoints).toBe(4825);
+    expect(quote.targetVolumeMax).toBe(25);
+    expect(quote.quotedPoints).toBe(5000);
```
```diff
-    expect(client.insertedQuotes[0].total_reserved_credits).toBe(600);
+    expect(client.insertedQuotes[0].total_reserved_credits).toBe(5000);
```

### tests/plan-default-labels.test.tsx
```diff
+import { resetProviderBalanceCacheForTesting, setProviderBalanceForTesting } from "../src/functions/shared/providerSpend";
```
```diff
-    const tapped = planOf(await conversation(["عايز كل تعليقات ٣ فيديوهات على يوتيوب عن منتخب مصر", answer("volume_cap_required", CAP_Q, "٥٠٠ تعليق")]));
+    // a count tapped on the cap card that is larger than one job holds: the card says «طلبت» (30,000 asked, 15,810 held)
+    setProviderBalanceForTesting(10);
+    const tapped = planOf(await conversation(["عايز كل تعليقات ٣ فيديوهات على يوتيوب عن منتخب مصر", answer("volume_cap_required", CAP_Q, "٣٠٠٠٠ تعليق")]));
+    resetProviderBalanceCacheForTesting();
```
```diff
-    expect(tappedHtml).toContain("طلبت ٥٠٠");
+    expect(tappedHtml).toContain("طلبت ٣٠٠٠٠");
```

### tests/plan-editing-and-calculator.test.ts
```diff
+import { resetProviderBalanceCacheForTesting, setProviderBalanceForTesting } from "../src/functions/shared/providerSpend";
```
```diff
-  it("calculates 3 points per record and 18 points reserved for 5 company records based on verified live 0.00038 USD cost", () => {
-    // 0.00038 USD * 55 EGP * 10 markup / 0.10 EGP = 2.09 -> ceil = 3 points per unit
+  it("calculates 3.168 points per delivered company record (measured cost 0.000576 USD x 5,500): 5 records charge 16 and reserve 19", () => {
+    // the old whole-point rule on the call price is unchanged for other services: 0.00038 USD * 55 EGP * 10 markup / 0.10 EGP = 2.09 -> ceil = 3
```
```diff
-    expect(quoteBreakdown.unitPricePoints).toBe(3);
+    expect(quoteBreakdown.unitPricePoints).toBe(3.168);
```
```diff
-    // 5 * 3 = 15 raw points * 1.15 buffer = 17.25 -> ceil = 18 points reserved
-    expect(quoteBreakdown.reservedPoints).toBe(18);
-    expect(quoteBreakdown.chargedPoints).toBe(15);
+    // 5 * 3.168 = 15.84 raw points -> charge ceil = 16; * 1.15 buffer = 18.216 -> reserve ceil = 19 points
+    expect(quoteBreakdown.reservedPoints).toBe(19);
+    expect(quoteBreakdown.chargedPoints).toBe(16);
```
```diff
-    expect(quoteBreakdown.reservedEgp).toBe(1.80);
-    expect(quoteBreakdown.chargedEgp).toBe(1.50);
+    expect(quoteBreakdown.reservedEgp).toBe(1.90);
+    expect(quoteBreakdown.chargedEgp).toBe(1.60);
```
```diff
-  it("strictly enforces 600-point cap and provides coherent capped numbers for 100 Facebook comments", () => {
-    // 100 comments @ 11 points = 1100 raw points -> 1265 reserved -> exceeds 600 cap
+  it("strictly enforces the 5,000-point cap and provides coherent capped numbers for 500 Facebook comments", () => {
+    // 500 comments @ 11 points = 5500 raw points -> 6325 reserved -> exceeds the 5,000 cap
```
```diff
-      100,
-      100,
+      500,
+      500,
```
```diff
-      DEFAULT_JOB_POINTS_CAP
+      DEFAULT_JOB_POINTS_CAP,
+      5 // the provider's daily limit in USD: high enough that the job cap, not the daily limit, is the ceiling
```
```diff
-    expect(breakdown.maxCapPoints).toBe(600);
-    // floor(600 / (11 * 1.15)) = floor(600 / 12.65) = 47 records
-    expect(breakdown.maxCappedVolume).toBe(47);
-
-    // Capped values strictly match the 600-point cap and 47 delivered records
-    expect(breakdown.cappedReservedPoints).toBe(595);
-    expect(breakdown.cappedReservedEgp).toBe(59.5);
-    // 47 * 11 = 517 points
-    expect(breakdown.cappedChargedPoints).toBe(517);
-    expect(breakdown.cappedChargedEgp).toBe(51.7);
-    // 595 - 517 = 78 points
-    expect(breakdown.cappedRefundPoints).toBe(78);
-    expect(breakdown.cappedRefundEgp).toBe(7.8);
-
-    expect(breakdown.reservedPoints).toBe(595);
-    expect(breakdown.chargedPoints).toBe(517);
+    expect(breakdown.maxCapPoints).toBe(5000);
+    // floor(5000 / (11 * 1.15)) = floor(5000 / 12.65) = 395 records
+    expect(breakdown.maxCappedVolume).toBe(395);
+
+    // Capped values strictly match the 5,000-point cap and 395 delivered records
+    expect(breakdown.cappedReservedPoints).toBe(4997);
+    expect(breakdown.cappedReservedEgp).toBe(499.7);
+    // 395 * 11 = 4345 points
+    expect(breakdown.cappedChargedPoints).toBe(4345);
+    expect(breakdown.cappedChargedEgp).toBe(434.5);
+    // 4997 - 4345 = 652 points
+    expect(breakdown.cappedRefundPoints).toBe(652);
+    expect(breakdown.cappedRefundEgp).toBe(65.2);
+
+    expect(breakdown.reservedPoints).toBe(4997);
+    expect(breakdown.chargedPoints).toBe(4345);
+  });
+
+  it("the default provider daily limit (0.80 USD = 4,400 points) is still the lower ceiling of the calculator until the owner raises it", () => {
+    const breakdown = computePublicCalculatorQuote("facebook-post-comments", 500, 500, APPROVED_CAPABILITY_CATALOG, DEFAULT_PRICING_SETTINGS, DEFAULT_JOB_POINTS_CAP);
+    expect(breakdown.maxCapPoints).toBe(4400);
+    expect(breakdown.cappedReservedPoints).toBeLessThanOrEqual(4400);
```
```diff
+    setProviderBalanceForTesting(10);
```
```diff
-      conversationId: "cap-test", userId: "user-test", userBalance: 1000,
+      conversationId: "cap-test", userId: "user-test", userBalance: 10000,
```
```diff
-      plan: { summaryAr: "تعليقات مقطع", items: [{ capabilitySlug: cap.slug, params: {}, targetVolumeMin: 1, targetVolumeMax: 100 }], outputFormats: ["xlsx"] },
+      plan: { summaryAr: "تعليقات مقطع", items: [{ capabilitySlug: cap.slug, params: {}, targetVolumeMin: 1, targetVolumeMax: 30000 }], outputFormats: ["xlsx"] },
```
```diff
+    resetProviderBalanceCacheForTesting();
```
```diff
-    expect(quote.requestedVolumeMax).toBe(100);
-    expect(quote.targetVolumeMax).toBe(57);
-    expect(quote.expectedPoints).toBe(513);
-    expect(quote.quotedPoints).toBe(590);
-    expect(quote.quotedPoints).toBeLessThanOrEqual(600);
+    expect(quote.requestedVolumeMax).toBe(30000);
+    // 0.275 points a comment: the most records whose reserve fits 5,000 is 15,810 (4,347.75 charge, 4,999.76 reserve)
+    expect(quote.targetVolumeMax).toBe(15810);
+    expect(quote.expectedPoints).toBe(4348);
+    expect(quote.quotedPoints).toBe(5000);
+    expect(quote.quotedPoints).toBeLessThanOrEqual(5000);
```
```diff
-    expect(calcResult.reservedPoints).toBe(18);
-    expect(calcResult.chargedPoints).toBe(15);
+    expect(calcResult.reservedPoints).toBe(19);
+    expect(calcResult.chargedPoints).toBe(16);
```

### tests/planning-quality.test.ts
```diff
-    const { responses } = await runConversation(["هات ٥٠٠ تغريدة عن كرة السلة في ٢٠٢٥"]);
+    const { responses } = await runConversation(["هات ٢٠٠٠٠ تغريدة عن كرة السلة في ٢٠٢٥"]);
```
```diff
+    // 20,000 posts at 0.11715 points are 2,343 points of charge: over the 1,500 that earns a sample offer (500 posts are 59 points: no offer)
```

### tests/provider-balance-awareness.test.ts
```diff
-      expect(quote.targetVolumeMax).toBe(86);
-      expect(quote.items[0].targetVolumeMax).toBe(86);
+      // the capacity cut (90 records) is the only cut: 90 x 6 points x 1.15 = 621 reserve fits the 5,000-point cap
+      expect(quote.targetVolumeMax).toBe(90);
+      expect(quote.items[0].targetVolumeMax).toBe(90);
+      expect(quote.quotedPoints).toBe(621);
+      expect(quote.pointsCapConstrained).toBe(false);
```

### tests/provider-call-caps.test.ts
```diff
-    expect(maxPagesForJob(600, 10)).toBe(ABSOLUTE_MAX_PAGES);
+    expect(maxPagesForJob(600, 10)).toBe(180);
+    expect(maxPagesForJob(100000, 10)).toBe(ABSOLUTE_MAX_PAGES);
+    expect(ABSOLUTE_MAX_PAGES).toBe(800);
```
```diff
-    expect(readFileSync("src/functions/shared/providerSpend.ts", "utf8")).toContain("DEFAULT_JOB_POINTS_CAP = 600");
+    // the job cap is one shared constant (5,000, raised from 600 by the price-and-cap work); providerSpend reads it from there
+    expect(readFileSync("src/functions/shared/providerSpend.ts", "utf8")).toContain("DEFAULT_JOB_POINTS_CAP = JOB_MAX_POINTS_CAP");
+    expect(readFileSync("src/lib/jobPointsCap.ts", "utf8")).toContain("JOB_MAX_POINTS_CAP = 5000");
```

### tests/public-pages-people-and-latin.test.tsx
```diff
-import { DEFAULT_JOB_POINTS_CAP } from "../src/lib/calculatorPricing";
+import { DEFAULT_JOB_POINTS_CAP, DEFAULT_PROVIDER_DAILY_SPEND_CAP_USD, dailyCapPointsFor } from "../src/lib/calculatorPricing";
```
```diff
-const SIZING_NUMBER = recordsInOneJob({ unitPricePoints: person, capPoints: DEFAULT_JOB_POINTS_CAP, safetyBuffer: DEFAULT_PRICING_SETTINGS.safetyBuffer, chargeCapped: true });
+// with no live reading the pages use the provider's default daily limit in points (0.80 USD = 4,400), which is below the 5,000-point job cap
+const SIZING_NUMBER = recordsInOneJob({ unitPricePoints: person, capPoints: Math.min(DEFAULT_JOB_POINTS_CAP, dailyCapPointsFor(DEFAULT_PROVIDER_DAILY_SPEND_CAP_USD)), safetyBuffer: DEFAULT_PRICING_SETTINGS.safetyBuffer, chargeCapped: true 
```
```diff
-  it("is built from the shared sizing function: three decision makers today, in the owner's own wording", () => {
-    expect(SIZING_NUMBER).toBe(3);
+  it("is built from the shared sizing function: 22 decision makers today (floor(4,400 / 193)), in the owner's own wording", () => {
+    expect(SIZING_NUMBER).toBe(22);
```
```diff
-    expect(SENTENCE).toBe("الطلب الواحد يتسع حتى ٣ صناع قرار؛ ويمكنك تقديم أكثر من طلب.");
+    expect(SENTENCE).toBe("الطلب الواحد يتسع حتى ٢٢ صانع قرار؛ ويمكنك تقديم أكثر من طلب.");
+    // and with the live limit above the cap the job cap itself holds 25
+    expect(decisionMakersPerRequest({ dailyCapPoints: 100000 })).toBe(25);
```

### tests/real-provider-balance.test.tsx
```diff
-    return handler.handleUserMessage({ userId: "user_rb", conversationId: "conv_rb", message: "٣٠ تعليق تيك توك عن كرة القدم في مصر خلال الشهر الماضي", userBalance: 5000 });
+    return handler.handleUserMessage({ userId: "user_rb", conversationId: "conv_rb", // 300 comments cost 0.015 USD at 0.00005 USD a delivered comment (30 comments cost 0.0015, which fits even the estimate balance)
+    message: "٣٠٠ تعليق تيك توك عن كرة القدم في مصر خلال الشهر الماضي", userBalance: 5000 });
```
```diff
-    expect(response.planQuote.targetVolumeMax).toBe(30);
+    expect(response.planQuote.targetVolumeMax).toBe(300);
```
```diff
-    expect(response.planQuote.targetVolumeMax).toBeLessThan(30);
+    expect(response.planQuote.targetVolumeMax).toBeLessThan(300);
```
```diff
-    setRealBalanceReaderForTesting(async () => ({ usd: 0.02, at: Date.now() }));
+    setRealBalanceReaderForTesting(async () => ({ usd: 0.01, at: Date.now() }));
```
```diff
-    expect(response.planQuote.targetVolumeMax).toBeLessThan(30);
+    expect(response.planQuote.targetVolumeMax).toBeLessThan(300);
```

### tests/result-followup-routing.test.ts
```diff
-    expect(reply).toContain("الحجز المتوقع ٦٠٠ نقطة");
+    expect(reply).toContain("الحجز المتوقع ٦٦٦ نقطة");
```

### tests/segment-pages.test.tsx
```diff
-  it("an example bigger than one job says it needs several requests (no hidden cap)", () => {
-    const big = segmentExample(SEGMENTS.find((s) => s.slug === "researchers")!);
+  it("an example bigger than one job says it needs several requests (no hidden cap); the real examples now fit one job whole", () => {
+    const researchers = SEGMENTS.find((s) => s.slug === "researchers")!;
+    const big = segmentExample({ ...researchers, estimate: { kind: "comments", platform: "youtube", volume: 100000 } });
```
```diff
+    for (const segment of SEGMENTS) expect(segmentExample(segment).notesAr, segment.slug).toEqual([]);
```

### tests/social-plans.test.ts
```diff
-    expect(res.planQuote.expectedPoints).toBe(res.planQuote.unitPricePoints * 20);
-    expect(res.planQuote.quotedPoints).toBe(Math.ceil(res.planQuote.expectedPoints * 1.15));
+    // 0.275 points a comment (0.00005 USD x 5,500): 20 comments are 5.5 points -> charge 6; the reserve is ceil(5.5 x 1.15 = 6.325) = 7
+    expect(res.planQuote.unitPricePoints).toBe(0.275);
+    expect(res.planQuote.expectedPoints).toBe(6);
+    expect(res.planQuote.quotedPoints).toBe(7);
```
```diff
-    expect(item.targetVolumeMax).toBe(57);
-    expect(res.contentAr).toContain("٥٧");
+    // 100 comments are 27.5 points (reserve 32): they fit one job whole, so nothing is cut
+    expect(item.targetVolumeMax).toBe(100);
+    expect(res.planQuote.quotedPoints).toBe(32);
+    expect(res.contentAr).toContain("١٠٠");
```

### tests/social-quantities-and-defaults.test.ts
```diff
-    expect(plan.planQuote.askedVolumeMax).toBe(DEFAULT_COMMENTS_CAP);
+    // the default (500 comments, 138 points of charge) fits one job whole: the plan holds it all and says no cut
+    expect(plan.planQuote.targetVolumeMax).toBe(DEFAULT_COMMENTS_CAP);
+    expect(plan.planQuote.askedVolumeMax).toBeUndefined();
```
```diff
-    expect(plan.contentAr).toContain("لكن الطلب الواحد يتسع الآن لـ");
+    expect(plan.contentAr).not.toContain("لكن الطلب الواحد يتسع الآن لـ");
```
```diff
-    // 200 asked; the job's own points cap decides how many fit (unchanged), and the plan says so
-    expect(responses[0].planQuote.askedVolumeMax).toBe(200);
-    expect(responses[0].contentAr).toContain("طلبت ٢٠٠ سجل");
+    // 200 asked (4 videos x 50): the whole request fits one job, so the plan holds 200 and says no cut
+    expect(responses[0].planQuote.targetVolumeMax).toBe(200);
+    expect(responses[0].planQuote.askedVolumeMax).toBeUndefined();
+    expect(responses[0].contentAr).not.toContain("طلبت ٢٠٠ سجل");
```
```diff
-    expect(plan.planQuote.askedVolumeMax).toBe(DEFAULT_RECORDS_CAP);
+    expect(plan.planQuote.targetVolumeMax).toBe(DEFAULT_RECORDS_CAP);
+    expect(plan.planQuote.askedVolumeMax).toBeUndefined();
```

### tests/social-sources.test.ts
```diff
-  const { calculateCapabilityUnitPricePoints, DEFAULT_PRICING_SETTINGS } = await import("../src/functions/shared/quotes");
+  const { unitPricePointsForCapability, DEFAULT_PRICING_SETTINGS } = await import("../src/functions/shared/quotes");
```
```diff
-    it(`${cap.slug}: calculator unit price equals the quote writer's (customer rate when set, else cost basis)`, () => {
+    it(`${cap.slug}: calculator unit price equals the quote writer's (the one shared pricing function)`, () => {
```
```diff
-      const basis = seed.customerPriceUsdPerItem && seed.customerPriceUsdPerItem > 0 ? seed.customerPriceUsdPerItem : seed.unitCostUsd;
-      const expected = calculateCapabilityUnitPricePoints(basis, DEFAULT_PRICING_SETTINGS);
+      const expected = unitPricePointsForCapability(seed, DEFAULT_PRICING_SETTINGS);
```
```diff
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
```

### tests/social-worker.test.ts
```diff
+import { setScaleOverridesForTesting } from "../src/lib/scaleConfig";
```
```diff
+    setScaleOverridesForTesting(null);
```
```diff
+    // written for two chunks of 50 rows (the platform default is now 100)
+    setScaleOverridesForTesting({ socialRowsPerChunk: 50 });
```

### tests/table-driven-quote-calculator-alignment.test.ts
```diff
-  it("lists company research from the real live-priced source (0.00038 USD / 3 points per record)", () => {
+  it("lists company research from the real live-priced source (0.00038 USD per call; 3.168 points per delivered record, cost 0.000576 USD x 5,500)", () => {
```
```diff
-    expect(cap.pointsPerUnit).toBe(3);
+    expect(cap.pointsPerUnit).toBe(3.168);
```
```diff
-      const quote = calculateCapabilityQuote(tc.volume, cap.unitCostUsd, 100000, settings);
+      const quote = calculateCapabilityQuote(tc.volume, cap.unitCostUsd, 100000, settings, cap.slug);
```

### tests/template-mission-channels.test.ts
```diff
-    expect(plan.planQuote.askedVolumeMax).toBe(500);
+    expect(plan.planQuote.targetVolumeMax).toBe(500);
+    expect(plan.planQuote.askedVolumeMax).toBeUndefined();
```
```diff
-    expect(plan.planQuote.items[0].params.videoCount).toBe(20);
+    // 2,000 comments by topic: 30 videos (the videos ceiling is now 50, it was 20)
+    expect(plan.planQuote.items[0].params.videoCount).toBe(30);
```
