import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb, type MemoryDb } from "./helpers/memoryDb";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { agentChatTurn } from "../src/lib/agentMission/chatTurn";
import { createCustomerMission } from "../src/lib/agentMission/customerActions";

/**
 * REPLAY OF THE INCIDENT OF 2026-10-30 (test account, read-only evidence in docs/ENGINE_AND_ITEM_STORE.md section 16). Every new request and «إعادة المحاولة» were refused with «عندك مهام مفتوحة بالفعل
 * قيد الإعداد», «طلباتي» showed nothing in progress, and no worker mission existed. The rows below are the account's missions as the database held them (ids, statuses and times as read), and only functions
 * that exist on main are called, so this file fails on main and passes with the fix.
 *
 * The state: three missions in `needs_input` (the agent asked a question nobody answered; one from 2026-10-28, two from the night, each in its own abandoned conversation), the worker alive, nothing queued or planning,
 * every other mission finished, cancelled or failed, and every hold released.
 */
const ME = "b0d08be8-db61-4860-841e-fa963045557e";
const NOW = Date.parse("2026-10-30T15:31:30Z");
const ISO = (t: string) => `${t.replace(" ", "T")}Z`;

const incidentMissions = () => [
  { id: "msn_4b08aab1dfe4b5d5b8ee", user_id: ME, status: "needs_input", request_text: "استخرج لي بيانات حساب عام على تيك توك مع الإحصائيات العامة", created_at: ISO("2026-10-28 18:03:15"), lease_until: null, job_id: null },
  { id: "msn_cc494158fa9f27ff1ab7", user_id: ME, status: "needs_input", request_text: "عايز بيانات عن السوق المصري", created_at: ISO("2026-10-30 01:29:12"), lease_until: null, job_id: null },
  { id: "msn_61f9f496279cacccc067", user_id: ME, status: "needs_input", request_text: "عايز ٥ حاجات عن السياحة", created_at: ISO("2026-10-30 01:43:20"), lease_until: null, job_id: null },
  { id: "msn_0dd51aa74efc716c95ad", user_id: ME, status: "plan_ready", request_text: "عايز ٥ تعليقات من فيديو يوتيوب عن الأهرامات", created_at: ISO("2026-10-30 00:59:41"), lease_until: null, job_id: null },
  { id: "msn_f86308d4f2797152e991", user_id: ME, status: "completed", request_text: "عايز ٥٠ شركة مقاولات", created_at: ISO("2026-10-29 22:29:36"), lease_until: null, job_id: "job_quote_934589e4c232390bc15c229ba850f804" },
  { id: "msn_825b320dbe34155a9bf5", user_id: ME, status: "failed", request_text: "عايز حالة الطقس", created_at: ISO("2026-10-30 01:27:58"), lease_until: null, job_id: null },
  { id: "msn_f000396ad8994a5cf407", user_id: ME, status: "unserved", request_text: "هات من قنوات", created_at: ISO("2026-10-29 21:50:58"), lease_until: null, job_id: "job_quote_de02baec183072d727541a2ff3c9f047" },
];

let db: MemoryDb;
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"], now: NOW }); db = createMemoryDb(); db.seed("missions", incidentMissions()); });
afterEach(() => { vi.useRealTimers(); });

const clientOf = (d: MemoryDb) => { const money = fakeMoneyClient(); return { client: { from: (t: string) => d.from(t), rpc: money.client.rpc } as any, money }; };

describe("the incident: three unanswered questions and a worker with nothing to do", () => {
  it("a new request is accepted: nothing is in the worker's hands, so nothing blocks it", async () => {
    const { client, money } = clientOf(db);
    const r = await createCustomerMission(client, { userId: ME, text: "عايز ٥ اسعار موبايلات من امازون مصر" });
    expect(r).toMatchObject({ ok: true });
    expect(db.rows("missions").filter((m) => m.status === "queued")).toHaveLength(1);
    expect(money.calls).toHaveLength(0);
  });

  it("the retry turn of the chat («أعد المحاولة بنفس الخطة») is accepted too, and the three questions stay as they were for the customer to answer or cancel", async () => {
    const { client } = clientOf(db);
    db.seed("conversations", [{ id: "c-retry", user_id: ME, title: "محادثة جديدة" }]);
    db.seed("messages", [{ id: "u1", conversation_id: "c-retry", role: "user", request_status: "planning" }, { id: "a1", conversation_id: "c-retry", role: "assistant", content_ar: "جاري التفكير" }]);
    const r = await agentChatTurn({ sb: client, userId: ME, conversationId: "c-retry", userMsgId: "u1", assistantMsgId: "a1", message: "أعد المحاولة بنفس الخطة. اعرض عرض سعر جديدًا فقط، ولا تعتمد أو تبدأ التنفيذ.", conversationTitle: "محادثة جديدة" });
    expect(r.ok).toBe(true);
    expect(db.rows("missions").filter((m) => m.status === "needs_input")).toHaveLength(3);
  });

  it("a refused request never leaves its message «planning» (the message of a request that did not become a mission)", async () => {
    const { client } = clientOf(db);
    // the worker really holds three missions: the limit refuses, and the refused message is finished, not left «planning» for good
    db.rows("missions").length = 0;
    db.seed("missions", ["a", "b", "c"].map((k) => ({ id: `msn_held000${k}`, user_id: ME, status: "queued", request_text: `طلب ${k}`, created_at: ISO("2026-10-30 15:20:00"), lease_until: null, job_id: null })));
    db.seed("messages", [{ id: "u2", conversation_id: "c2", role: "user", request_status: "planning" }, { id: "a2", conversation_id: "c2", role: "assistant", content_ar: "جاري التفكير" }]);
    const r = await agentChatTurn({ sb: client, userId: ME, conversationId: "c2", userMsgId: "u2", assistantMsgId: "a2", message: "طلب رابع", conversationTitle: "محادثة" });
    expect(r).toMatchObject({ ok: false, status: 429 });
    expect(db.rows("messages").find((m) => m.id === "u2")!.request_status).not.toBe("planning");
  });
});
