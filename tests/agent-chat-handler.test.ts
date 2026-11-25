import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./helpers/memoryDb";
import { CHAT_PREP_REASON_AR, ChatHandler } from "../src/functions/shared/chatHandler";
import { setChatModelForTesting } from "../src/lib/agentMission/chatModel";
import { fakeChatModel } from "./helpers/fakeChatModel";

/** The chat handler with the agent switched on: a research request becomes a mission and nothing else runs (no model planner, no old model turn, no provider). */
function setup(enabled: boolean | null) {
  const db: any = createMemoryDb();
  db.seed("conversations", [{ id: "conv1", user_id: "u1", title: "محادثة جديدة", status: "active" }]);
  db.seed("profiles", [{ id: "u1", email: "a@example.com" }]);
  const handler = new ChatHandler(db);
  const oldPath = vi.fn(async () => { throw new Error("the old model path ran"); });
  (handler as any).llm.executeTurn = oldPath;
  if (enabled !== null) handler.agentChat = { enabled };
  return { db, handler, oldPath };
}
const ask = (handler: ChatHandler, message: string) => handler.handleUserMessage({ userId: "u1", conversationId: "conv1", message, userBalance: 40_000 });

describe("the chat hands a research request to the agent", () => {
  it("creates a queued mission for the user, keeps its id on the assistant message and answers with the mission card's id", async () => {
    const { db, handler, oldPath } = setup(true);
    const r: any = await ask(handler, "هات ٣٠٠ تغريدة عن محمد صلاح بعد انتقاله لتركيا");
    expect(r.outputType).toBe("agent_mission");
    expect(r.agentMission.id).toMatch(/^msn_[a-z0-9]{20}$/);
    expect(r.planQuote).toBeUndefined();
    expect(oldPath).not.toHaveBeenCalled();
    expect(db.rows("missions")).toHaveLength(1);
    expect(db.rows("missions")[0]).toMatchObject({ id: r.agentMission.id, user_id: "u1", status: "queued", request_text: "هات ٣٠٠ تغريدة عن محمد صلاح بعد انتقاله لتركيا" });
    const assistant = db.rows("messages").find((m: any) => m.id === r.messageId);
    // P0 (research spec): the card also carries the customer's own words, exactly as typed (code-written)
    expect(assistant.plan).toEqual({ agentMissionId: r.agentMission.id, customerWords: ["هات ٣٠٠ تغريدة عن محمد صلاح بعد انتقاله لتركيا"] });
    expect(db.rows("plans_quotes")).toHaveLength(0);
  });

  afterEach(() => { setChatModelForTesting(null); });

  it("a second request replaces the unapproved plan above it", async () => {
    setChatModelForTesting(fakeChatModel([], { override: () => ({ type: "data_request" }) }).call);
    const { db, handler } = setup(true);
    const first: any = await ask(handler, "هات ٣٠٠ تغريدة عن محمد صلاح بعد انتقاله لتركيا");
    db.rows("missions")[0].status = "plan_ready";
    const second: any = await ask(handler, "خليها ٥٠٠ تغريدة عن محمد صلاح بعد انتقاله لتركيا");
    expect(second.agentMission.id).not.toBe(first.agentMission.id);
    expect(db.rows("missions").find((m: any) => m.id === first.agentMission.id).status).toBe("cancelled");
    expect(db.rows("missions").find((m: any) => m.id === second.agentMission.id).status).toBe("queued");
  });

  it("with the switch off (the rollback constant false, or never set) the old path answers, exactly as before", async () => {
    for (const enabled of [false, null]) {
      const { db, handler, oldPath } = setup(enabled);
      const r: any = await ask(handler, "هات ٣٠٠ تغريدة عن محمد صلاح بعد انتقاله لتركيا");
      // the old hand-coded path answered (here with its own question about the time window)
      expect(r.outputType).not.toBe("agent_mission");
      expect(r.agentMission).toBeUndefined();
      expect(r.clarificationItems?.[0]?.id).toBe("social_time_required");
      expect(db.rows("missions")).toHaveLength(0);
      void oldPath;
    }
  });
});

describe("DT-20261117-06 T6: a failed chat turn stores one reviewed constant", () => {
  it("T6 a thrown turn stores CHAT_PREP_REASON_AR as request_error, whatever the error says", async () => {
    for (const thrown of [new Error("TypeError: x"), new Error("تعذر الاتصال بفايركرول")]) {
      const { db, handler, oldPath } = setup(false);
      handler.deterministicPlanning = false; // a request with a stated period is planned in code (chatHandler.ts:2993); the throw must be reached
      oldPath.mockImplementation(async () => { throw thrown; });
      await expect(ask(handler, "هات ١٠ تغريدات عن كرة السلة في ٢٠٢٥")).rejects.toThrow(); // the request names its period: no time-window question (chatHandler.ts:2821); the same text as stall-guard.test.ts:7
      expect(oldPath).toHaveBeenCalled(); // non-vacuity: the model call really ran and threw
      const userRows = db.rows("messages").filter((m: any) => m.role === "user");
      expect(userRows).toHaveLength(1);
      expect(userRows[0].request_status).toBe("failed");
      expect(userRows[0].request_error).toBe(CHAT_PREP_REASON_AR);
    }
  });
});
