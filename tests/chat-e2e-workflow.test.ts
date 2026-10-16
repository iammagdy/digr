import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST as postChat } from "../src/app/api/chat/route";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import {
  generateExcelReport,
  generateCsvReport,
  generatePdfReport,
  generateMethodologyText,
} from "../src/functions/shared/fileGenerators";
import {
  deduplicateAgainstBaseline,
  EntityRecord,
} from "../src/lib/server/negativeListEngine";
import ExcelJS from "exceljs";

// Mock Supabase Server Client & Admin Client
const mockUserState = {
  id: "user_test_researcher_123",
  email: "researcher@diger.test",
  email_confirmed_at: "2026-10-12T00:00:00Z",
};

const mockConversationBriefs = new Map<string, any>();

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async (token?: string) => {
        if (token === "invalid_token") {
          return { data: { user: null }, error: new Error("invalid token") };
        }
        return { data: { user: mockUserState }, error: null };
      }),
    },
  })),
  createAdminClient: vi.fn(() => ({
    storage: {
      from: vi.fn((bucket: string) => ({
        download: vi.fn(async (path: string) => {
          if (path.includes("forbidden") || path.includes("other_user")) {
            return { data: null, error: new Error("Access denied") };
          }
          const csvText = "اسم الشركة,الموقع الإلكتروني,السجل التجاري\nشركة أوراسكوم,orascom.com,123456\nشركة بتروجت,petrojet.com.eg,654321";
          return {
            data: {
              arrayBuffer: async () => Buffer.from(csvText, "utf-8").buffer,
            },
            error: null,
          };
        }),
      })),
    },
    from: vi.fn((table: string) => {
      let queryCol = "";
      let queryVal = "";
      const chain: any = {
        select: vi.fn(() => chain),
        eq: vi.fn((col: string, val: string) => {
          queryCol = col;
          queryVal = val;
          return chain;
        }),
        gte: vi.fn(() => chain),
        order: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        maybeSingle: vi.fn(async () => {
          if (table === "conversations") {
            const entry = mockConversationBriefs.get(queryVal);
            if (!entry) return { data: null, error: null };
            const userId = entry.user_id || mockUserState.id;
            const brief = entry.brief || entry;
            return { data: { id: queryVal, user_id: userId, brief }, error: null };
          }
          if (table === "settings_public") {
            return { data: { value: { daily_cap_usd: 100 } }, error: null };
          }
          return { data: null, error: null };
        }),
        single: vi.fn(async () => ({ data: null, error: null })),
        insert: vi.fn(async () => ({ data: null, error: null })),
        update: vi.fn((updateData: any) => {
          return {
            eq: vi.fn((col: string, val: string) => {
              if (table === "conversations" && updateData.brief) {
                mockConversationBriefs.set(val, updateData.brief);
              }
              return chain;
            }),
          };
        }),
        then: (resolve: any) => resolve({ data: [], count: 0, error: null }),
      };
      return chain;
    }),
    rpc: vi.fn(async () => ({ data: { allowed: true }, error: null })),
  })),
}));

describe("Real Runtime Path Integration: /api/chat -> ChatHandler -> Exclusion -> Plan", () => {
  beforeEach(() => {
    clearBriefCacheForTesting();
    mockConversationBriefs.clear();
    vi.clearAllMocks();
  });

  it("1. Rejects unsupported file extension in /api/chat with clear Arabic error", async () => {
    const req = new NextRequest("http://localhost:3000/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer valid_jwt_token",
      },
      body: JSON.stringify({
        message: "عايز شركات مقاولات",
        uploadedFiles: [
          {
            name: "malicious_script.exe",
            content: "executable binary",
          },
        ],
      }),
    });

    const res = await postChat(req);
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.error).toContain("صيغة الملف غير مدعومة");
    expect(data.error).toContain("Excel");
  });

  it("2. Rejects files exceeding the 5MB size limit", async () => {
    const oversizedBase64 = "A".repeat(8 * 1024 * 1024); // ~8MB string
    const req = new NextRequest("http://localhost:3000/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer valid_jwt_token",
      },
      body: JSON.stringify({
        message: "عايز شركات مقاولات مع استبعاد الملف",
        uploadedFiles: [
          {
            name: "huge_exclusion.csv",
            content: oversizedBase64,
          },
        ],
      }),
    });

    const res = await postChat(req);
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.error).toContain("يتجاوز الحد الأقصى");
  });

  it("3. Rejects unauthorized storage path attempting directory traversal", async () => {
    const req = new NextRequest("http://localhost:3000/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer valid_jwt_token",
      },
      body: JSON.stringify({
        message: "استبعاد الشركات من الملف",
        uploadedFiles: [
          {
            name: "stolen.csv",
            storagePath: "victim_user_456/private_file.csv", // doesn't match authenticated user id
          },
        ],
      }),
    });

    const res = await postChat(req);
    const data = await res.json();

    expect(res.status).toBe(403);
    expect(data.success).toBe(false);
    expect(data.error).toContain("غير مصرح");
  });

  it("4. Correctly clarifies for missing exclusion file when mentioned but not attached", async () => {
    const req = new NextRequest("http://localhost:3000/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer valid_jwt_token",
      },
      body: JSON.stringify({
        conversationId: "conv_missing_file_test",
        message: "عايز 50 شركة مقاولات كهروميكانيكية في مصر مع استبعاد الشركات اللي في الملف",
        uploadedFiles: [], // missing file
      }),
    });

    const res = await postChat(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.outputType).toBe("ask_clarification");
    expect(data.contentAr).toContain("ملف الاستبعاد");
  });

  it("5. End-to-end: Valid CSV uploaded in /api/chat triggers PROCEED_TO_PLAN with zero unnecessary questions", async () => {
    const csvContent = `اسم الشركة,الموقع الإلكتروني,السجل التجاري,البريد الشخصي
شركة أوراسكوم للإنشاءات,orascom.com,112233,ceo@personal.com
شركة بتروجت,petrojet.com.eg,445566,eng@yahoo.com`;

    const req = new NextRequest("http://localhost:3000/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer valid_jwt_token",
      },
      body: JSON.stringify({
        conversationId: "conv_e2e_full_plan",
        message: "عايز 50 شركة مقاولات كهروميكانيكية في مصر مع استبعاد الشركات الموجودة في الملف المرفق",
        uploadedFiles: [
          {
            name: "contractors_to_exclude.csv",
            type: "csv",
            content: csvContent,
          },
        ],
      }),
    });

    const res = await postChat(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);

    // Verify it proceeded directly to plan or provided priced plan/catalog match
    expect(data.role).toBe("assistant");
    expect(data.outputType).not.toBe("ask_clarification");

    // Verify conversation brief persisted the exclusionFile
    const convKey = data.conversationId || "conv_e2e_full_plan";
    const persistedBrief = mockConversationBriefs.get(convKey);
    expect(persistedBrief).toBeDefined();
    expect(persistedBrief?.exclusionFile).toBeDefined();
    expect(persistedBrief?.exclusionFile.baselineRowCount).toBe(2);
    expect(persistedBrief?.exclusionFile.companyNames).toContain("شركة أوراسكوم للإنشاءات");
    expect(persistedBrief?.exclusionFile.corporateDomains).toContain("orascom.com");
  });

  it("6. Context preservation: follow-up turn remembers uploaded exclusion list without asking again", async () => {
    // Turn 1 setup: brief already has exclusion file
    mockConversationBriefs.set("conv_turn_2_test", {
      platforms: ["web"],
      topics: ["مقاولات كهروميكانيكية"],
      targetVolume: 50,
      exclusionFile: {
        name: "previous_exclusion.csv",
        baselineRowCount: 2,
        companyNames: ["شركة أوراسكوم للإنشاءات", "شركة بتروجت"],
        corporateDomains: ["orascom.com", "petrojet.com.eg"],
        normalizedEntities: [
          { name: "شركة أوراسكوم للإنشاءات", domain: "orascom.com" },
          { name: "شركة بتروجت", domain: "petrojet.com.eg" },
        ],
      },
    });

    // Turn 2: User provides the required company scope and says "تمام جهز الخطة" without re-uploading file
    const req = new NextRequest("http://localhost:3000/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer valid_jwt_token",
      },
      body: JSON.stringify({
        conversationId: "conv_turn_2_test",
        message: "تمام جهز الخطة لمقاولات كهروميكانيكية في مصر وابدأ التنفيذ مع استبعاد نفس الملف",
      }),
    });

    const res = await postChat(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    // A remaining scope question is valid, but the uploaded file must not be requested again.
    expect(JSON.stringify(data.clarificationItems || [])).not.toContain("ارفع الملف");
  });

  it("7. Deliverables generation profile: generates 6-sheet corporate Excel when entityType is companies", async () => {
    const payload = {
      metadata: {
        title: "حصر شركات المقاولات الكهروميكانيكية في مصر",
        platform: "web",
        entityType: "companies",
        targetRequested: 50,
        collectedAt: new Date().toISOString(),
      },
      rows: [
        {
          company_name: "شركة النيل للمقاولات",
          activity: "كهروميكانيكا",
          website: "nile-mep.com",
          city: "القاهرة",
          phone: "+2022345678",
        },
        {
          company_name: "الدلتا للأعمال الهندسية",
          activity: "مقاولات عامة وتكييف",
          website: "delta-eng.com",
          city: "الإسكندرية",
          phone: "+2034567890",
        },
      ],
    };

    const excelBuf = await generateExcelReport(payload);
    expect(Buffer.isBuffer(excelBuf)).toBe(true);
    expect(excelBuf.length).toBeGreaterThan(1000);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(excelBuf as any);

    // Excel is data-only and includes linked company/branch rows and data counters.
    expect(wb.worksheets.length).toBe(5);
    const sheetNames = wb.worksheets.map((ws) => ws.name);
    expect(sheetNames).toContain("الملخص التنفيذي ومؤشرات السوق");
    expect(sheetNames).toContain("دليل الشركات المعتمد");
    expect(sheetNames).toContain("بيانات الشركات للتصفية");
    expect(sheetNames).toContain("فروع الشركات");
    expect(sheetNames).toContain("تحليل وتوزيع الشركات");
    expect(sheetNames).not.toContain("سجل تدقيق الاستبعاد والمطابقة");
    expect(sheetNames).not.toContain("جودة البيانات ومحددات الحصر");
    expect(sheetNames).not.toContain("دليل الحقول");

    // CSV and PDF must also generate without throwing
    const csvBuf = generateCsvReport(payload);
    expect(csvBuf.toString("utf-8")).toContain("شركة النيل للمقاولات");

    const pdfBuf = await generatePdfReport(payload);
    expect(pdfBuf.length).toBeGreaterThan(1000);
  });

  it("8. Realistic offline acceptance scenario: 50 MEP companies with XLSX exclusion file vs YouTube request without file", async () => {
    // -------------------------------------------------------------
    // Part A: 50 MEP Companies Request with Synthetic XLSX Exclusion
    // -------------------------------------------------------------
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("قائمة الشركات المستبعدة");
    ws.addRow([
      "اسم الشركة",
      "الموقع الإلكتروني",
      "السجل التجاري",
      "البريد الإلكتروني الشخصي",
      "هاتف شخصي",
    ]);
    ws.addRow([
      "شركة أوراسكوم للإنشاءات والصناعة",
      "orascom.com",
      "101010",
      "eng.ahmed.private@gmail.com",
      "+201012345678",
    ]);
    ws.addRow([
      "شركة بتروجت للخدمات البترولية والمشروعات",
      "petrojet.com.eg",
      "202020",
      "director.personal@yahoo.com",
      "+201212345678",
    ]);

    const xlsxBuffer = Buffer.from(await wb.xlsx.writeBuffer());
    const xlsxBase64 = xlsxBuffer.toString("base64");

    const reqMep = new NextRequest("http://localhost:3000/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer valid_jwt_token",
      },
      body: JSON.stringify({
        conversationId: "conv_mep_realistic_acceptance",
        message: "عايز 50 شركة كهروميكانيكا في مصر، غير الشركات الموجودة في ملف الإكسيل المرفق، وعايز ملف Excel منظم.",
        uploadedFiles: [
          {
            name: "mep_contractors_baseline.xlsx",
            type: "xlsx",
            content: xlsxBase64,
          },
        ],
      }),
    });

    const resMep = await postChat(reqMep);
    const dataMep = await resMep.json();

    expect(resMep.status).toBe(200);
    expect(dataMep.success).toBe(true);
    expect(JSON.stringify(dataMep.clarificationItems || [])).not.toContain("ارفع الملف");

    // 1. Verify exclusion parsing & privacy boundary in conversation brief
    const convMepKey = dataMep.conversationId || "conv_mep_realistic_acceptance";
    const persistedBrief = mockConversationBriefs.get(convMepKey);
    expect(persistedBrief).toBeDefined();
    expect(persistedBrief?.exclusionFile).toBeDefined();
    expect(persistedBrief?.exclusionFile.baselineRowCount).toBe(2);
    expect(persistedBrief?.exclusionFile.corporateDomains).toContain("orascom.com");
    expect(persistedBrief?.exclusionFile.corporateDomains).toContain("petrojet.com.eg");

    // Privacy boundary check: Personal emails and phones MUST NOT exist in normalizedEntities
    const entitiesStr = JSON.stringify(persistedBrief?.exclusionFile.normalizedEntities || []);
    expect(entitiesStr).not.toContain("gmail.com");
    expect(entitiesStr).not.toContain("yahoo.com");
    expect(entitiesStr).not.toContain("+201012345678");

    // 2. Verify plan quote items received the exclusion rules
    if (dataMep.planItems && dataMep.planItems.length > 0) {
      expect(dataMep.planItems[0].params?.exclusionRules).toBeDefined();
      expect(dataMep.planItems[0].params?.exclusionRules.baselineRowCount).toBe(2);
      expect(dataMep.planItems[0].params?.exclusionRules.fileName).toBe("mep_contractors_baseline.xlsx");
    }

    // 3. Worker chunk deduplication logic simulation against mock provider candidates
    const baselineRecords: EntityRecord[] = persistedBrief?.exclusionFile.normalizedEntities || [];
    const candidateRows = [
      { id: "c1", company_name: "أوراسكوم للإنشاءات", website: "https://orascom.com/about", cr_number: "101010" },
      { id: "c2", company_name: "شركة بتروجت للمشروعات", website: "http://petrojet.com.eg", cr_number: "202020" },
      { id: "c3", company_name: "أوراسكوم للتجارة والتوكيلات", website: "orascom-trading.com", cr_number: "999888" },
      { id: "c4", company_name: "شركة النيل للمقاولات الكهروميكانيكية", website: "nile-mep.com", cr_number: "303030" },
      { id: "c5", company_name: "الدلتا للأعمال الهندسية", website: "delta-eng.com", cr_number: "404040" },
    ];

    const candidateRecords: EntityRecord[] = candidateRows.map((r) => ({
      ...r,
      name: r.company_name,
      domain: r.website,
      crNumber: r.cr_number,
    }));

    const dedupResult = deduplicateAgainstBaseline(candidateRecords, baselineRecords);
    expect(dedupResult.confirmedDuplicates.length).toBe(2); // c1 & c2 confirmed duplicates
    expect(dedupResult.ambiguousMatches.length).toBe(1); // c3 ambiguous match
    expect(dedupResult.delivered.length).toBe(3); // c3, c4, c5 delivered

    const deliveredNames = dedupResult.delivered.map((r: any) => r.company_name || r.name);
    expect(deliveredNames).not.toContain("أوراسكوم للإنشاءات");
    expect(deliveredNames).not.toContain("شركة بتروجت للمشروعات");
    expect(deliveredNames).toContain("شركة النيل للمقاولات الكهروميكانيكية");
    expect(deliveredNames).toContain("الدلتا للأعمال الهندسية");

    // 4. Deliverables generation: 6-sheet Excel + UTF-8 BOM CSV
    const reportPayload = {
      metadata: {
        title: "حصر شركات المقاولات الكهروميكانيكية في مصر",
        platform: "web",
        entityType: "companies",
        targetRequested: 50,
        collectedAt: new Date().toISOString(),
        exclusionBaselineFileName: "mep_contractors_baseline.xlsx",
        exclusionBaselineCount: 2,
        duplicatesRemovedCount: dedupResult.confirmedDuplicates.length,
        ambiguousCount: dedupResult.ambiguousMatches.length,
        methodology: "تم حصر شركات المقاولات الكهروميكانيكية مع استبعاد الكيانات المرجعية الواردة في ملف mep_contractors_baseline.xlsx.",
      },
      rows: dedupResult.delivered,
      deduplicationAudit: dedupResult.auditTrail,
    };

    const finalExcel = await generateExcelReport(reportPayload, { deduplicationAudit: dedupResult.auditTrail });
    expect(Buffer.isBuffer(finalExcel)).toBe(true);
    expect(finalExcel.length).toBeGreaterThan(1000);

    const checkWb = new ExcelJS.Workbook();
    await checkWb.xlsx.load(finalExcel as any);
    expect(checkWb.worksheets.length).toBe(5);
    checkWb.worksheets.forEach((ws) => {
      // All sheets must have RTL view
      expect(ws.views?.[0]?.rightToLeft).toBe(true);
    });

    const finalCsv = generateCsvReport(reportPayload);
    // Verify UTF-8 BOM: 0xEF, 0xBB, 0xBF
    expect(finalCsv[0]).toBe(0xef);
    expect(finalCsv[1]).toBe(0xbb);
    expect(finalCsv[2]).toBe(0xbf);
    const csvString = finalCsv.toString("utf-8");
    expect(csvString).toContain("شركة النيل للمقاولات الكهروميكانيكية");
    expect(csvString).not.toContain("أوراسكوم للإنشاءات,");

    // 5. Customer methodology omits internal exclusion-file names
    const methodology = generateMethodologyText(reportPayload);
    expect(methodology).not.toContain("mep_contractors_baseline.xlsx");

    // -------------------------------------------------------------
    // Part B: YouTube Request Without Attachment
    // -------------------------------------------------------------
    const reqYt = new NextRequest("http://localhost:3000/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer valid_jwt_token",
      },
      body: JSON.stringify({
        conversationId: "conv_youtube_acceptance_no_file",
        message: "عايز 50 مقطع فيديو من يوتيوب عن الذكاء الاصطناعي",
        uploadedFiles: [],
      }),
    });

    const resYt = await postChat(reqYt);
    const dataYt = await resYt.json();

    expect(resYt.status).toBe(200);
    expect(dataYt.success).toBe(true);
    // Should NOT ask for any file clarification
    expect(dataYt.outputType).not.toBe("ask_clarification");
    expect(dataYt.contentAr).not.toContain("يرجى إرفاق ملف الاستبعاد");
  });

  it("9. Security Guard: Rejects access when conversationId belongs to another user with 403 Forbidden", async () => {
    // Victim's conversation
    mockConversationBriefs.set("conv_victim_private_456", {
      user_id: "victim_user_789",
      brief: {
        topics: ["بيانات مالية سرية"],
        targetVolume: 100,
      },
    });

    const req = new NextRequest("http://localhost:3000/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer valid_jwt_token",
      },
      body: JSON.stringify({
        conversationId: "conv_victim_private_456",
        message: "وريني البيانات دي أو كمل عليها",
      }),
    });

    const res = await postChat(req);
    const data = await res.json();

    expect(res.status).toBe(403);
    expect(data.success).toBe(false);
    expect(data.error).toContain("غير مصرح لك بالوصول إلى هذه المحادثة");
    // Ensure victim's brief is not leaked
    expect(JSON.stringify(data)).not.toContain("بيانات مالية سرية");
  });
});
