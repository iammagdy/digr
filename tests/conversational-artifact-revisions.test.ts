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
  it("answers an RTL formatting request plainly: not available now, no price, no revision card", async () => {
    const mockDb = createMockSupabase();
    const handler = new ChatHandler(mockDb);

    const response = await handler.handleUserMessage({
      userId: "usr_rev_1",
      conversationId: "conv_rev_1",
      message: "الشيت اللي طلع مش RTL، عدل التنسيق لو سمحت",
    });

    expect(response.outputType).toBe("answer_question");
    expect(response.revisionQuote).toBeUndefined();
    expect(response.contentAr).toContain("غير متاح الآن");
    expect(response.contentAr).not.toMatch(/نقاط|نقطة|10|١٠/);
  });

  it("answers a deduplication request plainly: not available now, no price, no revision card", async () => {
    const mockDb = createMockSupabase();
    const handler = new ChatHandler(mockDb);

    const response = await handler.handleUserMessage({
      userId: "usr_rev_1",
      conversationId: "conv_rev_1",
      message: "احذف التكرار من ملف النتيجة",
    });

    expect(response.outputType).toBe("answer_question");
    expect(response.revisionQuote).toBeUndefined();
    expect(response.contentAr).toContain("غير متاح الآن");
    expect(response.contentAr).not.toMatch(/نقاط|نقطة|10|١٠/);
  });

  it("answers a sort request as free file shaping: one question naming the real columns, no price, no revision card", async () => {
    const mockDb = createMockSupabase();
    const handler = new ChatHandler(mockDb);

    const response = await handler.handleUserMessage({
      userId: "usr_rev_1",
      conversationId: "conv_rev_1",
      message: "رتب النتائج حسب المتابعين تنازلياً",
    });

    expect(response.outputType).toBe("ask_clarification");
    expect(response.revisionQuote).toBeUndefined();
    expect(response.clarificationItems).toHaveLength(1);
    expect(response.clarificationItems[0].id).toBe("shape_sort_desc_required");
    expect(response.clarificationItems[0].options).toContain("عدد المتابعين");
    expect(response.contentAr).toContain("لن يُخصم أي رصيد");
    expect(response.contentAr).not.toMatch(/نقاط|نقطة|10|١٠/);
  });

  it("applies revision and regenerates a data-only Excel deliverable that is right-to-left on every sheet", async () => {
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
    // Owner decision D4: Excel carries data only (no dashboard, quality or codebook sheets).
    expect(workbook.worksheets.length).toBe(1);
    expect(workbook.worksheets[0].rowCount).toBe(3); // header + the 2 deduplicated rows
    for (const ws of workbook.worksheets) {
      expect(ws.views?.[0]?.rightToLeft).toBe(true);
    }
  });
});
