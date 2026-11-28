import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ChatHandler } from "@/functions/shared/chatHandler";
import { setChatModelForTesting, type ChatModelCall } from "@/lib/agentMission/chatModel";
import { AGENT_BUCKET, MISSION_TABLE } from "@/lib/agentMission/constants";
import { methodologyNoDataAr, methodologyUnavailableAr } from "@/lib/methodologyOffer";
import { createChatDb } from "./helpers/chatSession";
import { fakeSupabase } from "./helpers/fakeSupabase";

describe("shape-delivery-chat (P7 / T7)", () => {
  let workbookBytes: Buffer;
  let workbookSha256: string;

  beforeAll(async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Summary");
    const ws = wb.addWorksheet("Data");
    ws.addRow(["اسم الشركة", "المدينة", "مجال النشاط"]);
    ws.addRow(["شركة النيل للطاقة", "القاهرة", "كهرباء"]);
    ws.addRow(["دلتا باور", "الإسكندرية", "طاقة"]);
    workbookBytes = Buffer.from(await wb.xlsx.writeBuffer());
    workbookSha256 = createHash("sha256").update(workbookBytes).digest("hex");
  });

  const json = (obj: unknown, usage = { inputTokens: 420, outputTokens: 60 }) => ({
    ok: true as const,
    text: JSON.stringify(obj),
    usage,
  });

  afterEach(() => {
    setChatModelForTesting(null);
    delete process.env.AGENT_SERVES_CHAT;
  });

  function createTestDb(options: {
    conversationId: string;
    userId: string;
    messages?: any[];
    missions?: any[];
    jobs?: any[];
    storageFiles?: Record<string, Buffer>;
  }) {
    const { conversationId, userId } = options;
    const baseChatDb = createChatDb();

    const fakeTables: Record<string, any[]> = {
      conversations: [
        {
          id: conversationId,
          $id: conversationId,
          user_id: userId,
          userId,
          title: "محادثة اختبار",
          status: "active",
          totalTokens: 0,
        },
      ],
      messages: options.messages ? [...options.messages] : [],
      missions: options.missions ? [...options.missions] : [],
      jobs: options.jobs ? [...options.jobs] : [],
      llm_usage: [],
      notes: [],
    };

    const supabase = fakeSupabase({
      tables: fakeTables,
    });

    const storageFiles = options.storageFiles || {};

    const hybridDb = {
      ...baseChatDb,
      from: (table: string) => {
        const builder = supabase.from(table);
        const origUpdate = builder.update;
        builder.update = (row: any) => {
          const u: any = {
            eq: () => u,
            then: (resolve: any, reject: any) => Promise.resolve({ error: null }).then(resolve, reject),
          };
          return u;
        };
        return builder;
      },
      rpc: (fn: string, args: any) => supabase.rpc(fn, args),
      storage: {
        from: (bucket: string) => ({
          download: async (path: string) => {
            const key = `${bucket}/${path}`;
            const file = storageFiles[key];
            if (!file) return { data: null, error: { message: "not found", status: 404 } };
            return {
              data: {
                text: async () => file.toString("utf-8"),
                arrayBuffer: async () => file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
              },
              error: null,
            };
          },
        }),
      },
    };

    return hybridDb;
  }

  it("M1: «رتب الملف حسب اسم الشركة» with NO resultColumns shapes delivered agent file with 0 points", async () => {
    const conversationId = "conv_m1";
    const userId = "user_m1";
    const missionId = "msn_agent_m1_12345678";
    const jobId = "job_agent_m1_12345678";

    const db = createTestDb({
      conversationId,
      userId,
      messages: [
        {
          id: "msg_user_req",
          conversation_id: conversationId,
          user_id: userId,
          created_at: "2026-11-27T10:00:00Z",
          content: "عايز شركات كهرباء",
        },
        {
          id: "msg_card",
          conversation_id: conversationId,
          user_id: userId,
          created_at: "2026-11-27T10:05:00Z",
          content: "تم إنجاز المهمة",
          plan: { agentMissionId: missionId },
        },
      ],
      missions: [
        {
          id: missionId,
          user_id: userId,
          job_id: jobId,
          files: [{ name: "result.xlsx", path: "result/result.xlsx", kind: "xlsx" }],
          delivered_units: 2,
        },
      ],
      jobs: [
        {
          id: jobId,
          user_id: userId,
          conversation_id: conversationId,
          endpoint_id: "agent-mission",
          status: "completed",
          charged_credits: 10,
          delivered_units: 2,
          created_at: "2026-11-27T10:06:00Z",
        },
      ],
      storageFiles: {
        [`${AGENT_BUCKET}/${missionId}/result/result.xlsx`]: workbookBytes,
      },
    });

    const handler = new ChatHandler(db as any);
    const res = await handler.handleUserMessage({
      userId,
      conversationId,
      message: "رتب الملف حسب اسم الشركة",
      userBalance: 5000,
    });

    expect(res.outputType).toBe("answer_question");
    expect(res.fileShape).toBeDefined();
    expect(res.fileShape!.jobId).toBe(jobId);
    expect(res.fileShape!.spec).toMatchObject({
      sortBy: [{ column: "col_1", direction: "asc" }],
    });
    expect(res.contentAr).toContain("تحميل الملف المخصص");
    expect(res.contentAr).toContain("لا يُخصم أي رصيد");
    expect(res.planQuote).toBeUndefined();
    expect(res.revisionQuote).toBeUndefined();
    expect(res.agentMission).toBeUndefined();
  });

  it("M2: sealed hash mismatch gives blocked reply and 0 points", async () => {
    const conversationId = "conv_m2";
    const userId = "user_m2";
    const missionId = "msn_agent_m2_12345678";
    const jobId = "job_agent_m2_12345678";

    const db = createTestDb({
      conversationId,
      userId,
      messages: [
        {
          id: "msg_card_m2",
          conversation_id: conversationId,
          user_id: userId,
          created_at: "2026-11-27T10:05:00Z",
          plan: { agentMissionId: missionId },
        },
      ],
      missions: [
        {
          id: missionId,
          user_id: userId,
          job_id: jobId,
          files: [{ name: "result.xlsx", path: "result/result.xlsx", kind: "xlsx", sha256: "0".repeat(64) }],
          delivered_units: 2,
        },
      ],
      jobs: [
        {
          id: jobId,
          user_id: userId,
          conversation_id: conversationId,
          endpoint_id: "agent-mission",
          status: "completed",
          charged_credits: 10,
          delivered_units: 2,
          created_at: "2026-11-27T10:06:00Z",
        },
      ],
      storageFiles: {
        [`${AGENT_BUCKET}/${missionId}/result/result.xlsx`]: workbookBytes,
      },
    });

    const handler = new ChatHandler(db as any);
    const res = await handler.handleUserMessage({
      userId,
      conversationId,
      message: "رتب الملف حسب اسم الشركة",
      userBalance: 5000,
    });

    expect(res.contentAr).toContain("تعذّرت قراءة أعمدة ملفك");
    expect(res.fileShape).toBeUndefined();
    expect(res.planQuote).toBeUndefined();
    expect(res.agentMission).toBeUndefined();
  });

  it("M6: vague text with page columns triggers model-constrained shaping", async () => {
    const conversationId = "conv_m6";
    const userId = "user_m6";
    const missionId = "msn_agent_m6_12345678";
    const jobId = "job_agent_m6_12345678";

    const db = createTestDb({
      conversationId,
      userId,
      messages: [],
    });

    const shapeModel = vi.fn(async () =>
      json({
        kind: "shape",
        spec: { sortBy: [{ column: "اسم الشركة", direction: "asc" }] },
      })
    ) as unknown as ChatModelCall;
    setChatModelForTesting(shapeModel);

    const handler = new ChatHandler(db as any);
    const res = await handler.handleUserMessage({
      userId,
      conversationId,
      message: "قسّم الملف زي ما تحب",
      userBalance: 5000,
      resultColumns: [
        { key: "col_1", titleAr: "اسم الشركة" },
        { key: "col_2", titleAr: "المدينة" },
      ],
    });

    expect(shapeModel).toHaveBeenCalledTimes(1);
    expect(res.outputType).toBe("answer_question");
    expect(res.fileShape!.spec).toMatchObject({
      sortBy: [{ column: "col_1", direction: "asc" }],
    });
    expect(res.contentAr).toContain("تحميل الملف المخصص");
  });

  it("C1: conversation with NO delivered result never shapes and proposes plan as today", async () => {
    const conversationId = "conv_c1";
    const userId = "user_c1";

    const db = createTestDb({
      conversationId,
      userId,
      messages: [],
      missions: [],
      jobs: [],
    });

    const handler = new ChatHandler(db as any);
    const res = await handler.handleUserMessage({
      userId,
      conversationId,
      message: "رتب الملف حسب اسم الشركة",
      userBalance: 5000,
    });

    expect(res.fileShape).toBeUndefined();
    expect(res.outputType).not.toBe("answer_question");
  });

  it("C2: NEW data request with result open is routed to planning, not shaping", async () => {
    const conversationId = "conv_c2";
    const userId = "user_c2";
    const missionId = "msn_agent_c2_12345678";
    const jobId = "job_agent_c2_12345678";

    const db = createTestDb({
      conversationId,
      userId,
      messages: [
        {
          id: "msg_card_c2",
          conversation_id: conversationId,
          user_id: userId,
          created_at: "2026-11-27T10:05:00Z",
          plan: { agentMissionId: missionId },
        },
      ],
      missions: [
        {
          id: missionId,
          user_id: userId,
          job_id: jobId,
          files: [{ name: "result.xlsx", path: "result/result.xlsx", kind: "xlsx" }],
          delivered_units: 2,
        },
      ],
      jobs: [
        {
          id: jobId,
          user_id: userId,
          conversation_id: conversationId,
          endpoint_id: "agent-mission",
          status: "completed",
          charged_credits: 10,
          delivered_units: 2,
          created_at: "2026-11-27T10:06:00Z",
        },
      ],
      storageFiles: {
        [`${AGENT_BUCKET}/${missionId}/result/result.xlsx`]: workbookBytes,
      },
    });

    const handler = new ChatHandler(db as any);
    const res = await handler.handleUserMessage({
      userId,
      conversationId,
      message: "عايز ٥ شركات كهرباء في مصر",
      userBalance: 5000,
    });

    expect(res.fileShape).toBeUndefined();
    expect(res.outputType).toBe("propose_plan");
  });

  it("C4: methodology query returns methodologyNoDataAr for agent delivery without saved data.json", async () => {
    process.env.AGENT_SERVES_CHAT = "false";
    const conversationId = "conv_c4";
    const userId = "user_c4";
    const missionId = "msn_agent_c4_12345678";
    const jobId = "job_agent_c4_12345678";

    const db = createTestDb({
      conversationId,
      userId,
      messages: [
        {
          id: "msg_card_c4",
          conversation_id: conversationId,
          user_id: userId,
          created_at: "2026-11-27T10:05:00Z",
          plan: { agentMissionId: missionId },
        },
      ],
      missions: [
        {
          id: missionId,
          user_id: userId,
          job_id: jobId,
          files: [{ name: "result.xlsx", path: "result/result.xlsx", kind: "xlsx" }],
          delivered_units: 2,
        },
      ],
      jobs: [
        {
          id: jobId,
          user_id: userId,
          conversation_id: conversationId,
          endpoint_id: "agent-mission",
          status: "completed",
          charged_credits: 10,
          delivered_units: 2,
          created_at: "2026-11-27T10:06:00Z",
        },
      ],
    });

    const handler = new ChatHandler(db as any);
    const res = await handler.handleUserMessage({
      userId,
      conversationId,
      message: "عايز منهجية البحث",
      userBalance: 5000,
    });

    expect(res.outputType).toBe("answer_question");
    expect(res.contentAr).toBe(methodologyNoDataAr());

    // Without any delivered job, returns methodologyUnavailableAr
    const dbEmpty = createTestDb({ conversationId: "conv_c4_empty", userId });
    const handlerEmpty = new ChatHandler(dbEmpty as any);
    const resEmpty = await handlerEmpty.handleUserMessage({
      userId,
      conversationId: "conv_c4_empty",
      message: "عايز منهجية البحث",
      userBalance: 5000,
    });
    expect(resEmpty.contentAr).toBe(methodologyUnavailableAr());
  });

  it("C5: later undelivered/failed mission in same conversation is ignored; latest delivered job wins", async () => {
    const conversationId = "conv_c5";
    const userId = "user_c5";
    const deliveredMissionId = "msn_agent_c5_deliv";
    const deliveredJobId = "job_agent_c5_deliv";
    const failedMissionId = "msn_agent_c5_failed";
    const failedJobId = "job_agent_c5_failed";

    const db = createTestDb({
      conversationId,
      userId,
      messages: [
        {
          id: "msg_card_deliv",
          conversation_id: conversationId,
          user_id: userId,
          created_at: "2026-11-27T10:05:00Z",
          plan: { agentMissionId: deliveredMissionId },
        },
        {
          id: "msg_card_failed",
          conversation_id: conversationId,
          user_id: userId,
          created_at: "2026-11-27T10:15:00Z",
          plan: { agentMissionId: failedMissionId },
        },
      ],
      missions: [
        {
          id: deliveredMissionId,
          user_id: userId,
          job_id: deliveredJobId,
          files: [{ name: "result.xlsx", path: "result/result.xlsx", kind: "xlsx" }],
          delivered_units: 2,
        },
        {
          id: failedMissionId,
          user_id: userId,
          job_id: failedJobId,
          files: [],
          delivered_units: 0,
        },
      ],
      jobs: [
        {
          id: deliveredJobId,
          user_id: userId,
          conversation_id: conversationId,
          endpoint_id: "agent-mission",
          status: "completed",
          charged_credits: 10,
          delivered_units: 2,
          created_at: "2026-11-27T10:06:00Z",
        },
        {
          id: failedJobId,
          user_id: userId,
          conversation_id: conversationId,
          endpoint_id: "agent-mission",
          status: "failed",
          charged_credits: 0,
          delivered_units: 0,
          created_at: "2026-11-27T10:16:00Z",
        },
      ],
      storageFiles: {
        [`${AGENT_BUCKET}/${deliveredMissionId}/result/result.xlsx`]: workbookBytes,
      },
    });

    const handler = new ChatHandler(db as any);
    const res = await handler.handleUserMessage({
      userId,
      conversationId,
      message: "رتب الملف حسب اسم الشركة",
      userBalance: 5000,
    });

    expect(res.outputType).toBe("answer_question");
    expect(res.fileShape).toBeDefined();
    expect(res.fileShape!.jobId).toBe(deliveredJobId);
  });

  it("C7: conversation whose assistant card has no plan.agentMissionId behaves like C1", async () => {
    const conversationId = "conv_c7";
    const userId = "user_c7";

    const db = createTestDb({
      conversationId,
      userId,
      messages: [
        {
          id: "msg_card_c7",
          conversation_id: conversationId,
          user_id: userId,
          created_at: "2026-11-27T10:05:00Z",
          content: "بطاقة بدون معرف مهمة",
          plan: {},
        },
      ],
    });

    const handler = new ChatHandler(db as any);
    const res = await handler.handleUserMessage({
      userId,
      conversationId,
      message: "رتب الملف حسب اسم الشركة",
      userBalance: 5000,
    });

    expect(res.fileShape).toBeUndefined();
    expect(res.outputType).not.toBe("answer_question");
  });

  it.skip("M5: a named column the file lacks → the UL2a-2b-C5 card/«غير موجود» line on agent columns (activates when #721 (UL2a-2b-C5) merges — D-0260)", async () => {
    // Activates when #721 (UL2a-2b-C5) merges — D-0260
  });
});
