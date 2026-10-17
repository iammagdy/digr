import { describe, it, expect } from "vitest";
import {
  escapeFormula,
  scrubProviderLeaks,
  detectPlatform,
  normalizeRecord,
  deduplicateRecords,
  computeKpis,
  generateDynamicCodebook,
  normalizeDataset,
} from "../src/lib/server/normalizationPipeline";

describe("Data Normalization Pipeline Suite", () => {
  describe("1. Security: Formula Injection Sanitization", () => {
    it("escapes leading formula characters (=, +, -, @, \\t, \\r) with a single quote", () => {
      expect(escapeFormula("=SUM(A1:A10)")).toBe("'=SUM(A1:A10)");
      expect(escapeFormula("+cmd|' /C calc'!A0")).toBe("'+cmd|' /C calc'!A0");
      expect(escapeFormula("-2+3*cmd")).toBe("'-2+3*cmd");
      expect(escapeFormula("@SUM(1,2)")).toBe("'@SUM(1,2)");
      expect(escapeFormula("\tmalicious")).toBe("'\tmalicious");
      expect(escapeFormula("\rmalicious")).toBe("'\rmalicious");
    });

    it("leaves safe strings and numbers unaffected", () => {
      expect(escapeFormula("تقرير منتخب مصر كأس العالم 2026")).toBe("تقرير منتخب مصر كأس العالم 2026");
      expect(escapeFormula("Hello World")).toBe("Hello World");
      expect(escapeFormula(12345)).toBe(12345);
      expect(escapeFormula(true)).toBe(true);
      expect(escapeFormula(null)).toBe(null);
    });
  });

  describe("2. Security: Upstream Provider Scrubbing", () => {
    it("recursively removes any keys containing provider names, tokens, or cost basis", () => {
      const rawWithLeaks = {
        title: "دراسة تحليلية",
        treg_cost_usd: 0.005,
        tikhub_account_id: "sec_991823",
        apify_run_id: "run_881",
        rapidapi_key: "secret_123",
        raw_provider_data: { internal_id: "priv_1" },
        user_text: "تعليق من يوتيوب",
        metrics: {
          views: 15000,
          token_cost: 0.0001,
          cost_usd: 0.02,
        },
      };

      const scrubbed = scrubProviderLeaks(rawWithLeaks);
      expect(scrubbed.title).toBe("دراسة تحليلية");
      expect(scrubbed.user_text).toBe("تعليق من يوتيوب");
      expect(scrubbed.metrics.views).toBe(15000);

      // Verify all sensitive keys are deleted
      expect(scrubbed.treg_cost_usd).toBeUndefined();
      expect(scrubbed.tikhub_account_id).toBeUndefined();
      expect(scrubbed.apify_run_id).toBeUndefined();
      expect(scrubbed.rapidapi_key).toBeUndefined();
      expect(scrubbed.raw_provider_data).toBeUndefined();
      expect(scrubbed.metrics.token_cost).toBeUndefined();
      expect(scrubbed.metrics.cost_usd).toBeUndefined();
    });
  });

  describe("3. Platform Detection", () => {
    it("correctly infers target platform from endpoint, slug, or query", () => {
      expect(detectPlatform("twitter.search.tweets")).toContain("X");
      expect(detectPlatform("x-keyword-search")).toContain("X");
      expect(detectPlatform("youtube.video.comments")).toContain("يوتيوب");
      expect(detectPlatform("tikhub.tiktok.user.posts")).toContain("تيك توك");
      expect(detectPlatform("facebook.page.posts")).toContain("فيسبوك");
      expect(detectPlatform("instagram.user.profile")).toContain("إنستغرام");
      expect(detectPlatform("google.serp.organic")).toContain("جوجل");
      // Owner decisions D4 / Arabic-only: the default source label is "مصادر متاحة".
      expect(detectPlatform("custom_leads")).toBe("مصادر متاحة");
    });
  });

  describe("4. Record Normalization across Modalities", () => {
    it("normalizes social posts (X tweets) into research attributes", () => {
      const rawTweet = {
        tweet_id: "18928374619283",
        created_at: "2026-06-15T18:30:00Z",
        screen_name: "egypt_fan_2026",
        authorName: "مشجع مصري",
        text: "=فوز تاريخي لمنتخب مصر أمام بلجيكا!",
        like_count: 450,
        retweet_count: 120,
        reply_count: 35,
        viewsCount: 15400,
        tweet_url: "https://x.com/egypt_fan_2026/status/18928374619283",
      };

      const norm = normalizeRecord(rawTweet, 0);
      expect(norm.id).toBe("rec_1");
      expect(norm.source_id).toBe("18928374619283");
      expect(norm.username).toBe("@egypt_fan_2026");
      expect(norm.author_name).toBe("مشجع مصري");
      expect(norm.text).toBe("'=فوز تاريخي لمنتخب مصر أمام بلجيكا!"); // Formula escaped
      expect(norm.likes_count).toBe(450);
      expect(norm.retweets_count).toBe(120);
      expect(norm.replies_count).toBe(35);
      expect(norm.views_count).toBe(15400);
      expect(norm.url).toBe("https://x.com/egypt_fan_2026/status/18928374619283");
    });

    it("normalizes comments (YouTube) with parent-child hierarchy", () => {
      const rawComment = {
        comment_id: "Ugx9823kjsd89",
        parentId: "Ugx0000000000",
        isReply: true,
        authorName: "Ahmed Ali",
        commentText: "أداء عالمي من الشناوي",
        like_count: 88,
        publishedAt: "2026-06-16T10:00:00Z",
      };

      const norm = normalizeRecord(rawComment, 1);
      expect(norm.id).toBe("rec_2");
      expect(norm.source_id).toBe("Ugx9823kjsd89");
      expect(norm.parent_id).toBe("Ugx0000000000");
      expect(norm.is_reply).toBe(true);
      expect(norm.author_name).toBe("Ahmed Ali");
      expect(norm.text).toBe("أداء عالمي من الشناوي");
      expect(norm.likes_count).toBe(88);
    });

    it("preserves arbitrary tabular columns without loss", () => {
      const rawCustom = {
        company_name: "Recycling Co",
        city: "Cairo",
        phone: "+201000000000",
        rating: 4.8,
        leads_count: 50,
      };

      const norm = normalizeRecord(rawCustom, 0);
      expect(norm.company_name).toBe("Recycling Co");
      expect(norm.city).toBe("Cairo");
      expect(norm.phone).toBe("'+201000000000"); // Sanitized because starts with +
      expect(norm.rating).toBe(4.8);
      expect(norm.leads_count).toBe(50);
    });
  });

  describe("5. Deduplication and Quality Control", () => {
    it("deduplicates identical records by source_id and content hash", () => {
      const rows = [
        { id: "rec_1", source_id: "t_101", text: "تغريدة 1", published_at: "2026-06-15" },
        { id: "rec_2", source_id: "t_101", text: "تغريدة 1 مكررة", published_at: "2026-06-15" },
        { id: "rec_3", source_id: "t_102", text: "تغريدة 2", published_at: "2026-06-16" },
        { id: "rec_4", text: "تغريدة 3 بدون معرف", published_at: "2026-06-17" },
        { id: "rec_5", text: "تغريدة 3 بدون معرف", published_at: "2026-06-17" },
      ];

      const { uniqueRows, duplicatesCount } = deduplicateRecords(rows);
      expect(uniqueRows.length).toBe(3);
      expect(duplicatesCount).toBe(2);
      expect(uniqueRows.map((r) => r.source_id || r.text)).toEqual(["t_101", "t_102", "تغريدة 3 بدون معرف"]);
    });

    it("computes accurate KPIs, completeness percentage, and temporal bounds", () => {
      const rows = [
        { id: "rec_1", views_count: 1000, likes_count: 50, retweets_count: 10, replies_count: 5, published_at: "2026-06-10" },
        { id: "rec_2", views_count: 2000, likes_count: 150, retweets_count: 20, replies_count: 15, published_at: "2026-06-20" },
      ];

      const kpis = computeKpis(rows, 1);
      expect(kpis.totalRecords).toBe(2);
      expect(kpis.totalViews).toBe(3000);
      expect(kpis.totalLikes).toBe(200);
      expect(kpis.totalShares).toBe(30);
      expect(kpis.totalComments).toBe(20);
      expect(kpis.earliestDate).toBe("2026-06-10");
      expect(kpis.latestDate).toBe("2026-06-20");
      expect(kpis.duplicatesRemoved).toBe(1);
      expect(kpis.dataCompletenessPct).toBe(100);
    });
  });

  describe("6. Dynamic Codebook Generator", () => {
    it("generates an Arabic codebook documenting every active column with descriptions and types", () => {
      const cols = ["id", "source_id", "username", "text", "likes_count", "published_at", "custom_metric"];
      const codebook = generateDynamicCodebook(cols, [{ custom_metric: 42 }]);

      expect(codebook.length).toBe(7);
      expect(codebook.find((c) => c.field === "text")?.titleAr).toBe("نص المحتوى");
      expect(codebook.find((c) => c.field === "likes_count")?.titleAr).toBe("عدد الإعجابات");
      expect(codebook.find((c) => c.field === "custom_metric")?.dataType).toContain("Integer");
    });

    it("documents contact-field statuses as presence only, not independent verification", () => {
      const codebook = generateDynamicCodebook(
        ["contact_name_presence_status", "work_email_presence_status", "job_title_presence_status"],
        [],
      );
      const descriptions = codebook.map((entry) => entry.descriptionAr).join(" ");
      expect(descriptions).toContain("لا يعني التحقق");
      expect(codebook.map((entry) => entry.titleAr)).toContain("توفر البريد المهني");
      expect(codebook.map((entry) => entry.titleAr)).toContain("توفر اسم جهة الاتصال");
    });
  });

  describe("7. End-to-End Dataset Normalization", () => {
    it("successfully transforms raw multi-modal payload into research deliverable structure", () => {
      const rawPayload = {
        metadata: {
          title: "بحث منتخب مصر كأس العالم 2026",
          template: "twitter.search.tweets",
          collectedAt: "2026-06-16T12:00:00Z",
        },
        rows: [
          { tweet_id: "101", text: "مصر وبلجيكا مباراة ممتازة", like_count: 100, retweets: 15, screen_name: "user1" },
          { tweet_id: "102", text: "تشكيل المنتخب الرسمي", like_count: 250, retweets: 40, screen_name: "user2" },
        ],
      };

      const norm = normalizeDataset(rawPayload);
      expect(norm.metadata.platform).toContain("X");
      expect(norm.metadata.entityType).toBe("posts");
      expect(norm.rows.length).toBe(2);
      expect(norm.kpis.totalLikes).toBe(350);
      expect(norm.kpis.totalShares).toBe(55);
      expect(norm.codebook.length).toBeGreaterThanOrEqual(4);
      expect(norm.metadata.methodology).toContain("المصادر المتاحة");
      expect(norm.metadata.methodology).not.toContain("Diger");
    });
  });

  describe("8. Relational Comment Hierarchy Grouping", () => {
    it("groups YouTube replies directly under their respective parent comment while preserving total count", () => {
      const rawComments = {
        metadata: {
          title: "تعليقات يوتيوب وثائقي",
          platform: "يوتيوب (YouTube)",
        },
        rows: [
          { comment_id: "c1", text: "تعليق رئيسي أول", is_reply: false },
          { comment_id: "c2", text: "تعليق رئيسي ثاني", is_reply: false },
          { comment_id: "r1_c1", text: "رد أول على التعليق الأول", is_reply: true, parent_id: "c1" },
          { comment_id: "r2_c1", text: "رد ثاني على التعليق الأول", is_reply: true, parent_id: "c1" },
          { comment_id: "r1_c2", text: "رد على التعليق الثاني", is_reply: true, parent_id: "c2" },
        ],
      };

      const norm = normalizeDataset(rawComments);
      expect(norm.rows.length).toBe(5);
      // c1 should be followed immediately by r1_c1 and r2_c1
      expect(norm.rows[0].source_id).toBe("c1");
      expect(norm.rows[1].source_id).toBe("r1_c1");
      expect(norm.rows[2].source_id).toBe("r2_c1");
      // then c2 followed by r1_c2
      expect(norm.rows[3].source_id).toBe("c2");
      expect(norm.rows[4].source_id).toBe("r1_c2");
    });
  });

  describe("9. Target Requested & Research Fact Preservation", () => {
    it("preserves explicit targetRequested or defaults to null if absent", () => {
      const payloadWithoutTarget = {
        metadata: { title: "بحث عام", platform: "X" },
        rows: [{ id: "1", text: "عينة" }],
      };
      const normWithout = normalizeDataset(payloadWithoutTarget);
      expect(normWithout.metadata.targetRequested).toBeNull();

      const payloadWithTarget = {
        metadata: { title: "بحث محدد", platform: "X", targetRequested: 250 },
        rows: [{ id: "1", text: "عينة" }],
      };
      const normWith = normalizeDataset(payloadWithTarget);
      expect(normWith.metadata.targetRequested).toBe(250);

      const normWithOptions = normalizeDataset(payloadWithoutTarget, { targetRequested: 500 });
      expect(normWithOptions.metadata.targetRequested).toBe(500);
    });
  });
});
