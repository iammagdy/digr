import { describe, expect, it } from "vitest";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { applyArtifactEdit } from "../src/functions/shared/artifactEditing";
import { generateExcelReport } from "../src/functions/shared/fileGenerators";
import ExcelJS from "exceljs";

function createMockSupabase(initialData?: any) {
  const store: Record<string, any[]> = {
    conversations: [
      { id: "conv_rev_1", user_id: "usr_rev_1", title: "محادثة استخراج", status: "active", updated_at: new Date().toISOString() },
    ],
    messages: [],
    jobs: [
      {
        id: "job_rev_123",
        conversation_id: "conv_rev_1",
        user_id: "usr_rev_1",
        status: "done",
        template_slug: "tiktok-profile",
        created_at: new Date(Date.now() - 3600000).toISOString(),
      },
    ],
    profiles: [{ id: "usr_rev_1", persona: "student" }],
    credit_ledger: [{ id: "c1", user_id: "usr_rev_1", delta: 100 }],
    ...(initialData || {}),
  };

  const chain = (table: string) => {
    let rows = [...(store[table] || [])];
    const builder: any = {
      select: () => builder,
      eq: (col: string, val: any) => {
        rows = rows.filter((r) => r[col] === val);
        return builder;
      },
      in: (col: string, vals: any[]) => {
        rows = rows.filter((r) => vals.includes(r[col]));
        return builder;
      },
      order: () => builder,
      limit: (n: number) => {
        rows = rows.slice(0, n);
        return builder;
      },
      maybeSingle: async () => ({ data: rows[0] || null, error: null }),
      single: async () => ({ data: rows[0] || null, error: rows[0] ? null : new Error("not found") }),
      insert: async (data: any) => {
        const item = Array.isArray(data) ? data : [data];
        store[table] = [...(store[table] || []), ...item];
        return { data: item, error: null };
      },
      update: (data: any) => {
        return builder;
      },
    };
    return builder;
  };

  return {
    from: (table: string) => chain(table),
    storage: {
      from: () => ({
        download: async () => ({
          data: new Blob([JSON.stringify({ rows: [{ id: "1", username: "@t1", followers: 500 }] })]),
          error: null,
        }),
        upload: async () => ({ error: null }),
      }),
    },
  };
}

describe("Conversational Artifact Revisions", () => {
  it("detects RTL formatting correction and returns a 10-point revision quote", async () => {
    const mockDb = createMockSupabase();
    const handler = new ChatHandler(mockDb);

    const response = await handler.handleUserMessage({
      userId: "usr_rev_1",
      conversationId: "conv_rev_1",
      message: "الشيت اللي طلع مش RTL، عدل التنسيق لو سمحت",
    });

    expect(response.outputType).toBe("edit_artifact");
    expect(response.revisionQuote).toBeDefined();
    expect(response.revisionQuote.jobId).toBe("job_rev_123");
    expect(response.revisionQuote.points).toBe(10);
    expect(response.revisionQuote.operation).toEqual({
      action: "convert_formats",
      formats: ["xlsx", "pdf", "csv"],
    });
    expect(response.contentAr).toContain("10 نقاط");
    expect(response.contentAr).toContain("بدون إعادة جمع البيانات");
  });

  it("detects deduplication request and bounds revision quote to completed job", async () => {
    const mockDb = createMockSupabase();
    const handler = new ChatHandler(mockDb);

    const response = await handler.handleUserMessage({
      userId: "usr_rev_1",
      conversationId: "conv_rev_1",
      message: "احذف التكرار من ملف النتيجة",
    });

    expect(response.outputType).toBe("edit_artifact");
    expect(response.revisionQuote).toBeDefined();
    expect(response.revisionQuote.jobId).toBe("job_rev_123");
    expect(response.revisionQuote.points).toBe(10);
    expect(response.revisionQuote.operation.action).toBe("dedupe");
  });

  it("detects sorting request and maps to sort operation", async () => {
    const mockDb = createMockSupabase();
    const handler = new ChatHandler(mockDb);

    const response = await handler.handleUserMessage({
      userId: "usr_rev_1",
      conversationId: "conv_rev_1",
      message: "رتب النتائج حسب المتابعين تنازلياً",
    });

    expect(response.outputType).toBe("edit_artifact");
    expect(response.revisionQuote).toBeDefined();
    expect(response.revisionQuote.operation.action).toBe("sort");
    expect(response.revisionQuote.operation.direction).toBe("desc");
  });

  it("applies revision and regenerates Excel deliverable with 100% Arabic RTL on all sheets", async () => {
    const initialPayload = {
      metadata: { title: "نتائج البحث" },
      rows: [
        { id: "1", username: "@corp_a", followers: 1200 },
        { id: "2", username: "@corp_b", followers: 4500 },
        { id: "1", username: "@corp_a", followers: 1200 },
      ],
    };

    // Apply deduplication revision
    const revisedPayload = applyArtifactEdit(initialPayload, {
      action: "dedupe",
      keys: ["id", "username"],
    });

    expect(revisedPayload.rows).toHaveLength(2);
    expect(initialPayload.rows).toHaveLength(3); // Original untouched

    // Generate Excel report from revised payload
    const buffer = await generateExcelReport(revisedPayload);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);

    // Verify all worksheets are strictly Arabic RTL
    expect(workbook.worksheets.length).toBeGreaterThanOrEqual(4);
    for (const ws of workbook.worksheets) {
      expect(ws.views?.[0]?.rightToLeft).toBe(true);
    }
  });
});
