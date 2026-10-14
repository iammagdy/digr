import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST as postChat } from "../src/app/api/chat/route";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { generateExcelReport, generateCsvReport, generatePdfReport } from "../src/functions/shared/fileGenerators";
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
            const brief = mockConversationBriefs.get(queryVal);
            return { data: brief ? { brief } : null, error: null };
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

    // Turn 2: User says "تمام جهز الخطة" without re-uploading file
    const req = new NextRequest("http://localhost:3000/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer valid_jwt_token",
      },
      body: JSON.stringify({
        conversationId: "conv_turn_2_test",
        message: "تمام جهز الخطة وابدأ التنفيذ مع استبعاد نفس الملف",
      }),
    });

    const res = await postChat(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    // Should NOT ask for the file again!
    expect(data.outputType).not.toBe("ask_clarification");
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

    // All 6 company worksheets must be present
    expect(wb.worksheets.length).toBe(6);
    const sheetNames = wb.worksheets.map((ws) => ws.name);
    expect(sheetNames).toContain("الملخص التنفيذي ومؤشرات السوق");
    expect(sheetNames).toContain("دليل الشركات المعتمد");
    expect(sheetNames).toContain("بيانات الشركات للتصفية");
    expect(sheetNames).toContain("سجل تدقيق الاستبعاد والمطابقة");
    expect(sheetNames).toContain("جودة البيانات ومحددات الحصر");
    expect(sheetNames).toContain("دليل الحقول");

    // CSV and PDF must also generate without throwing
    const csvBuf = generateCsvReport(payload);
    expect(csvBuf.toString("utf-8")).toContain("شركة النيل للمقاولات");

    const pdfBuf = await generatePdfReport(payload);
    expect(pdfBuf.length).toBeGreaterThan(1000);
  });
});
