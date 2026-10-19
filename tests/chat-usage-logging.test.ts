import { describe, it, expect, vi, afterEach } from "vitest";

// A delivered job whose columns cannot be read right now (the "shaping-blocked" reply is written by code, no model).
vi.mock("../src/lib/server/savedResultColumns", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, loadLatestResultColumns: vi.fn(async () => ({ jobId: "job_unreadable", columns: [] })) };
});

import { ChatHandler } from "../src/functions/shared/chatHandler";
import { createChatDb, runConversation } from "./helpers/chatSession";

/** A minimal Supabase-style client: profile and conversation rows exist, everything else is empty; inserts are recorded. */
function makeSupabaseStub(userId: string, conversationId: string) {
  const inserts: Array<{ table: string; row: any }> = [];
  const rowsFor = (table: string): any[] => {
    if (table === "profiles") return [{ id: userId, name: "سلمى" }];
    if (table === "conversations") return [{ id: conversationId, user_id: userId, status: "active", brief: null, title: "x" }];
    return [];
  };
  const from = (table: string) => {
    const chain: any = {};
    for (const method of ["select", "eq", "neq", "in", "gte", "lt", "order", "limit", "range", "not", "or", "is", "like", "ilike", "update", "upsert", "delete"]) chain[method] = () => chain;
    chain.maybeSingle = async () => ({ data: rowsFor(table)[0] ?? null, error: null });
    chain.single = async () => ({ data: rowsFor(table)[0] ?? null, error: null });
    chain.insert = async (row: any) => { inserts.push({ table, row }); return { data: null, error: null }; };
    chain.then = (resolve: any, reject: any) => Promise.resolve({ data: rowsFor(table), error: null }).then(resolve, reject);
    return chain;
  };
  return { from, rpc: async () => ({ data: null, error: null }), usage: () => inserts.filter((i) => i.table === "llm_usage").map((i) => i.row) };
}

/** Rows the handler wrote to llm_usage (Appwrite-style tables). */
const usageRows = (db: ReturnType<typeof createChatDb>) => (db.store.get("llm_usage") || []) as any[];

afterEach(() => vi.restoreAllMocks());

describe("every chat turn leaves exactly one llm_usage row", () => {
  const codeAnswered: Array<[string, string]> = [
    ["greeting", "مساء الخير"],
    ["identity question", "انت مين؟"],
    ["studies refusal", "اجمع ١٠ دراسات عن الطاقة الشمسية في ألمانيا"],
    ["deterministic code-built plan", "هات ١٠ تغريدات عن كرة السلة"],
    ["deterministic missing-input question", "عايز شركات كهرباء"],
  ];

  for (const [name, message] of codeAnswered) {
    it(`${name}: one row, zero tokens, model 'deterministic'`, async () => {
      const { db, responses } = await runConversation([message]);
      const rows = usageRows(db);
      expect(responses).toHaveLength(1);
      expect(rows).toHaveLength(1);
      expect(rows[0].inputTokens).toBe(0);
      expect(rows[0].outputTokens).toBe(0);
      expect(rows[0].costUsd).toBe(0);
      expect(rows[0].model).toBe("deterministic");
      expect(rows[0].userId).toBe("user_scope_test");
      expect(typeof rows[0].messageId).toBe("string");
      expect(rows[0].messageId.length).toBeGreaterThan(0);
    });
  }

  it("reconciliation: N user messages in one conversation give N usage rows", async () => {
    const messages = codeAnswered.map(([, message]) => message);
    const { db, responses } = await runConversation(messages);
    expect(responses).toHaveLength(messages.length);
    expect(usageRows(db)).toHaveLength(messages.length);
    const userMessages = ((db.store.get("messages") || []) as any[]).filter((row) => row.role === "user");
    expect(userMessages).toHaveLength(messages.length);
  });

  it("a turn that fails after model calls still records the tokens the model spent, once", async () => {
    const db = createChatDb();
    const handler = new ChatHandler(db as any);
    await db.createRow({ tableId: "conversations", rowId: "c_fail", data: { userId: "u_fail", title: "x", status: "active", totalTokens: 0 } });
    (handler as any).llm.executeTurn = async () => ({
      output: { type: "answer_question", answerAr: "تمام", intent: "chat" },
      inputTokens: 1200, outputTokens: 80, costUsd: 0.0012, model: "claude-haiku-5-5", promptVersion: "t",
    });
    // A failure after the model call: the message update that follows the reply throws.
    const originalUpdate = db.updateRow.getMockImplementation()!;
    db.updateRow.mockImplementation(async (arg: any) => {
      if (arg.tableId === "messages" && arg.data?.content) throw new Error("storage down");
      return originalUpdate(arg);
    });
    await expect(handler.handleUserMessage({ userId: "u_fail", conversationId: "c_fail", message: "ما أفضل طريقة لتنظيم بحث السوق؟", userBalance: 500 })).rejects.toThrow();
    const rows = usageRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].inputTokens).toBe(1200);
    expect(rows[0].outputTokens).toBe(80);
    expect(rows[0].costUsd).toBe(0.0012);
    expect(rows[0].model).toBe("claude-haiku-5-5");
  });

  it("a normal model turn is not logged twice", async () => {
    const db = createChatDb();
    const handler = new ChatHandler(db as any);
    await db.createRow({ tableId: "conversations", rowId: "c_once", data: { userId: "u_once", title: "x", status: "active", totalTokens: 0 } });
    (handler as any).llm.executeTurn = async () => ({
      output: { type: "answer_question", answerAr: "تمام", intent: "chat" },
      inputTokens: 900, outputTokens: 60, costUsd: 0.0009, model: "claude-haiku-5-5", promptVersion: "t",
    });
    await handler.handleUserMessage({ userId: "u_once", conversationId: "c_once", message: "ما أفضل طريقة لتنظيم بحث السوق؟", userBalance: 500 });
    const rows = usageRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].inputTokens).toBe(900);
    expect(rows[0].model).toBe("claude-haiku-5-5");
  });

  it("shaping-blocked (a delivered file whose columns cannot be read): code reply, one row, model 'deterministic'", async () => {
    const sb = makeSupabaseStub("u_blocked", "c_blocked");
    const response: any = await new ChatHandler(sb as any).handleUserMessage({ userId: "u_blocked", conversationId: "c_blocked", message: "قسّم الملف شيت لكل مدينة", userBalance: 100 });
    expect(response.contentAr).toContain("تعذّرت قراءة أعمدة ملفك الآن");
    const rows = sb.usage();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: "u_blocked", tokens_in: 0, tokens_out: 0, model: "deterministic", reason: "answer_question", cost_usd: 0 });
  });

  it("a provider-error refusal is logged once with its short code in the reason (never in the customer text)", async () => {
    const sb = makeSupabaseStub("u_err", "c_err");
    const handler = new ChatHandler(sb as any);
    (handler as any).llm.executeTurn = async () => ({
      output: { type: "refuse", reasonAr: "المساعد غير متاح الآن، حاول لاحقًا." },
      inputTokens: 0, outputTokens: 0, costUsd: 0, model: "claude-haiku-5-5", promptVersion: "t", fallbackCode: "timeout",
    });
    const response: any = await handler.handleUserMessage({ userId: "u_err", conversationId: "c_err", message: "ما أفضل طريقة لتنظيم بحث السوق؟", userBalance: 500 });
    expect(response.contentAr).not.toContain("timeout");
    const rows = sb.usage();
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("refuse:timeout");
    expect(rows[0].model).toBe("claude-haiku-5-5");
  });

  it("a reply that arrived and was billed but was unusable still carries its real tokens", async () => {
    const sb = makeSupabaseStub("u_bill", "c_bill");
    const handler = new ChatHandler(sb as any);
    (handler as any).llm.executeTurn = async () => ({
      output: { type: "refuse", reasonAr: "المساعد غير متاح الآن، حاول لاحقًا." },
      inputTokens: 15000, outputTokens: 300, costUsd: 0.0132, model: "claude-haiku-5-5", promptVersion: "t", fallbackCode: "schema_invalid",
    });
    await handler.handleUserMessage({ userId: "u_bill", conversationId: "c_bill", message: "ما أفضل طريقة لتنظيم بحث السوق؟", userBalance: 500 });
    const rows = sb.usage();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tokens_in: 15000, tokens_out: 300, cost_usd: 0.0132, reason: "refuse:schema_invalid" });
  });

  it("guests are not logged (their id is not a real user)", async () => {
    const db = createChatDb();
    const handler = new ChatHandler(db as any);
    await handler.handleUserMessage({ userId: "guest_1", message: "مساء الخير", userBalance: 0, isGuest: true } as any);
    expect(usageRows(db)).toHaveLength(0);
  });
});
