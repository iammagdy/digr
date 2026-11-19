import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * DT-20261118-06 phase 2A: «اكتب بالذكاء الاصطناعي». The model drafts the four fields from the admin's note; the server refuses a draft the customer-text guard refuses
 * (one automatic retry, then the guard sentence with the fields), refuses an amount of points or money the admin did not write, counts 20 drafts per admin per hour
 * in the audit table BEFORE the model is called, and sends the model ONLY the note, the tone and the audience label (never a customer's name, address, id or balance).
 */
const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const state = vi.hoisted(() => ({
  auth: "admin" as "admin" | "none",
  events: [] as string[],
  calls: [] as Array<{ system: string; content: unknown; maxTokens: number }>,
  replies: [] as unknown[],
  used: 0,
  audits: [] as Array<Record<string, unknown>>,
}));

vi.mock("../src/lib/server/adminAuth", () => ({
  authenticateAdmin: vi.fn(async () => state.auth === "admin"
    ? { ok: true, ctx: { adminId: ADMIN_ID, adminEmail: "owner@example.test", audit: async () => {} } }
    : { ok: false, response: new Response(JSON.stringify({ error: "غير مصرح" }), { status: 401 }) }),
}));
vi.mock("../src/lib/supabase/server", () => {
  const table = () => {
    const q: any = {
      select: () => q, eq: () => q,
      gte: async () => { state.events.push("count"); return { count: state.used, error: null }; },
      insert: async (row: Record<string, unknown>) => { state.events.push(`insert:${String(row.target_id)}`); state.audits.push(row); return { error: null }; },
    };
    return q;
  };
  return { createAdminClient: () => ({ from: () => table() }), createServerSideClient: vi.fn() };
});
vi.mock("../src/lib/server/invoices/assist", () => ({
  callAnthropicBlocks: vi.fn(async (system: string, content: unknown, maxTokens: number) => {
    state.events.push("model");
    state.calls.push({ system, content, maxTokens });
    return state.replies.shift() ?? { ok: false, code: "network" };
  }),
}));

import { DRAFT_ERRORS_AR, DRAFT_MAX_NOTE_CHARS, DRAFT_TONES, draftIssues, draftSystemPrompt, parseDraftReply, type MessageDraft } from "../src/lib/messageDraft";
import { runDraft, type DraftDeps } from "../src/lib/server/messageDraft";
import type { ModelReply } from "../src/lib/server/invoices/assist";
import { POST } from "../src/app/api/admin/messages/draft/route";

const GOOD: MessageDraft = {
  subject: "ملفاتك تصلك أسرع الآن",
  badge: "جديد في ديجر",
  heading: "تسليم أسرع لملفات إكسل",
  body: "{الاسم}، تحية طيبة،\n\nأصبحت ملفات إكسل تصلك أسرع من قبل، ويمكنك تجربة طلب جديد اليوم.",
  ctaLabel: "اطلب الآن",
};
const reply = (d: object | string): ModelReply => ({ ok: true, text: typeof d === "string" ? d : JSON.stringify(d), inputTokens: 120, outputTokens: 80, stopReason: "end_turn" });
const INPUT = { adminId: ADMIN_ID, note: "أخبر العملاء أن ملفات إكسل أصبحت تُسلَّم أسرع", tone: "ودّية", audience: "news_opt_in" };

function fake(replies: ModelReply[], opts: { used?: number; recordOk?: boolean } = {}) {
  const log: string[] = [];
  const inputs: string[] = [];
  const deps: DraftDeps = {
    now: () => new Date("2026-11-19T10:00:00Z"),
    countAttempts: async () => { log.push("count"); return opts.used ?? 0; },
    recordAttempt: async () => { log.push("record"); return opts.recordOk ?? true; },
    recordUsage: async () => { log.push("usage"); },
    callModel: async (_system, user) => { log.push("model"); inputs.push(user); return replies.shift() ?? { ok: false, code: "network" }; },
  };
  return { deps, log, inputs };
}

describe("the draft contract (pure)", () => {
  it("the system prompt asks for Arabic only, «إكسل», no amounts, no provider names, no «صف/سجل», and ONLY the JSON object", () => {
    const p = draftSystemPrompt();
    for (const s of ["إكسل", "Excel", '"subject"', '"badge"', '"heading"', '"body"', '"ctaLabel"', "JSON", "price", "discount", "refund", "points", "provider", "صف", "سجل", "{الاسم}", "150", "5000"]) expect(p, s).toContain(s);
    expect(DRAFT_TONES).toEqual(["رسمية", "ودّية", "مختصرة"]);
    expect(DRAFT_MAX_NOTE_CHARS).toBe(2000);
  });

  it("parseDraftReply reads a fenced or bare object and refuses prose or a missing field", () => {
    expect(parseDraftReply("```json\n" + JSON.stringify(GOOD) + "\n```")).toEqual({ ok: true, draft: GOOD });
    expect(parseDraftReply("هذه مسودتك: " + JSON.stringify({ ...GOOD, badge: undefined, ctaLabel: undefined }))).toEqual({ ok: true, draft: { ...GOOD, badge: "", ctaLabel: "" } });
    expect(parseDraftReply("لا أستطيع").ok).toBe(false);
    expect(parseDraftReply(JSON.stringify({ subject: "موضوع", heading: "عنوان" })).ok).toBe(false);
  });

  it.each([
    ["an amount of points the admin did not write", "ستحصل على ١٠٠ نقطة هدية في طلبك القادم.", "أخبرهم بالميزة الجديدة", true],
    ["the same amount the admin wrote", "ستحصل على ١٠٠ نقطة هدية في طلبك القادم.", "أعطهم ١٠٠ نقطة هدية", false],
    ["Latin digits of the admin's Arabic-Indic amount", "ستحصل على 100 نقطة هدية في طلبك القادم.", "أعطهم ١٠٠ نقطة هدية", false],
    ["a price within three words", "الباقة الآن بسعر ٥٠ فقط جنيه مصري للطلب.", "أخبرهم بالباقة", true],
    ["a number that is not money", "يصلك ملفك خلال ٣ أيام من الطلب بإذن الله.", "أخبرهم بالسرعة", false],
  ])("money check: %s", (_name, sentence, note, refused) => {
    const issues = draftIssues({ ...GOOD, body: `{الاسم}، تحية طيبة،\n\n${sentence}` }, note);
    expect(issues.some((i) => i.field === "body"), JSON.stringify(issues)).toBe(refused);
  });
});

describe("runDraft", () => {
  it("a fake model reply fills the four fields and the button label; the slot is taken before the model and the usage after", async () => {
    const f = fake([reply("```json\n" + JSON.stringify(GOOD) + "\n```")]);
    const out = await runDraft(INPUT, f.deps);
    expect(out).toMatchObject({ ok: true, refused: false, draft: GOOD, remaining: 19 });
    expect(f.log).toEqual(["count", "record", "model", "usage"]);
    expect(f.inputs[0]).toContain(INPUT.note);
    expect(f.inputs[0]).toContain("ودّية");
  });

  it.each([
    ["a Latin word", { ...GOOD, body: "{الاسم}، تحية طيبة،\n\nأصبحت ملفات Excel تصلك أسرع من قبل، جرّب طلبًا جديدًا." }],
    ["«صف»", { ...GOOD, body: "{الاسم}، تحية طيبة،\n\nأصبح ملفك يصلك وفيه ٥٠٠ صف من النتائج، جرّب طلبًا جديدًا." }],
  ])("a reply with %s is refused after exactly one retry, with the guard sentence and the fields", async (_name, bad) => {
    const f = fake([reply(bad), reply(bad), reply(GOOD)]);
    const out = await runDraft(INPUT, f.deps);
    expect(f.log.filter((x) => x === "model")).toHaveLength(2);
    expect(f.inputs[1]).toContain(INPUT.note);
    expect(f.inputs[1].length).toBeGreaterThan(f.inputs[0].length); // the issues are appended to the second request
    expect(out).toMatchObject({ ok: true, refused: true, draft: bad, fields: ["body"] });
    expect(out.ok && out.refused && out.message).toBe("المسودة تحتوي على ما لا يصلح للعميل (أحرف لاتينية أو أسماء مزودين أو أرقام داخلية). عدّلها أو أعد الكتابة.");
  });

  it("the retry's good answer is used", async () => {
    const f = fake([reply({ ...GOOD, heading: "Diger الجديد" }), reply(GOOD)]);
    expect(await runDraft(INPUT, f.deps)).toMatchObject({ ok: true, refused: false, draft: GOOD });
    expect(f.log.filter((x) => x === "model")).toHaveLength(2);
  });

  it.each([
    ["the hour's allowance is used up", { used: 20 }, ["count"], 429, "بلغت حد الاستخدام لهذه الساعة؛ حاول بعد قليل."],
    ["the slot cannot be recorded", { recordOk: false }, ["count", "record"], 503, "الكاتب الذكي غير متاح الآن. يمكنك كتابة الرسالة بنفسك."],
  ])("rate limit: %s means no model call", async (_name, opts, log, status, message) => {
    const f = fake([reply(GOOD)], opts);
    const out = await runDraft(INPUT, f.deps);
    expect(out).toMatchObject({ ok: false, status, message });
    expect(f.log).toEqual(log);
  });

  it.each([
    [{ ok: false, code: "no_key" } as ModelReply, 503, "الكاتب الذكي غير متاح الآن. يمكنك كتابة الرسالة بنفسك."],
    [{ ok: false, code: "timeout" } as ModelReply, 504, "لم تصل المسودة في الوقت المناسب. أعد المحاولة."],
    [{ ok: false, code: "http" } as ModelReply, 502, "لم تصل المسودة في الوقت المناسب. أعد المحاولة."],
  ])("model failure %j gives its sentence", async (r, status, message) => {
    expect(await runDraft(INPUT, fake([r]).deps)).toMatchObject({ ok: false, status, message });
    expect(DRAFT_ERRORS_AR.unavailable).toBe("الكاتب الذكي غير متاح الآن. يمكنك كتابة الرسالة بنفسك.");
  });

  it.each([
    ["an empty note", { note: "   " }],
    ["a note over 2000 characters", { note: "ا".repeat(2001) }],
    ["an unknown tone", { tone: "غاضبة" }],
    ["an unknown audience", { audience: "everyone" }],
  ])("%s is refused before any slot or model call", async (_name, over) => {
    const f = fake([reply(GOOD)]);
    const out = await runDraft({ ...INPUT, ...over }, f.deps);
    expect(out).toMatchObject({ ok: false, status: 400 });
    expect(f.log).toEqual([]);
  });
});

describe("POST /api/admin/messages/draft", () => {
  beforeEach(() => { state.auth = "admin"; state.events = []; state.calls = []; state.replies = []; state.used = 0; state.audits = []; });
  const post = (body: unknown) => POST(new NextRequest("http://x/api/admin/messages/draft", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));

  it("ignores every field but note, tone and audience: no customer name, address, id or balance reaches the model", async () => {
    state.replies = [reply(GOOD)];
    const r = await post({ note: INPUT.note, tone: "رسمية", audience: "single", email: "x@y.z", name: "منى", userId: "u-7f3c9e", balance: 987654, customer: { email: "x@y.z" } });
    expect(r.status).toBe(200);
    expect((await r.json()).draft).toEqual(GOOD);
    expect(state.calls).toHaveLength(1);
    const sent = JSON.stringify(state.calls[0]);
    for (const leak of ["x@y.z", "منى", "u-7f3c9e", "987654", "balance", "email", "userId"]) expect(sent, leak).not.toContain(leak);
    expect(String(state.calls[0].content)).toContain(INPUT.note);
    expect(String(state.calls[0].content)).toContain("رسمية");
    expect(state.events).toEqual(["count", "insert:attempt", "model", "insert:usage"]);
    expect(state.audits[0]).toMatchObject({ actor_id: ADMIN_ID, target_type: "message_draft", target_id: "attempt" });
  });

  it("a refused draft comes back with its fields and the guard sentence (status 200, refused)", async () => {
    const bad = { ...GOOD, subject: "Diger news" };
    state.replies = [reply(bad), reply(bad)];
    const r = await post({ note: INPUT.note, tone: "مختصرة", audience: "news_opt_in" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ refused: true, draft: bad, fields: ["subject"], error: DRAFT_ERRORS_AR.refused });
  });

  it("answers a non-admin before anything else: no slot, no model call", async () => {
    state.auth = "none";
    const r = await post({ note: INPUT.note, tone: "رسمية", audience: "single" });
    expect(r.status).toBe(401);
    expect(state.events).toEqual([]);
  });

  it("over the hour's allowance: 429 with the sentence and no model call", async () => {
    state.used = 20;
    const r = await post({ note: INPUT.note, tone: "رسمية", audience: "single" });
    expect(r.status).toBe(429);
    expect((await r.json()).error).toBe(DRAFT_ERRORS_AR.rate);
    expect(state.calls).toHaveLength(0);
  });
});
