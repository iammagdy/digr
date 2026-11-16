import { afterEach, describe, expect, it } from "vitest";
import { setChatModelForTesting, type ChatModelCall } from "../src/lib/agentMission/chatModel";
import { buildSystemPrompt, decideTurn, MAX_REPLY_CHARS } from "../src/lib/agentMission/conversationModel";

/**
 * NATURAL CHAT (owner direction, 16 Nov 2026): the chat answers a greeting, small talk or a general question like a normal assistant (Claude, ChatGPT, Gemini), in the customer's own dialect, at the length the talk needs;
 * a reply the code's guard refused is asked again ONCE with the reasons, so the customer reads a natural answer and not the fixed text. The model is scripted here.
 */
afterEach(() => setChatModelForTesting(null));
const json = (o: Record<string, unknown>) => JSON.stringify({ reason: "t", reply: "", count: null, ...o });
const scripted = (replies: string[]): { model: ChatModelCall; systems: string[] } => {
  const systems: string[] = [];
  const model: ChatModelCall = async (input) => { systems.push(input.system); const text = replies.shift(); return text === undefined ? { ok: false, failure: "none" } : { ok: true, text }; };
  return { model, systems };
};

describe("the chat talks like an assistant", () => {
  it("its instructions ask for a natural reply in the customer's dialect, no sales pitch on every message, and a length that fits the talk", () => {
    const system = buildSystemPrompt({ balancePoints: null, open: null });
    expect(system).toContain("ازيك");
    expect(system).toContain("لا تحوّل كل رسالة إلى عرض للخدمة");
    expect(system).toContain("بلغة العميل ولهجته نفسها");
    expect(system).not.toContain("من جملة إلى أربع جمل");
  });

  it("«ازيك» is answered by the model's own natural words (nothing fixed)", async () => {
    const reply = "الحمد لله تمام، وإنت عامل إيه؟ بتفكر في إيه النهارده؟";
    const { model } = scripted([json({ type: "greeting_or_small_talk", reply })]);
    const d = await decideTurn({ message: "ازيك", balancePoints: null, open: null }, model);
    expect(d).toMatchObject({ type: "greeting_or_small_talk", source: "model", guarded: false, reply });
  });

  it("a longer helpful answer is kept (the limit is for runaway text, not for a short chat)", async () => {
    const reply = `${"هذه إجابة وافية عن سؤالك العام بالتفصيل. ".repeat(20)}`.trim();
    expect(reply.length).toBeGreaterThan(600);
    expect(reply.length).toBeLessThan(MAX_REPLY_CHARS);
    const { model } = scripted([json({ type: "other", reply })]);
    const d = await decideTurn({ message: "اشرحلي الفرق بين الاستبيان والمقابلة", balancePoints: null, open: null }, model);
    expect(d.reply).toBe(reply);
  });

  it("a reply the guard refuses (a Latin digit) is asked again once with the reason; the second, clean reply is shown", async () => {
    const { model, systems } = scripted([json({ type: "other", reply: "عندنا 5 منصات بنخدمها." }), json({ type: "other", reply: "عندنا خمس منصات بنخدمها." })]);
    const d = await decideTurn({ message: "بتخدموا كام منصة؟", balancePoints: null, open: null }, model);
    expect(d).toMatchObject({ source: "model", guarded: false, reply: "عندنا خمس منصات بنخدمها." });
    expect(systems).toHaveLength(2);
    expect(systems[1]).toContain("فيه رقم لاتيني");
  });

  it("two refused replies in a row → the fixed answer takes over (never an unguarded reply)", async () => {
    const { model } = scripted([json({ type: "other", reply: "عندنا 5 منصات." }), json({ type: "other", reply: "عندنا 6 منصات." })]);
    const d = await decideTurn({ message: "بتخدموا كام منصة؟", balancePoints: null, open: null }, model);
    expect(d).toMatchObject({ reply: null, guarded: true });
  });
});

describe("a question the agent asked the customer (what the real search found) stays open while the customer chats", () => {
  const open = { id: "msn_x", state: "needs_input" as const, requestText: "٤٠٠ تغريدة من حساب وزارة الصحة", questionAr: "وجدنا ٤ تغريدات فقط من ٤٠٠ طلبتها. تحب نسلّمك الموجود ولا نوسّع البحث؟" };
  it("the model is told how to treat the choices, the answer in the customer's own words, and a doubt about the question", () => {
    const system = buildSystemPrompt({ balancePoints: null, open });
    expect(system).toContain("سؤال الوكيل له: «وجدنا ٤ تغريدات فقط من ٤٠٠");
    expect(system).toContain("«وسّع على السعودية كلها»");
    expect(system).toContain("open_request_question");
  });
  it("an explanation of the question may repeat the numbers of the question itself (and no others)", async () => {
    const ok = "يعني بحثنا لقينا ٤ تغريدات بس من ٤٠٠ اللي طلبتها. تحب تاخد الـ٤ دول ولا نوسّع البحث؟";
    const bad = "يعني بحثنا لقينا ٩٠٠ تغريدة، تحب نكمل؟";
    const a = await decideTurn({ message: "يعني إيه توسّع؟", balancePoints: null, open }, scripted([json({ type: "open_request_question", reply: ok })]).model);
    expect(a).toMatchObject({ type: "open_request_question", reply: ok, guarded: false });
    const b = await decideTurn({ message: "يعني إيه توسّع؟", balancePoints: null, open }, scripted([json({ type: "open_request_question", reply: bad }), json({ type: "open_request_question", reply: bad })]).model);
    expect(b).toMatchObject({ reply: null, guarded: true });
  });
});
