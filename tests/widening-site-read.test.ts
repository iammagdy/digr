import { describe, expect, it } from "vitest";
import {
  buildEntityWebsiteWideningOffer,
  executeEntityWebsiteWidening,
  buildRetrievalUiDeliveryPayload,
  computeScopeCounters,
  tagRowWithScope,
  ENTITY_SITE_SCOPE_LABEL_AR,
  PRIMARY_SCOPE_LABEL_AR,
} from "../agent/src/llmPlanner/widening";
import { checkPublicReadUrl } from "../src/lib/multiProvider/policy";

describe("TREG Phase 6: Scope-Separated Site-Reading Widening & Crawl Billing", () => {
  it("Must-Pass 1: Entity Official Site Widening Offered with correct shape, kind, and scope", () => {
    const offer = buildEntityWebsiteWideningOffer(
      "https://www.moh.gov.sa",
      "قراءة الموقع الرسمي للجهة والبيانات الصحفية الصادرة عنه",
      "فحص بيانات نفي الشائعات والتصريحات الرسمية المنشورة على موقع الوزارة مباشرة."
    );

    expect(offer.kind).toBe("entity_website");
    expect(offer.scope).toBe("widened_entity_site");
    expect(offer.targetUrl).toBe("https://www.moh.gov.sa");
    expect(offer.titleAr).toContain("الموقع الرسمي للجهة");
    expect(offer.descriptionAr).toContain("نفي الشائعات");
  });

  it("Must-Pass 1 & Scope Separation: Primary count is strictly separated from widened entity site rows", () => {
    // 5 primary tweets from @SaudiMOH
    const primaryRows = Array.from({ length: 5 }, (_, i) =>
      tagRowWithScope(
        { id: `tweet_${i + 1}`, text: `تغريدة رسمية ${i + 1}`, author: "SaudiMOH" },
        "primary_account",
        PRIMARY_SCOPE_LABEL_AR
      )
    );

    // 3 accepted press release rows from official site
    const entitySiteRows = Array.from({ length: 3 }, (_, i) =>
      tagRowWithScope(
        { id: `press_${i + 1}`, title: `بيان صحفي ${i + 1}`, url: `https://www.moh.gov.sa/news/${i + 1}` },
        "widened_entity_site",
        ENTITY_SITE_SCOPE_LABEL_AR
      )
    );

    for (const r of primaryRows) {
      expect(r.scope).toBe("primary_account");
      expect(r.scope_label_ar).toBe(PRIMARY_SCOPE_LABEL_AR);
    }

    for (const r of entitySiteRows) {
      expect(r.scope).toBe("widened_entity_site");
      expect(r.scope_label_ar).toBe("الموقع الرسمي للجهة");
    }

    const payload = buildRetrievalUiDeliveryPayload(
      primaryRows,
      entitySiteRows,
      [],
      [buildEntityWebsiteWideningOffer("https://www.moh.gov.sa")],
      "الموقع الرسمي للجهة"
    );

    // Primary count is strictly true_n (5), never merged into 8
    expect(payload.true_n).toBe(5);
    expect(payload.primary_count).toBe(5);
    expect(payload.widened_count).toBe(3);
    expect(payload.scope_breakdown.primary).toBe(5);
    expect(payload.scope_breakdown.widened).toBe(3);
    expect(payload.scope_breakdown.entitySite).toBe(3);
    expect(payload.scope_breakdown.total).toBe(8);
    expect(payload.summary_ar).toContain("وجدنا ٥ من الحساب المطلوب، بالإضافة إلى ٣ من الموقع الرسمي للجهة.");
  });

  it("Must-Pass 5: Zero-Delivery Zero-Charge Invariant (4 pages inspected but 0 matching topic rows -> 0 points billed)", async () => {
    let pagesRead = 0;
    const result = await executeEntityWebsiteWidening({
      targetUrl: "https://www.moh.gov.sa",
      siteMapFn: async (_url) => ({
        urls: [
          "https://www.moh.gov.sa/page1",
          "https://www.moh.gov.sa/page2",
          "https://www.moh.gov.sa/page3",
          "https://www.moh.gov.sa/page4",
        ],
      }),
      pageReadFn: async (url) => {
        pagesRead++;
        return { markdown: `General content of ${url} without rumors topic`, finalUrl: url };
      },
      // Topic judge rejects all 4 pages as off-topic
      judgeFn: async () => ({ accepted: false }),
    });

    expect(pagesRead).toBe(4);
    expect(result.pagesRead).toBe(4);
    expect(result.acceptedRows).toHaveLength(0);
    // Crucial rule: Customer billed EXCLUSIVELY for delivered matching rows, NEVER for raw crawled pages
    expect(result.customerPointsBilled).toBe(0);
  });

  it("Must-Pass: When matching rows are delivered, customer points are billed with minimum charge respected", async () => {
    let pagesRead = 0;
    const result = await executeEntityWebsiteWidening({
      targetUrl: "https://www.moh.gov.sa",
      siteMapFn: async (_url) => ({
        urls: [
          "https://www.moh.gov.sa/news/rumor-clarification-1",
          "https://www.moh.gov.sa/news/rumor-clarification-2",
          "https://www.moh.gov.sa/page3",
        ],
      }),
      pageReadFn: async (url) => {
        pagesRead++;
        return { markdown: `Official statement on rumors at ${url}`, title: `بيان نفي شائعة ${pagesRead}`, finalUrl: url };
      },
      judgeFn: async (page) => {
        if (page.url.includes("rumor-clarification")) {
          return { accepted: true, row: { title: page.title, statement: "نفي قاطع للشائعة المتداولة" } };
        }
        return { accepted: false };
      },
    });

    expect(result.pagesRead).toBe(3);
    expect(result.acceptedRows).toHaveLength(2);
    expect(result.acceptedRows[0].scope).toBe("widened_entity_site");
    expect(result.acceptedRows[0].scope_label_ar).toBe(ENTITY_SITE_SCOPE_LABEL_AR);
    expect(result.customerPointsBilled).toBeGreaterThanOrEqual(200);
  });

  it("Counter-Case 1: Target behind login or private host is blocked immediately with 0 billed", async () => {
    // Intranet host
    const intranetResult = checkPublicReadUrl("https://intranet.moh.gov.sa/portal");
    expect(intranetResult.ok).toBe(false);
    expect(intranetResult.reason).toBe("private_host");

    // Login page
    const loginResult = checkPublicReadUrl("https://www.moh.gov.sa/login");
    expect(loginResult.ok).toBe(false);
    expect(loginResult.reason).toBe("login_page");

    // Execution engine refuses target URL upfront
    const execResult = await executeEntityWebsiteWidening({
      targetUrl: "https://intranet.moh.gov.sa",
      siteMapFn: async () => ({ urls: ["https://intranet.moh.gov.sa/secret"] }),
      pageReadFn: async () => ({ markdown: "secret" }),
      judgeFn: async () => ({ accepted: true }),
    });

    expect(execResult.discoveredUrls).toHaveLength(0);
    expect(execResult.pagesRead).toBe(0);
    expect(execResult.acceptedRows).toHaveLength(0);
    expect(execResult.customerPointsBilled).toBe(0);
  });

  it("Counter-Case 2: Massive unbounded crawl attempt clamped to max 50 on map and strictly <= 4 pages read", async () => {
    // 20,000 URLs returned by site map
    const massiveUrls = Array.from({ length: 20000 }, (_, i) => `https://www.moh.gov.sa/articles/post-${i + 1}`);
    let mapLimitRequested = 0;
    let pagesReadCount = 0;

    const result = await executeEntityWebsiteWidening({
      targetUrl: "https://www.moh.gov.sa",
      limit: 1000, // caller asks for 1000
      maxPages: 10, // caller asks for 10
      siteMapFn: async (_url, _filter, limit) => {
        mapLimitRequested = limit ?? 0;
        return { urls: massiveUrls.slice(0, limit) };
      },
      pageReadFn: async (url) => {
        pagesReadCount++;
        return { markdown: `Article content for ${url}`, finalUrl: url };
      },
      judgeFn: async () => ({ accepted: true, row: { headline: "خبر معتمد" } }),
    });

    // Clamped to max 50 for discovery
    expect(mapLimitRequested).toBeLessThanOrEqual(50);
    expect(result.discoveredUrls.length).toBeLessThanOrEqual(50);
    // Strictly bounded to <= 4 pages read
    expect(pagesReadCount).toBe(4);
    expect(result.pagesRead).toBe(4);
    expect(result.acceptedRows).toHaveLength(4);
  });
});
