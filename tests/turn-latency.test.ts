import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { formatStructuredClarificationAnswers } from "../src/functions/shared/clarification";
import { WAIT_SLOW_AR, WAIT_STILL_AR, waitProgressText } from "../src/lib/waitProgress";

/**
 * A turn's database work used to run one wave after another (about ten sequential round trips for a plan request; each
 * costs 100 to 150 ms in production). The independent reads and writes now share waves. The Supabase-style fake below keeps real
 * rows (messages, conversations) so the production path (not the Appwrite-style fallback) is exercised end to end, and can
 * add a fixed latency per call so the number of sequential waves is measured, not guessed.
 */
function memorySupabase(userId: string, conversationId: string, latencyMs = 0) {
  const tables: Record<string, any[]> = {
    messages: [],
    conversations: [{ id: conversationId, user_id: userId, status: "active", brief: null, title: "محادثة جديدة" }],
    profiles: [{ id: userId, name: "سلمى" }],
    capability_registry: [],
    llm_usage: [],
  };
  let seq = 0;
  const log: Array<{ table: string; op: string; id?: string; payload?: any; at: number }> = [];
  const wait = <T,>(value: T) => (latencyMs > 0 ? new Promise<T>((resolve) => setTimeout(() => resolve(value), latencyMs)) : Promise.resolve(value));
  const from = (table: string) => {
    const state: { op: string; payload?: any; filters: Array<[string, any]>; desc: boolean; limit: number } = { op: "select", filters: [], desc: false, limit: 1000 };
    const rows = () => (tables[table] = tables[table] || []);
    const run = () => {
      log.push({ table, op: state.op, id: state.filters.find(([c]) => c === "id")?.[1], payload: state.payload, at: Date.now() });
      let matched = rows().filter((r) => state.filters.every(([c, v]) => r[c] === v));
      if (state.op === "insert") { rows().push({ ...state.payload, _seq: ++seq }); return { data: null, error: null }; }
      if (state.op === "update") { matched.forEach((r) => Object.assign(r, state.payload)); return { data: null, error: null }; }
      if (state.desc) matched = [...matched].sort((a, b) => (b._seq ?? 0) - (a._seq ?? 0));
      return { data: matched.slice(0, state.limit).map((r) => ({ ...r })), error: null };
    };
    const chain: any = {};
    for (const method of ["neq", "in", "gte", "lt", "range", "not", "or", "is", "like", "ilike", "upsert", "delete"]) chain[method] = () => chain;
    chain.select = () => chain;
    chain.eq = (column: string, value: any) => { state.filters.push([column, value]); return chain; };
    chain.order = (_column: string, options: any) => { state.desc = options?.ascending === false; return chain; };
    chain.limit = (n: number) => { state.limit = n; return chain; };
    chain.update = (payload: any) => { state.op = "update"; state.payload = payload; return chain; };
    chain.insert = (payload: any) => { state.op = "insert"; state.payload = payload; return chain; };
    chain.maybeSingle = () => wait({ data: run().data?.[0] ?? null, error: null });
    chain.single = chain.maybeSingle;
    chain.then = (resolve: any, reject: any) => wait(run()).then(resolve, reject);
    return chain;
  };
  return { from, rpc: () => wait({ data: null, error: null }), tables, log };
}

const handlerFor = (db: any) => {
  const handler = new ChatHandler(db as any);
  (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be called"); });
  return handler;
};

async function measureWaves(message: string) {
  vi.useFakeTimers();
  try {
    const db = memorySupabase("u1", "c1", 100);
    const handler = handlerFor(db);
    const t0 = Date.now();
    let done = false;
    let response: any;
    const turn = handler.handleUserMessage({ userId: "u1", conversationId: "c1", message, userBalance: 5000 })
      .then((r) => { response = r; }).finally(() => { done = true; });
    while (!done) await vi.advanceTimersByTimeAsync(10);
    await turn;
    return { waves: (Date.now() - t0) / 100, response, db };
  } finally { vi.useRealTimers(); }
}

describe("a turn's database work shares waves (before: plan 10, YouTube 9, greeting 5)", () => {
  it("a plan request answers in at most five sequential waves", async () => {
    const { waves, response } = await measureWaves("هات ١٠ تغريدات عن كرة السلة");
    expect(response.outputType).toBe("ask_clarification");
    expect(waves).toBeLessThanOrEqual(5);
  });

  it("the «كل التعليقات» question answers in at most five sequential waves", async () => {
    const { waves, response } = await measureWaves("عايز كل تعليقات ٣ فيديوهات على يوتيوب");
    expect(response.clarificationItems.map((q: any) => q.id)).toEqual(["social_comment_target_required"]);
    expect(waves).toBeLessThanOrEqual(5);
  });

  it("a greeting answers in at most four sequential waves", async () => {
    const { waves, response } = await measureWaves("مساء الخير");
    expect(response.outputType).toBe("answer_question");
    expect(waves).toBeLessThanOrEqual(4);
  });

  it("the progress line is always written before the final text, so it can never overwrite it", async () => {
    const { response, db } = await measureWaves("هات ١٠ تغريدات عن كرة السلة");
    const assistantId = response.messageId;
    const writes = db.log.filter((entry) => entry.table === "messages" && entry.op === "update" && entry.id === assistantId);
    const progressAt = writes.findIndex((entry) => entry.payload?.content_ar === "أبحث وأحسب السعر...");
    const finalAt = writes.length - 1;
    expect(progressAt).toBeGreaterThanOrEqual(0);
    expect(finalAt).toBeGreaterThan(progressAt);
    expect(writes[finalAt].payload.content_ar).not.toBe("أبحث وأحسب السعر...");
    const stored = db.tables.messages.find((row) => row.id === assistantId);
    expect(stored.content_ar).not.toBe("أبحث وأحسب السعر...");
    expect(stored.content_ar).not.toBe("جاري التفكير وتحليل طلبك...");
  });
});

describe("the production path keeps the conversation history after the reordering", () => {
  const answer = (questionId: string, question: string, value: string) =>
    formatStructuredClarificationAnswers({ type: "clarification_answers", answers: [{ questionId, question, value }] } as any);

  it("a platform named in the second message completes the first request (history holds the earlier message, once)", async () => {
    const db = memorySupabase("u1", "c1");
    const handler = handlerFor(db);
    const send = (message: string) => handler.handleUserMessage({ userId: "u1", conversationId: "c1", message, userBalance: 5000 }) as Promise<any>;
    const first = await send("عايز كل تعليقات فيديوهات قناة الفيفا الرسمية عن منتخب مصر");
    expect(first.clarificationItems.map((q: any) => q.id)).toEqual(["social_platform_required"]);
    const second = await send("كل تعليقات ٣ فيديوهات على يوتيوب");
    expect(second.clarificationItems.map((q: any) => q.id)).toEqual(["volume_cap_required"]);
    expect(second.contentAr).toContain("منتخب مصر");
    const third = await send(answer("volume_cap_required", "ما الحد الأقصى لعدد التعليقات الذي تريده؟", "٢٠٠٠ تعليق"));
    expect(third.clarificationItems.map((q: any) => q.id)).toEqual(["social_time_required"]);
    const users = db.tables.messages.filter((row) => row.role === "user");
    expect(users).toHaveLength(3);
    expect(db.tables.messages.filter((row) => row.role === "assistant")).toHaveLength(3);
  });

  it("the brief saved in the same wave as the message writes is the one the next turn starts from", async () => {
    const db = memorySupabase("u1", "c1");
    const handler = handlerFor(db);
    const send = (message: string) => handler.handleUserMessage({ userId: "u1", conversationId: "c1", message, userBalance: 5000 }) as Promise<any>;
    await send("عايز ١٠٠ تغريدة عن الغلاء على إكس");
    const saved = db.tables.conversations[0].brief;
    expect(saved?.platforms).toContain("x");
  });

  it("a conversation without a saved brief is not read a second time", async () => {
    const db = memorySupabase("u1", "c1");
    const handler = handlerFor(db);
    await handler.handleUserMessage({ userId: "u1", conversationId: "c1", message: "مساء الخير", userBalance: 5000 });
    const conversationReads = db.log.filter((entry) => entry.table === "conversations" && entry.op === "select");
    expect(conversationReads).toHaveLength(1);
  });
});

describe("a long wait keeps saying that the work goes on", () => {
  it("staged text by elapsed time", () => {
    expect(waitProgressText("أبحث وأحسب السعر...", 0)).toBe("أبحث وأحسب السعر...");
    expect(waitProgressText("أبحث وأحسب السعر...", 7_999)).toBe("أبحث وأحسب السعر...");
    expect(waitProgressText("أبحث وأحسب السعر...", 8_000)).toBe(WAIT_STILL_AR);
    expect(waitProgressText("أبحث وأحسب السعر...", 25_000)).toBe(WAIT_SLOW_AR);
    for (const text of [WAIT_STILL_AR, WAIT_SLOW_AR]) { expect(text).not.toMatch(/[A-Za-z]/); expect(text).not.toContain("رصيد"); }
  });

  it("the page runs the staged text only while a turn is loading, and clears its timer", () => {
    const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(page).toContain("waitProgressText(loadingBaseText.current, Date.now() - startedAt)");
    expect(page).toMatch(/if \(!loading\) return;\s*const startedAt = Date\.now\(\);[\s\S]*clearInterval\(timer\)/);
  });
});
