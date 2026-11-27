import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./helpers/memoryDb";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { setChatModelForTesting } from "../src/lib/agentMission/chatModel";
import { fakeChatModel } from "./helpers/fakeChatModel";

/**
 * UL2a-1 (DT-20261126-wordlist-wave4, D-0241 G1; F1 of the STEP 0 trace). A general question about the service («انت بتعمل ايه», «ما هي خدماتك», «كيف تعمل المنصة» …) used to be sent, by a phrase list, to the handler's own LEGACY model turn:
 * the old planning prompt, an output type nothing constrained, and below it the code that builds quotes. It is now a chat turn of the AGENT like every other message: the agent's chat model names its kind and writes the reply under the
 * code guard (conversationModel.ts), the type set has no plan in it, and no quote code is reachable from that path. Offline: the real `ChatHandler.handleUserMessage` with the agent switched on, a scripted chat model, a throwing network.
 */
const USER = "u1";
const QUESTIONS = ["انت بتعمل ايه؟", "ما هي خدماتك", "كيف تعمل المنصة", "ازاي بتشتغل", "ماذا تقدم", "بتساعد في ايه", "ما وظيفتك", "ماذا تفعل"];
function world(model: ReturnType<typeof fakeChatModel>) {
  const db: any = createMemoryDb();
  db.seed("conversations", [{ id: "conv1", user_id: USER, title: "محادثة جديدة", status: "active" }]);
  db.seed("profiles", [{ id: USER, email: "a@example.com" }]);
  db.seed("credit_ledger", [{ user_id: USER, delta: 11676 }]);
  for (const t of ["plans_quotes", "jobs", "missions"]) db.seed(t, []);
  setChatModelForTesting(model.call);
  const handler = new ChatHandler(db);
  const oldPath = vi.fn(async () => { throw new Error("the old model path ran"); });
  (handler as any).llm.executeTurn = oldPath;
  handler.agentChat = { enabled: true };
  const ledger = JSON.stringify(db.rows("credit_ledger"));
  return { db, oldPath, ask: (message: string) => handler.handleUserMessage({ userId: USER, conversationId: "conv1", message, userBalance: 40_000 }) as Promise<any>, ledgerUnchanged: () => JSON.stringify(db.rows("credit_ledger")) === ledger };
}
beforeEach(() => { clearBriefCacheForTesting(); vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in this test"); })); });
afterEach(() => { setChatModelForTesting(null); vi.unstubAllGlobals(); });

describe("a general question is a chat turn of the agent", () => {
  it.each(QUESTIONS)("«%s»: the agent's model names it, the reply is a conversation, the old model path and every quote table stay untouched", async (text) => {
    const model = fakeChatModel([], { override: () => ({ type: "service_question" }) });
    const w = world(model);
    const r = await w.ask(text);
    expect(w.oldPath).not.toHaveBeenCalled();
    expect(model.calls).toHaveLength(1);
    expect(r.outputType).toBe("answer_question");
    expect(String(r.contentAr).length).toBeGreaterThan(10);
    expect(w.db.rows("missions")).toHaveLength(0);
    expect(w.db.rows("plans_quotes")).toHaveLength(0);
    expect(w.db.rows("jobs")).toHaveLength(0);
    expect(w.ledgerUnchanged()).toBe(true);
  });

  it("THE F1 CASE: a model that answers a general question with a PLAN (a type the chat does not have) creates nothing: no mission, no quote, no job, no money", async () => {
    const model = fakeChatModel([], { override: () => ({ type: "propose_plan", reply: "هذه خطتك: ٥٠٠ تعليق بسعر ٢٠٠٠ نقطة", planQuote: { total: 2000 }, items: [{ capabilitySlug: "x" }] }) });
    const w = world(model);
    const r = await w.ask("انت بتعمل ايه؟");
    expect(w.oldPath).not.toHaveBeenCalled();
    expect(r.outputType).not.toBe("agent_mission");
    expect(r.planQuote).toBeUndefined();
    expect(w.db.rows("missions")).toHaveLength(0);
    expect(w.db.rows("plans_quotes")).toHaveLength(0);
    expect(w.db.rows("jobs")).toHaveLength(0);
    expect(w.ledgerUnchanged()).toBe(true);
  });

  it("a model that is down, or answers with garbage: the question still gets a conversational answer (the fixed reply of its kind), nothing is started", async () => {
    for (const failure of ["fail", "garbage"] as const) {
      const w = world(fakeChatModel([], { override: () => failure }));
      const r = await w.ask("ما هي خدماتك");
      expect(w.oldPath).not.toHaveBeenCalled();
      expect(r.outputType).toBe("answer_question");
      expect(w.db.rows("missions")).toHaveLength(0);
      expect(w.db.rows("plans_quotes")).toHaveLength(0);
      expect(w.ledgerUnchanged()).toBe(true);
    }
  });

  it("counter-case (the accepted residual risk, made explicit): a model that mistakes a general question for a data request queues ONE unapproved mission; nothing is charged, no quote exists", async () => {
    const w = world(fakeChatModel([], { override: () => ({ type: "data_request" }) }));
    const r = await w.ask("انت بتعمل ايه؟");
    expect(r.outputType).toBe("agent_mission");
    expect(w.db.rows("missions")).toHaveLength(1);
    expect(w.db.rows("missions")[0].status).toBe("queued");
    expect(w.db.rows("plans_quotes")).toHaveLength(0);
    expect(w.db.rows("jobs")).toHaveLength(0);
    expect(w.ledgerUnchanged()).toBe(true);
  });

  describe("a general question asked while an UNAPPROVED plan card is open (D-0242, جوني's note)", () => {
    const OPEN_REQUEST = "هات ٣٠٠ تغريدة عن محمد صلاح بعد انتقاله لتركيا";
    /** The first message makes the open request (the model types it a data request); the question is typed by the scripted model as `type`. */
    async function openWorld(type: string) {
      const w = world(fakeChatModel([], { override: (text: any) => (typeof text === "string" && text.includes("انت بتعمل") ? { type } : { type: "data_request" }) }));
      await w.ask(OPEN_REQUEST);
      const mission = w.db.rows("missions")[0];
      mission.status = "plan_ready";
      mission.plan_public = mission.plan_public ?? { price: { total_points: 100 } };
      const snapshot = () => JSON.stringify(w.db.rows("missions").map((m: any) => [m.id, m.status, m.request_text, m.plan_public]));
      return { w, mission, before: snapshot(), snapshot };
    }

    it("the model names it right (service_question) or as a question about the open request: the open plan card is byte-for-byte what it was, the answer is a conversation, 0 quotes, 0 jobs, ledger unchanged", async () => {
      for (const type of ["service_question", "open_request_question"]) {
        const o = await openWorld(type);
        const r = await o.w.ask("انت بتعمل ايه؟");
        expect(r.outputType, type).toBe("answer_question");
        expect(o.snapshot(), type).toBe(o.before);
        expect(o.w.db.rows("missions"), type).toHaveLength(1);
        expect(o.w.oldPath).not.toHaveBeenCalled();
        expect(o.w.db.rows("plans_quotes")).toHaveLength(0);
        expect(o.w.db.rows("jobs")).toHaveLength(0);
        expect(o.w.ledgerUnchanged()).toBe(true);
      }
    });

    it("THE WIDER RESIDUAL, made explicit: a model that mistypes the question as a data request (or as an edit) REPLACES the open unapproved mission by ONE new queued one; the replacement is never approved: 0 quotes, 0 jobs, ledger unchanged", async () => {
      for (const type of ["data_request", "edit_of_open_request"]) {
        const o = await openWorld(type);
        const r = await o.w.ask("انت بتعمل ايه؟");
        expect(r.outputType, type).toBe("agent_mission");
        const missions = o.w.db.rows("missions") as any[];
        expect(missions, type).toHaveLength(2);
        expect(missions.filter((m) => m.status === "cancelled"), type).toHaveLength(1);
        const fresh = missions.find((m) => m.id !== o.mission.id)!;
        expect(fresh.status, type).toBe("queued");
        expect(["approved", "executing", "completed"]).not.toContain(fresh.status);
        expect(o.w.db.rows("plans_quotes"), type).toHaveLength(0);
        expect(o.w.db.rows("jobs"), type).toHaveLength(0);
        expect(o.w.ledgerUnchanged(), type).toBe(true);
      }
    });
  });

  it("counter-case: a greeting is still answered by code with no model call; a research request still becomes a mission", async () => {
    const greet = world(fakeChatModel([], { override: () => ({ type: "data_request" }) }));
    const g = await greet.ask("مرحبا");
    expect(g.outputType).toBe("answer_question");
    expect((greet.db.rows("missions") as unknown[]).length).toBe(0);
    const research = world(fakeChatModel([], { override: () => ({ type: "data_request" }) }));
    const r = await research.ask("هات ١٠ تعليقات من تيك توك عن السياحة");
    expect(r.outputType).toBe("agent_mission");
  });
});
