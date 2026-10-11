import { describe, it, expect, beforeEach } from "vitest";
import {
  computePlanHash,
  createAndSaveManagedQuote,
  parseStoredPlan,
  PlanState,
} from "../src/functions/shared/planManager";
import { acceptQuote } from "../src/functions/shared/quoteAccept";
import { applyTopup, calculateBalance } from "../src/functions/shared/ledger";
import { Capability } from "../src/functions/shared/capabilityRegistry";

interface StoredRow {
  $id: string;
  data: Record<string, any>;
  permissions: any[];
}

/**
 * Deterministic Mock TablesDB for quote acceptance tests.
 */
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

    let limitVal: number | null = null;
    let offsetVal: number = 0;

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
          } else if (method === "lessThan") {
            items = items.filter((it) => it[attr] < vals[0]);
          } else if (method === "limit") {
            limitVal = vals[0];
          } else if (method === "offset") {
            offsetVal = vals[0];
          }
        } catch {
          // ignore custom mock parse
        }
      }
    }

    if (offsetVal > 0) {
      items = items.slice(offsetVal);
    }
    if (limitVal !== null) {
      items = items.slice(0, limitVal);
    }

    return { total: items.length, rows: items };
  }

  async getRow({ databaseId, tableId, rowId }: { databaseId: string; tableId: string; rowId: string }) {
    const key = `${tableId}:${rowId}`;
    const found = this.rows.get(key);
    if (!found) {
      const err: any = new Error(`Row ${rowId} not found in ${tableId}`);
      err.code = 404;
      err.status = 404;
      throw err;
    }
    return found.data;
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
    const found = this.rows.get(key);
    if (!found) {
      const err: any = new Error(`Row ${rowId} not found for update`);
      err.code = 404;
      err.status = 404;
      throw err;
    }
    found.data = { ...found.data, ...data };
    this.rows.set(key, found);
    return found.data;
  }
}

describe("Quote Hash Binding & Format Preservation Test Suite", () => {
  let tables: MockTablesDB;
  const userId = "usr_quote_test";

  const tiktokCapability: Capability = {
    slug: "tiktok-profile",
    category: "tiktok",
    nameAr: "استخراج ملف تيك توك الشخصي",
    nameEn: "TikTok User Profile",
    descriptionAr: "استخراج الإحصائيات الشاملة لحساب تيك توك",
    paramsSchema: JSON.stringify({
      type: "object",
      properties: { username: { type: "string" } },
      required: ["username"],
    }),
    tregEndpointId: "secret.endpoint.tiktok",
    tregMethod: "GET",
    pricingUnit: "call",
    unitCostUsd: 0.0012,
    maxRows: 1000,
    paginationType: "none",
    enabled: true,
  };

  beforeEach(async () => {
    tables = new MockTablesDB();
    // Fund user with 100 points
    await applyTopup(tables as any, userId, "top_quote_init", 100, "شحن رصيد أولي للاختبار");
  });

  // ================= (a) Quote with CSV+XLSX -> Accept succeeds, reserves points once =================
  it("Scenario (a): Quote with csv+xlsx succeeds on accept and reserves expected points once", async () => {
    const plan: PlanState = {
      summaryAr: "استخراج ملف تيك توك الشخصي (@iammagdy)",
      items: [
        {
          capabilitySlug: "tiktok-profile",
          params: { username: "iammagdy" },
          targetVolumeMin: 1,
          targetVolumeMax: 1,
        },
      ],
      outputFormats: ["csv", "xlsx"],
    };

    // 1. Create managed quote
    const quote = await createAndSaveManagedQuote(tables as any, {
      conversationId: "conv_tiktok_custom_formats",
      userId,
      plan,
      userBalance: 100,
      capabilities: [tiktokCapability],
    });

    expect(quote.quoteId).toBeDefined();
    expect(quote.outputFormats).toEqual(["csv", "xlsx"]);
    expect(quote.planHash).toBe(computePlanHash(plan.items, ["csv", "xlsx"]));

    // Verify stored itemsJson contains serialized envelope with outputFormats
    const quoteDoc = await tables.getRow({
      databaseId: "digr",
      tableId: "plans_quotes",
      rowId: quote.quoteId,
    });
    const parsedStored = parseStoredPlan(quoteDoc.itemsJson);
    expect(parsedStored.legacy).toBe(false);
    expect(parsedStored.outputFormats).toEqual(["csv", "xlsx"]);

    // 2. Accept quote with matching expectedPlanHash
    const acceptRes = await acceptQuote(tables as any, {
      userId,
      quoteId: quote.quoteId,
      expectedPlanHash: quote.planHash,
    });

    expect(acceptRes.success).toBe(true);
    expect(acceptRes.jobId).toBeDefined();
    expect(acceptRes.reservedCredits).toBe(quote.quotedPoints);

    // 3. Verify exactly one reservation in credit_ledger
    const ledgerRows = await tables.listRows({
      databaseId: "digr",
      tableId: "credit_ledger",
    });
    const reserves = ledgerRows.rows.filter((r) => r.type === "reserve");
    expect(reserves.length).toBe(1);
    expect(reserves[0].delta).toBe(-quote.quotedPoints);
    expect(reserves[0].jobId).toBe(acceptRes.jobId);

    // Balance reflects the reservation
    const balance = await calculateBalance(tables as any, userId);
    expect(balance).toBe(100 - quote.quotedPoints);

    // Quote document is marked accepted
    const updatedQuote = await tables.getRow({
      databaseId: "digr",
      tableId: "plans_quotes",
      rowId: quote.quoteId,
    });
    expect(updatedQuote.status).toBe("accepted");
    expect(updatedQuote.jobId).toBe(acceptRes.jobId);
  });

  // ================= (b) Quote with all 3 formats -> Accept succeeds =================
  it("Scenario (b): Quote with all 3 formats (xlsx, pdf, csv) succeeds on accept", async () => {
    const plan: PlanState = {
      summaryAr: "استخراج ملف تيك توك الشخصي بجميع الصيغ",
      items: [
        {
          capabilitySlug: "tiktok-profile",
          params: { username: "iammagdy" },
          targetVolumeMin: 1,
          targetVolumeMax: 1,
        },
      ],
      outputFormats: ["xlsx", "pdf", "csv"],
    };

    const quote = await createAndSaveManagedQuote(tables as any, {
      conversationId: "conv_tiktok_all_formats",
      userId,
      plan,
      userBalance: 100,
      capabilities: [tiktokCapability],
    });

    const acceptRes = await acceptQuote(tables as any, {
      userId,
      quoteId: quote.quoteId,
      expectedPlanHash: quote.planHash,
    });

    expect(acceptRes.success).toBe(true);
    expect(acceptRes.jobId).toBeDefined();
    expect(acceptRes.reservedCredits).toBe(quote.quotedPoints);

    const balance = await calculateBalance(tables as any, userId);
    expect(balance).toBe(100 - quote.quotedPoints);
  });

  // ================= (c) Quote with tampered plan -> Rejected =================
  it("Scenario (c): Tampered plan is strictly rejected with Arabic error and zero points reserved", async () => {
    const plan: PlanState = {
      summaryAr: "استخراج ملف تيك توك الشخصي",
      items: [
        {
          capabilitySlug: "tiktok-profile",
          params: { username: "iammagdy" },
          targetVolumeMin: 1,
          targetVolumeMax: 1,
        },
      ],
      outputFormats: ["csv", "xlsx"],
    };

    const quote = await createAndSaveManagedQuote(tables as any, {
      conversationId: "conv_tiktok_tamper",
      userId,
      plan,
      userBalance: 100,
      capabilities: [tiktokCapability],
    });

    // Case 1: Attacker sends forged expectedPlanHash
    const forgedHash = computePlanHash([
      {
        capabilitySlug: "tiktok-profile",
        params: { username: "other_victim" },
        targetVolumeMin: 1,
        targetVolumeMax: 1,
      },
    ], ["csv", "xlsx"]);

    const forgedRes = await acceptQuote(tables as any, {
      userId,
      quoteId: quote.quoteId,
      expectedPlanHash: forgedHash,
    });

    expect(forgedRes.success).toBe(false);
    expect(forgedRes.statusCode).toBe(400);
    expect(forgedRes.errorAr).toBe("تعذر بدء الاستخراج: تغيرت تفاصيل الخطة بعد إصدار العرض. يرجى إعادة طلب عرض سعر."
      .replace("تعذر بدء الاستخراج: ", "") || "تغيرت تفاصيل الخطة بعد إصدار العرض. يرجى إعادة طلب عرض سعر.");
    expect(forgedRes.errorAr).toContain("تغيرت تفاصيل الخطة");

    // Case 2: DB itemsJson tampered after quoting (target volume changed)
    await tables.updateRow({
      databaseId: "digr",
      tableId: "plans_quotes",
      rowId: quote.quoteId,
      data: {
        itemsJson: JSON.stringify({
          version: 1,
          summaryAr: plan.summaryAr,
          items: [
            {
              capabilitySlug: "tiktok-profile",
              params: { username: "iammagdy" },
              targetVolumeMin: 1,
              targetVolumeMax: 100, // Tampered limit
            },
          ],
          outputFormats: ["csv", "xlsx"],
        }),
      },
    });

    const tamperRes = await acceptQuote(tables as any, {
      userId,
      quoteId: quote.quoteId,
      expectedPlanHash: quote.planHash,
    });

    expect(tamperRes.success).toBe(false);
    expect(tamperRes.statusCode).toBe(400);
    expect(tamperRes.errorAr).toBe("تغيرت تفاصيل الخطة بعد إصدار العرض. يرجى إعادة طلب عرض سعر.");

    // Zero points reserved; balance remains untouched at 100
    const balance = await calculateBalance(tables as any, userId);
    expect(balance).toBe(100);

    const ledgerRows = await tables.listRows({
      databaseId: "digr",
      tableId: "credit_ledger",
    });
    const reserves = ledgerRows.rows.filter((r) => r.type === "reserve");
    expect(reserves.length).toBe(0);
  });

  // ================= (d) Old stored quote without formats -> Handled safely =================
  it("Scenario (d): Old legacy quote without formats handles safely without crashing or leaking points", async () => {
    const legacyItems = [
      {
        capabilitySlug: "tiktok-profile",
        params: { username: "iammagdy" },
        targetVolumeMin: 1,
        targetVolumeMax: 1,
      },
    ];

    // Case d1: Old quote stored as raw array without envelope, hash computed with default formats
    const legacyHash = computePlanHash(legacyItems); // defaults to ["xlsx", "pdf", "csv"]

    await tables.createRow({
      databaseId: "digr",
      tableId: "plans_quotes",
      rowId: "quote_legacy_raw_array",
      data: {
        userId,
        status: "proposed",
        itemsJson: JSON.stringify(legacyItems), // raw array
        targetVolumeMax: 1,
        quotedPoints: 10,
        summaryAr: "عرض قديم بدون مصفوفة صيغ",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      },
    });

    const acceptLegacy = await acceptQuote(tables as any, {
      userId,
      quoteId: "quote_legacy_raw_array",
      expectedPlanHash: legacyHash,
    });

    expect(acceptLegacy.success).toBe(true);
    expect(acceptLegacy.jobId).toBeDefined();

    // Case d2: Old quote with corrupted or malformed itemsJson string
    await tables.createRow({
      databaseId: "digr",
      tableId: "plans_quotes",
      rowId: "quote_corrupt_json",
      data: {
        userId,
        status: "proposed",
        itemsJson: "{ invalid json string",
        targetVolumeMax: 1,
        quotedPoints: 10,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      },
    });

    const acceptCorrupt = await acceptQuote(tables as any, {
      userId,
      quoteId: "quote_corrupt_json",
      expectedPlanHash: legacyHash,
    });

    expect(acceptCorrupt.success).toBe(false);
    expect(acceptCorrupt.statusCode).toBe(400);
    expect(acceptCorrupt.errorAr).toContain("تغيرت تفاصيل الخطة");
  });

  // ================= (e) Accept twice -> 409 conflict, no double reserve =================
  it("Scenario (e): Accepting quote twice returns 409 conflict and prevents duplicate credit reservation", async () => {
    const plan: PlanState = {
      summaryAr: "استخراج ملف تيك توك الشخصي",
      items: [
        {
          capabilitySlug: "tiktok-profile",
          params: { username: "iammagdy" },
          targetVolumeMin: 1,
          targetVolumeMax: 1,
        },
      ],
      outputFormats: ["csv", "xlsx"],
    };

    const quote = await createAndSaveManagedQuote(tables as any, {
      conversationId: "conv_tiktok_double_accept",
      userId,
      plan,
      userBalance: 100,
      capabilities: [tiktokCapability],
    });

    // First acceptance succeeds
    const firstAccept = await acceptQuote(tables as any, {
      userId,
      quoteId: quote.quoteId,
      expectedPlanHash: quote.planHash,
    });

    expect(firstAccept.success).toBe(true);
    const balanceAfterFirst = await calculateBalance(tables as any, userId);
    expect(balanceAfterFirst).toBe(100 - quote.quotedPoints);

    // Second acceptance on the same quote fails with 409
    const secondAccept = await acceptQuote(tables as any, {
      userId,
      quoteId: quote.quoteId,
      expectedPlanHash: quote.planHash,
    });

    expect(secondAccept.success).toBe(false);
    expect(secondAccept.statusCode).toBe(409);
    expect(secondAccept.errorAr).toBe("تم بدء تنفيذ هذا العرض مسبقاً ولا يمكن تكراره.");

    // Balance remains unchanged (no double deduction)
    const balanceAfterSecond = await calculateBalance(tables as any, userId);
    expect(balanceAfterSecond).toBe(balanceAfterFirst);

    // Only one reserve ledger entry exists for this quote/job
    const ledgerRows = await tables.listRows({
      databaseId: "digr",
      tableId: "credit_ledger",
    });
    const reserves = ledgerRows.rows.filter((r) => r.type === "reserve");
    expect(reserves.length).toBe(1);
  });
});
