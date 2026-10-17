import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  executeMultiStepJob,
  extractAndFlattenRows,
  flattenRow,
  generateMethodologyText,
  parseIcypeasCompaniesResponse,
} from "../src/functions/shared/multiStepWorker";
import {
  reserveCredits,
  calculateBalance,
} from "../src/functions/shared/ledger";
import {
  resetProviderDailySpendForTesting,
  setMemoryProviderDailySpendUsdForTesting,
} from "../src/functions/shared/providerSpend";

interface StoredRow {
  $id: string;
  data: Record<string, any>;
  permissions: any[];
}

describe("People-search field presence wording", () => {
  it("does not invent a contact person from a company name", () => {
    const { rows } = parseIcypeasCompaniesResponse({ leads: [{
      name: "Solar Sunlight GmbH", industry: "Renewables & Environment", location: "Germany",
    }] });
    expect(rows[0].company_name).toBe("Solar Sunlight GmbH");
    expect(rows[0].contact_name).toBe("");
    expect(rows[0].contact_name_presence_status).toBe("غير موجود");
    expect(rows[0].job_title_presence_status).toBe("غير موجود");
  });
  it("reports presence only and never labels inferred field presence as verification", () => {
    const { rows } = parseIcypeasCompaniesResponse({ leads: [
      { firstname: "Rana", lastname: "Ali", currentJobTitle: "CFO", workEmail: "rana@example.com" },
      { firstname: "Omar", lastname: "Kamal" },
    ] });

    expect(rows[0].work_email_presence_status).toBe("موجود");
    expect(rows[0].contact_name_presence_status).toBe("موجود");
    expect(rows[0].job_title_presence_status).toBe("موجود");
    expect(rows[1].contact_name_presence_status).toBe("موجود");
    expect(rows[1].work_email_presence_status).toBe("غير موجود");
    expect(rows[1].job_title_presence_status).toBe("غير موجود");
    for (const row of rows) {
      expect(row).not.toHaveProperty("verification_status");
      expect(row).not.toHaveProperty("email_verification_status");
      expect(row).not.toHaveProperty("title_verification_status");
    }
  });
});

class MockTablesDB {
  public rows: Map<string, StoredRow> = new Map();

  async createRow({
    databaseId,
    tableId,
    rowId,
    data,
    permissions,
  }: {
    databaseId: string;
    tableId: string;
    rowId: string;
    data: Record<string, any>;
    permissions?: any[];
  }) {
    const key = `${tableId}:${rowId}`;
    if (this.rows.has(key)) {
      const err: any = new Error(`Row with ID ${rowId} already exists in ${tableId}`);
      err.code = 409;
      err.status = 409;
      throw err;
    }
    const record: StoredRow = {
      $id: rowId,
      data: { ...data, $id: rowId },
      permissions: permissions || [],
    };
    this.rows.set(key, record);
    return record.data;
  }

  async listRows({
    databaseId,
    tableId,
    queries = [],
  }: {
    databaseId: string;
    tableId: string;
    queries?: any[];
  }) {
    const prefix = `${tableId}:`;
    let items = Array.from(this.rows.entries())
      .filter(([k]) => k.startsWith(prefix))
      .map(([, v]) => v.data);

    for (const q of queries) {
      if (typeof q === "string") {
        try {
          const parsed = JSON.parse(q);
          const method = parsed.method;
          const attr = parsed.attribute;
          const vals = parsed.values;

          if (method === "equal") {
            items = items.filter((it) => {
              if (Array.isArray(vals[0])) {
                return vals[0].includes(it[attr]);
              }
              return vals.includes(it[attr]);
            });
          } else if (method === "greaterThanEqual") {
            items = items.filter((it) => it[attr] >= vals[0]);
          } else if (method === "limit") {
            items = items.slice(0, vals[0]);
          }
        } catch {}
      }
    }

    return { total: items.length, rows: items };
  }

  async getRow({
    databaseId,
    tableId,
    rowId,
  }: {
    databaseId: string;
    tableId: string;
    rowId: string;
  }) {
    const key = `${tableId}:${rowId}`;
    if (!this.rows.has(key)) {
      const err: any = new Error(`Row ${rowId} not found in ${tableId}`);
      err.code = 404;
      err.status = 404;
      throw err;
    }
    return this.rows.get(key)!.data;
  }

  async updateRow({
    databaseId,
    tableId,
    rowId,
    data,
  }: {
    databaseId: string;
    tableId: string;
    rowId: string;
    data: Record<string, any>;
  }) {
    const key = `${tableId}:${rowId}`;
    if (!this.rows.has(key)) {
      const err: any = new Error(`Row ${rowId} not found in ${tableId}`);
      err.code = 404;
      err.status = 404;
      throw err;
    }
    const current = this.rows.get(key)!;
    current.data = { ...current.data, ...data };
    return current.data;
  }
}

class MockStorage {
  public files: Map<string, { buffer: any; permissions: any[] }> = new Map();

  async createFile(bucketId: string, fileId: string, file: any, permissions: any[]) {
    this.files.set(`${bucketId}:${fileId}`, { buffer: file, permissions });
    return { $id: fileId };
  }

  async deleteFile(bucketId: string, fileId: string) {
    this.files.delete(`${bucketId}:${fileId}`);
  }
}

describe("Phase C: Generic Executor in job-worker and multiStepWorker", () => {
  let tables: MockTablesDB;
  let storage: MockStorage;
  const userId = "user_phase_c_test";
  const origEnv = process.env;

  beforeEach(() => {
    tables = new MockTablesDB();
    storage = new MockStorage();
    process.env = {
      ...origEnv,
      TREG_LIVE: "true",
      TREG_TOKEN: "mock_treg_token_abc",
      NODE_ENV: "test",
    };
    resetProviderDailySpendForTesting();
  });

  afterEach(() => {
    process.env = origEnv;
    vi.restoreAllMocks();
  });

  describe("1. Generic Row Extraction & Flattening", () => {
    it("flattens top-level and 1 nested level, joins primitive arrays with comma", () => {
      const input = {
        id: "123",
        text: "Sample post",
        user: { name: "Magdy", handle: "iammagdy" },
        stats: { likes: 150, shares: 20 },
        tags: ["ai", "news", "egypt"],
      };

      const flattened = flattenRow(input);
      expect(flattened.id).toBe("123");
      expect(flattened.text).toBe("Sample post");
      expect(flattened.user_name).toBe("Magdy");
      expect(flattened.user_handle).toBe("iammagdy");
      expect(flattened.stats_likes).toBe(150);
      expect(flattened.stats_shares).toBe(20);
      expect(flattened.tags).toBe("ai, news, egypt");
    });

    it("extracts and flattens rows from various envelope structures ({data}, {items}, {results})", () => {
      const withData = { data: [{ a: 1, nested: { b: 2 } }] };
      const resData = extractAndFlattenRows(withData);
      expect(resData).toHaveLength(1);
      expect(resData[0].a).toBe(1);
      expect(resData[0].nested_b).toBe(2);

      const withItems = { items: [{ id: "x", stats: { views: 10 } }] };
      const resItems = extractAndFlattenRows(withItems);
      expect(resItems).toHaveLength(1);
      expect(resItems[0].stats_views).toBe(10);

      const withResults = { results: [{ tweet_id: "99" }] };
      const resResults = extractAndFlattenRows(withResults);
      expect(resResults).toHaveLength(1);
      expect(resResults[0].tweet_id).toBe("99");
    });
  });

  describe("2. Endpoint Pagination Styles (Cursor, Offset, Single-Page)", () => {
    it("executes cursor pagination, attaches Idempotency-Key and X-Treg-Meta, and finishes when target count reached", async () => {
      const jobId = "job_cursor_test";
      const reservedCredits = 30;

      await reserveCredits(tables as any, userId, jobId, reservedCredits, "حجز رصيد لاختبار التمرير بالمؤشر");
      await tables.createRow({
        databaseId: "digr",
        tableId: "jobs",
        rowId: jobId,
        data: {
          userId,
          templateSlug: "x-keyword-search",
          params: JSON.stringify({ query: "AI Trends" }),
          status: "queued",
          estCredits: 20,
          reservedCredits,
        },
      });

      const capturedHeaders: Headers[] = [];

      global.fetch = vi.fn().mockImplementation(async (url: string, opts: any) => {
        // The adapter reads the live endpoint schema first (a catalog GET, not a billed call); answer it with no schema.
        if (String(url).includes("/catalog/endpoints/")) return new Response("{}", { status: 200 });
        const headers = new Headers(opts.headers);
        capturedHeaders.push(headers);
        const body = JSON.parse(opts.body || "{}");

        if (!body.cursor) {
          // Page 1
          return new Response(
            JSON.stringify({
              data: [
                { id: "tweet_1", text: "First tweet", user: { name: "Alice" } },
                { id: "tweet_2", text: "Second tweet", user: { name: "Bob" } },
              ],
              next_cursor: "cursor_page_2",
            }),
            {
              status: 200,
              headers: { "x-treg-cost-micro": "5000", "x-treg-call-id": "treg_call_1" },
            }
          );
        } else {
          // Page 2
          return new Response(
            JSON.stringify({
              data: [
                { id: "tweet_3", text: "Third tweet", user: { name: "Charlie" } },
              ],
              next_cursor: null,
            }),
            {
              status: 200,
              headers: { "x-treg-cost-micro": "5000", "x-treg-call-id": "treg_call_2" },
            }
          );
        }
      });

      const result = await executeMultiStepJob(tables as any, storage as any, {
        jobId,
        targetVolumeMax: 3,
        unitPricePoints: 2,
        reservedCredits,
        userId,
        templateSlug: "x-keyword-search",
        params: { query: "AI Trends" },
        steps: [
          {
            stepId: "step_x",
            endpointId: "treg.twitter.tweets",
            params: { query: "AI Trends" },
            targetVolumeMax: 3,
            paginationStrategy: "cursor",
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe("done");
      expect(result.deliveredUnits).toBe(3);
      expect(result.chargedCredits).toBe(6); // 3 * 2 points

      // Verify headers
      expect(capturedHeaders.length).toBe(2);
      expect(capturedHeaders[0].get("Idempotency-Key")).toBe(`job_${jobId}_step_step_x_p1`);
      expect(capturedHeaders[1].get("Idempotency-Key")).toBe(`job_${jobId}_step_step_x_p2`);

      const meta0 = capturedHeaders[0].get("X-Treg-Meta") || "";
      expect(meta0).toContain(`customer=${userId}`);
      expect(meta0).toContain(`job=${jobId}`);
      expect(meta0).toContain("step=step_x");

      // Verify storage files uploaded
      expect(storage.files.has(`results:xlsx_${jobId}`)).toBe(true);
      expect(storage.files.has(`results:pdf_${jobId}`)).toBe(true);
      expect(storage.files.has(`results:csv_${jobId}`)).toBe(true);
      expect(storage.files.has(`results:methodology_${jobId}`)).toBe(true);
      expect(storage.files.has(`job_data:json_${jobId}`)).toBe(true);
    });

    it("executes offset pagination with limit/offset advancement until batch is smaller than limit", async () => {
      const jobId = "job_offset_test";
      const reservedCredits = 25;

      await reserveCredits(tables as any, userId, jobId, reservedCredits, "حجز رصيد لاختبار الأوفست");
      await tables.createRow({
        databaseId: "digr",
        tableId: "jobs",
        rowId: jobId,
        data: {
          userId,
          templateSlug: "youtube-search",
          params: JSON.stringify({ query: "tech", limit: 2 }),
          status: "queued",
          estCredits: 15,
          reservedCredits,
        },
      });

      const requestedOffsets: number[] = [];

      global.fetch = vi.fn().mockImplementation(async (url: string, opts: any) => {
        // The adapter reads the live endpoint schema first (a catalog GET, not a billed call); answer it with no schema.
        if (String(url).includes("/catalog/endpoints/")) return new Response("{}", { status: 200 });
        const body = JSON.parse(opts.body || "{}");
        requestedOffsets.push(body.offset);

        if (body.offset === 0) {
          return new Response(
            JSON.stringify({
              items: [
                { videoId: "v1", title: "Video 1", stats: { views: 100 } },
                { videoId: "v2", title: "Video 2", stats: { views: 200 } },
              ],
            }),
            { status: 200, headers: { "x-treg-cost-micro": "4000" } }
          );
        } else {
          // Offset 2: returns 1 item (< limit 2), loop terminates
          return new Response(
            JSON.stringify({
              items: [
                { videoId: "v3", title: "Video 3", stats: { views: 300 } },
              ],
            }),
            { status: 200, headers: { "x-treg-cost-micro": "4000" } }
          );
        }
      });

      const result = await executeMultiStepJob(tables as any, storage as any, {
        jobId,
        targetVolumeMax: 10,
        unitPricePoints: 1,
        reservedCredits,
        userId,
        templateSlug: "youtube-search",
        params: { query: "tech", limit: 2 },
        steps: [
          {
            stepId: "step_yt",
            endpointId: "treg.youtube.search",
            params: { query: "tech", limit: 2 },
            targetVolumeMax: 10,
            paginationStrategy: "offset",
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.deliveredUnits).toBe(3);
      expect(requestedOffsets).toEqual([0, 2]);
    });

    it("executes single-page style (none) for profile extraction", async () => {
      const jobId = "job_single_test";
      const reservedCredits = 10;

      await reserveCredits(tables as any, userId, jobId, reservedCredits, "حجز رصيد لطلب صفحة واحدة");
      await tables.createRow({
        databaseId: "digr",
        tableId: "jobs",
        rowId: jobId,
        data: {
          userId,
          templateSlug: "tiktok-profile",
          params: JSON.stringify({ username: "iammagdy" }),
          status: "queued",
          estCredits: 10,
          reservedCredits,
        },
      });

      let callCount = 0;
      global.fetch = vi.fn().mockImplementation(async (url: any) => {
        // Schema lookup (catalog GET) is not a billed provider call and must not count as a page or attempt.
        if (String(url).includes("/catalog/endpoints/")) return new Response("{}", { status: 200 });
        callCount++;
        return new Response(
          JSON.stringify({
            data: {
              uniqueId: "iammagdy",
              nickname: "Magdy",
              followerCount: 2500,
            },
          }),
          { status: 200, headers: { "x-treg-cost-micro": "3000" } }
        );
      });

      const result = await executeMultiStepJob(tables as any, storage as any, {
        jobId,
        targetVolumeMax: 1,
        unitPricePoints: 10,
        reservedCredits,
        userId,
        templateSlug: "tiktok-profile",
        params: { username: "iammagdy" },
        steps: [
          {
            stepId: "step_profile",
            endpointId: "tikhub.tiktok.user.profile",
            params: { username: "iammagdy" },
            targetVolumeMax: 1,
            paginationStrategy: "none",
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(callCount).toBe(1);
      expect(result.deliveredUnits).toBe(1);
      expect(result.chargedCredits).toBe(10);
    });
  });

  describe("3. Spend Cap Protection", () => {
    it("stops execution cleanly before exceeding job held points and settles collected rows", async () => {
      const jobId = "job_hold_cap_test";
      // Reserved 12 points. Unit price 5 points.
      // Page 1 gives 2 rows (costs 10 points). Page 2 would cost another 10 points (total 20 > 12).
      const reservedCredits = 12;

      await reserveCredits(tables as any, userId, jobId, reservedCredits, "حجز رصيد محدود");
      await tables.createRow({
        databaseId: "digr",
        tableId: "jobs",
        rowId: jobId,
        data: {
          userId,
          templateSlug: "x-keyword-search",
          params: JSON.stringify({ query: "tech", limit: 2 }),
          status: "queued",
          estCredits: 10,
          reservedCredits,
        },
      });

      let pageCalls = 0;
      global.fetch = vi.fn().mockImplementation(async (url: any) => {
        // Schema lookup (catalog GET) is not a billed provider call and must not count as a page or attempt.
        if (String(url).includes("/catalog/endpoints/")) return new Response("{}", { status: 200 });
        pageCalls++;
        return new Response(
          JSON.stringify({
            data: [
              { id: `row_${pageCalls}_1`, text: "Post 1" },
              { id: `row_${pageCalls}_2`, text: "Post 2" },
            ],
            next_cursor: `next_${pageCalls}`,
          }),
          { status: 200, headers: { "x-treg-cost-micro": "2000" } }
        );
      });

      const result = await executeMultiStepJob(tables as any, storage as any, {
        jobId,
        targetVolumeMax: 10,
        unitPricePoints: 5,
        reservedCredits,
        userId,
        templateSlug: "x-keyword-search",
        params: { query: "tech", limit: 2 },
        steps: [
          {
            stepId: "step_capped",
            endpointId: "treg.twitter.tweets",
            params: { query: "tech", limit: 2 },
            targetVolumeMax: 10,
            paginationStrategy: "cursor",
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe("done");
      expect(result.deliveredUnits).toBe(2);
      expect(result.chargedCredits).toBe(10); // Charged 10 of 12
      expect(result.refundCredits).toBe(2);   // Refunded remainder 2
      expect(pageCalls).toBe(1); // Second page call was prevented by job hold cap
    });

    it("stops cleanly when daily provider spend cap ($0.80 USD) is reached and finalizes with points used", async () => {
      const jobId = "job_daily_cap_test";
      const reservedCredits = 20;

      await reserveCredits(tables as any, userId, jobId, reservedCredits, "حجز رصيد لاختبار السقف اليومي");
      await tables.createRow({
        databaseId: "digr",
        tableId: "jobs",
        rowId: jobId,
        data: {
          userId,
          templateSlug: "reddit-search",
          params: JSON.stringify({ query: "egypt" }),
          status: "queued",
          estCredits: 20,
          reservedCredits,
        },
      });

      // Set existing daily provider spend near the $0.80 cap so page 1 proceeds and page 2 is blocked
      setMemoryProviderDailySpendUsdForTesting(0.785);

      let pageCount = 0;
      global.fetch = vi.fn().mockImplementation(async (url: any) => {
        // Schema lookup (catalog GET) is not a billed provider call and must not count as a page or attempt.
        if (String(url).includes("/catalog/endpoints/")) return new Response("{}", { status: 200 });
        pageCount++;
        // Page 1 costs $0.01 (10,000 microUSD), pushing daily spend to $0.805
        return new Response(
          JSON.stringify({
            items: [{ id: "post_1", title: "Reddit post 1" }],
            next_cursor: "cur_2",
          }),
          { status: 200, headers: { "x-treg-cost-micro": "10000" } }
        );
      });

      const result = await executeMultiStepJob(tables as any, storage as any, {
        jobId,
        targetVolumeMax: 10,
        unitPricePoints: 2,
        reservedCredits,
        userId,
        templateSlug: "reddit-search",
        params: { query: "egypt" },
        steps: [
          {
            stepId: "step_reddit",
            endpointId: "treg.reddit.search",
            params: { query: "egypt" },
            targetVolumeMax: 10,
            paginationStrategy: "cursor",
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.deliveredUnits).toBe(1);
      expect(result.chargedCredits).toBe(2);
      expect(result.refundCredits).toBe(18);
      expect(pageCount).toBe(1); // Page 2 was stopped due to $0.80 provider cap
    });
  });

  describe("4. Retries on 429 & 5xx", () => {
    it("retries up to 3 times on 429 and succeeds on 3rd attempt without double charging", async () => {
      const jobId = "job_retry_429_test";
      const reservedCredits = 15;

      await reserveCredits(tables as any, userId, jobId, reservedCredits, "حجز رصيد لاختبار إعادة المحاولة");
      await tables.createRow({
        databaseId: "digr",
        tableId: "jobs",
        rowId: jobId,
        data: {
          userId,
          templateSlug: "x-keyword-search",
          params: JSON.stringify({ query: "retry" }),
          status: "queued",
          estCredits: 15,
          reservedCredits,
        },
      });

      let attempts = 0;
      global.fetch = vi.fn().mockImplementation(async (url: any) => {
        // Schema lookup (catalog GET) is not a billed provider call and must not count as a page or attempt.
        if (String(url).includes("/catalog/endpoints/")) return new Response("{}", { status: 200 });
        attempts++;
        if (attempts < 3) {
          return new Response(JSON.stringify({ error: "rate_limit", message: "Too Many Requests" }), {
            status: 429,
          });
        }
        return new Response(
          JSON.stringify({
            data: [{ id: "t_recovered", text: "Successfully recovered after 429" }],
          }),
          { status: 200, headers: { "x-treg-cost-micro": "2000" } }
        );
      });

      const result = await executeMultiStepJob(tables as any, storage as any, {
        jobId,
        targetVolumeMax: 1,
        unitPricePoints: 5,
        reservedCredits,
        userId,
        templateSlug: "x-keyword-search",
        params: { query: "retry" },
        steps: [
          {
            stepId: "step_retry",
            endpointId: "treg.twitter.tweets",
            params: { query: "retry" },
            targetVolumeMax: 1,
            paginationStrategy: "none",
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(attempts).toBe(3);
      expect(result.deliveredUnits).toBe(1);
      expect(result.chargedCredits).toBe(5);
    });

    it("stops gracefully when all retries fail on page 1 and releases 100% of reserved points with 0 charge", async () => {
      const jobId = "job_fail_retries_test";
      const reservedCredits = 20;

      await reserveCredits(tables as any, userId, jobId, reservedCredits, "حجز رصيد لاختبار فشل الإعادة");
      await tables.createRow({
        databaseId: "digr",
        tableId: "jobs",
        rowId: jobId,
        data: {
          userId,
          templateSlug: "x-keyword-search",
          params: JSON.stringify({ query: "broken" }),
          status: "queued",
          estCredits: 20,
          reservedCredits,
        },
      });

      let attempts = 0;
      global.fetch = vi.fn().mockImplementation(async (url: any) => {
        // Schema lookup (catalog GET) is not a billed provider call and must not count as a page or attempt.
        if (String(url).includes("/catalog/endpoints/")) return new Response("{}", { status: 200 });
        attempts++;
        return new Response(JSON.stringify({ error: "server_error" }), { status: 503 });
      });

      const result = await executeMultiStepJob(tables as any, storage as any, {
        jobId,
        targetVolumeMax: 5,
        unitPricePoints: 2,
        reservedCredits,
        userId,
        templateSlug: "x-keyword-search",
        params: { query: "broken" },
        steps: [
          {
            stepId: "step_fail",
            endpointId: "treg.twitter.tweets",
            params: { query: "broken" },
            targetVolumeMax: 5,
            paginationStrategy: "none",
          },
        ],
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe("failed");
      expect(result.deliveredUnits).toBe(0);
      expect(result.chargedCredits).toBe(0);
      expect(result.refundCredits).toBe(20);
      expect(attempts).toBe(4); // 1 initial + 3 retries = 4

      // Verify release row rel_ was created in credit ledger
      const relDoc = await tables.getRow({
        databaseId: "digr",
        tableId: "credit_ledger",
        rowId: `rel_${jobId}`,
      });
      expect(relDoc.delta).toBe(20);
    });
  });

  describe("5. TREG_LIVE Guard", () => {
    it("fails safely and releases reservation when TREG_LIVE is not 'true' without generating fake data", async () => {
      process.env.TREG_LIVE = "false";

      const jobId = "job_treg_live_disabled";
      const reservedCredits = 25;

      await reserveCredits(tables as any, userId, jobId, reservedCredits, "حجز رصيد لاختبار TREG_LIVE=false");
      await tables.createRow({
        databaseId: "digr",
        tableId: "jobs",
        rowId: jobId,
        data: {
          userId,
          templateSlug: "x-keyword-search",
          params: JSON.stringify({ query: "test" }),
          status: "queued",
          estCredits: 25,
          reservedCredits,
        },
      });

      const fetchSpy = vi.fn();
      global.fetch = fetchSpy;

      const result = await executeMultiStepJob(tables as any, storage as any, {
        jobId,
        targetVolumeMax: 10,
        unitPricePoints: 2,
        reservedCredits,
        userId,
        templateSlug: "x-keyword-search",
        params: { query: "test" },
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe("failed");
      expect(result.errorAr).toBe("الخدمة غير متاحة حالياً. تم إرجاع النقاط المحجوزة إلى رصيدك.");
      expect(result.errorAr).not.toMatch(/treg|token|مزود البيانات الحقيقي/i);
      expect(result.deliveredUnits).toBe(0);
      expect(result.chargedCredits).toBe(0);
      expect(result.refundCredits).toBe(25);
      expect(fetchSpy).not.toHaveBeenCalled();

      // Verify rel_ row created in credit ledger
      const relRow = await tables.getRow({
        databaseId: "digr",
        tableId: "credit_ledger",
        rowId: `rel_${jobId}`,
      });
      expect(relRow.delta).toBe(25);

      // Verify job document marked failed
      const jobRow = await tables.getRow({
        databaseId: "digr",
        tableId: "jobs",
        rowId: jobId,
      });
      expect(jobRow.status).toBe("failed");
      expect(jobRow.errorAr).toBe("الخدمة غير متاحة حالياً. تم إرجاع النقاط المحجوزة إلى رصيدك.");
      expect(jobRow.errorAr).not.toMatch(/treg|token|مزود البيانات الحقيقي/i);
    });
  });
});
