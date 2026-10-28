import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildMissionNotice, type MissionNoticeKind } from "../src/lib/agentMission/notices";
import { missionTitleAr } from "../src/lib/agentMission/fileNames";
import { sendMissionNotice } from "../src/lib/server/missionNotify";
import { resolveJobConversation } from "../src/lib/server/jobConversation";
import { openJobHref } from "../src/lib/requestLinks";
import { renderEmailTemplate } from "../supabase/functions/send-email/templates";
import { createMemoryDb } from "./helpers/memoryDb";
import { checkCustomerText } from "../src/lib/agentMission/text";

const TITLE = "تغريدات عن محمد صلاح";
const CASES: Array<{ kind: MissionNoticeKind; facts: { delivered: number; planned: number; chargedPoints: number; releasedPoints: number; hasJob: boolean } }> = [
  { kind: "completed", facts: { delivered: 300, planned: 300, chargedPoints: 200, releasedPoints: 10, hasJob: true } },
  { kind: "completed", facts: { delivered: 300, planned: 300, chargedPoints: 200, releasedPoints: 0, hasJob: true } },
  { kind: "partial", facts: { delivered: 230, planned: 300, chargedPoints: 154, releasedPoints: 56, hasJob: true } },
  { kind: "failed", facts: { delivered: 0, planned: 300, chargedPoints: 0, releasedPoints: 210, hasJob: true } },
  { kind: "unserved", facts: { delivered: 0, planned: 0, chargedPoints: 0, releasedPoints: 0, hasJob: false } },
];

describe("the completion e-mail and the in-site notice are about THIS mission: three different sentences, specific numbers", () => {
  it.each(CASES)("$kind: the subject, the preview line and the heading differ; each carries the mission or its figures; no English, no ASCII digit, no id", ({ kind, facts }) => {
    const n = buildMissionNotice(kind, facts, TITLE);
    const e = n.email!;
    expect(new Set([e.subject, e.preheader, e.heading]).size).toBe(3);
    for (const text of [e.subject, e.preheader, e.heading, e.lead, e.detail1, e.detail2, n.title, n.body].filter(Boolean)) {
      expect(checkCustomerText(text, { maxChars: 600 }).issues, text).toEqual([]);
      expect(text).not.toMatch(/[0-9]/);
      expect(text).not.toMatch(/msn_|job_|quote_|call_|USD|\$/);
    }
    // the mission is named (except the preview line, which carries the money)
    expect(e.subject).toContain(TITLE);
    expect(n.title).toContain(TITLE);
    expect(e.heading).toContain(TITLE);
    expect(e.lead).toContain(TITLE);
    expect(n.body).toContain(TITLE);
    expect(e.buttonLabel).toMatch(/افتح طلبك/);
    expect(e.buttonLabel).not.toBe("افتح طلباتي");
  });

  it("completed: delivered of requested in the subject, the points charged in the preview, the released hold said; partial says it is fewer than requested; nothing is called «اكتملت مهمتك» three times", () => {
    const done = buildMissionNotice("completed", CASES[0].facts, TITLE);
    expect(done.email!.subject).toBe("تغريدات عن محمد صلاح — سُلّم ٣٠٠ من ٣٠٠ صفًا");
    expect(done.email!.preheader).toContain("خُصم ٢٠٠ نقطة");
    expect(done.email!.detail2).toContain("حجز مؤقت مُحرَّر ١٠ نقاط");
    expect(done.email!.heading).toBe("ملفات «تغريدات عن محمد صلاح» جاهزة للتحميل");
    const part = buildMissionNotice("partial", CASES[2].facts, TITLE);
    expect(part.email!.subject).toBe("تغريدات عن محمد صلاح — سُلّم ٢٣٠ من ٣٠٠ فقط");
    expect(part.email!.lead).toContain("هذا كل ما وُجد مطابقًا لطلبك");
    expect(part.email!.heading).toContain("بعدد أقل من المطلوب");
    for (const n of [done, part]) expect([n.email!.subject, n.email!.preheader, n.email!.heading].filter((t) => t.includes("اكتملت مهمتك")).length).toBeLessThanOrEqual(0);
    const failed = buildMissionNotice("failed", CASES[3].facts, TITLE);
    expect(failed.email!.preheader).toBe("لم يُخصم منك شيء، وعاد حجز رصيدك كاملًا.");
    expect(failed.email!.subject).toContain("ولم يُخصم شيء");
  });

  it("the title of a mission is its subject, from the plan or, when planning failed, from the customer's own words (digits in Arabic-Indic, shortened at a word)", () => {
    expect(missionTitleAr({ plan: { stages: [{ deliver: true, title_ar: "التغريدات", relevance: { terms: ["محمد صلاح"], subject_ar: "محمد صلاح لاعب كرة القدم" } }] }, requestText: "هات 300 تغريدة عن محمد صلاح" })).toBe("تغريدات عن محمد صلاح");
    const none = missionTitleAr({ plan: null, requestText: "هات 300 تغريدة عن لاعب كرة القدم المصري المحترف في الدوري الإنجليزي ممتاز" });
    expect(none).toBe("هات ٣٠٠ تغريدة عن لاعب كرة القدم المصري المحترف");
    expect(none.length).toBeLessThanOrEqual(48);
    expect(missionTitleAr({ plan: null, requestText: "" })).toBe("مهمتك");
    expect(buildMissionNotice("completed", CASES[0].facts, null).email!.subject).toContain("مهمتك");
  });
});

describe("the e-mail template: the preview line is its own text; without one it falls back to the heading (the edge function is PREPARED here, not deployed)", () => {
  const vars = { Name: "منى", Subject: "تغريدات عن محمد صلاح — سُلّم ٣٠٠ من ٣٠٠ صفًا", Preheader: "خُصم ٢٠٠ نقطة مقابل ما سُلّم فقط.", Heading: "ملفات «تغريدات عن محمد صلاح» جاهزة للتحميل", Lead: "x", DetailOne: "y", DetailTwo: "", ButtonLabel: "افتح طلبك وحمّل الملفات", JobURL: "https://diger.tech/dashboard/chat?c=1" };
  const hidden = (html: string) => /<div style="display:none[^>]*>([^<]*)</.exec(html)?.[1] ?? "";
  it("the hidden preview carries the Preheader, the heading carries the Heading, the subject carries the Subject: three different texts", () => {
    const { subject, html } = renderEmailTemplate("job-update", vars);
    expect(subject).toBe(vars.Subject);
    expect(hidden(html)).toContain("خُصم ٢٠٠ نقطة مقابل ما سُلّم فقط.");
    expect(hidden(html)).not.toContain("ملفات «");
    expect(html).toContain(`>${vars.Heading.replace(/«/g, "«")}</h1>`);
  });
  it("a caller that sends no Preheader (the stalled-job notice, the owner's top-up alert) still gets a preview line: its heading", () => {
    const { Preheader: _omit, ...without } = vars;
    expect(hidden(renderEmailTemplate("job-update", without).html)).toContain("ملفات «تغريدات عن محمد صلاح» جاهزة للتحميل");
  });
  it("the template source reads {{ .Preheader }}", () => {
    expect(readFileSync("supabase/functions/send-email/templates.ts", "utf8")).toContain('preheader: "{{ .Preheader }}"');
  });
});

describe("what the sender puts in the mail and in the notice", () => {
  const sent: Array<{ body: any }> = [];
  beforeEach(() => {
    sent.length = 0;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.example";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-for-test";
    process.env.NEXT_PUBLIC_SITE_URL = "https://diger.tech";
    vi.stubGlobal("fetch", async (_url: string, init: any) => { sent.push({ body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({}) } as any; });
  });
  const world = () => {
    const db = createMemoryDb();
    db.seed("missions", [{ id: "msn_aaaa0001", user_id: "u1", job_id: "job_x", request_text: "هات 300 تغريدة عن محمد صلاح", plan: { stages: [{ deliver: true, title_ar: "التغريدات", relevance: { terms: ["محمد صلاح"], subject_ar: "محمد صلاح لاعب كرة القدم" } }] } }]);
    db.seed("messages", [{ id: "a1", user_id: "u1", role: "assistant", conversation_id: "conv_7", plan: { agentMissionId: "msn_aaaa0001" }, created_at: "2026-10-28T10:00:00Z" }]);
    const rows: any[] = [];
    const client: any = { auth: { admin: { getUserById: async () => ({ data: { user: { id: "u1", email: "m@example.com", user_metadata: { full_name: "منى" } } }, error: null }) } },
      from: (t: string) => (t === "notifications" ? { insert: async (r: any) => { rows.push(r); return { error: null }; } } : db.from(t)) };
    return { client, rows };
  };

  it("the e-mail: the mission's subject, its own preview line, a heading, and a button that opens THIS request's conversation; the in-site notice carries the same link", async () => {
    const { client, rows } = world();
    const r = await sendMissionNotice(client, { userId: "u1", missionId: "msn_aaaa0001", jobId: "job_x", kind: "completed", facts: CASES[0].facts });
    expect(r).toEqual({ inApp: true, email: true });
    const v = sent[0].body.vars;
    expect(v.Subject).toBe("تغريدات عن محمد صلاح — سُلّم ٣٠٠ من ٣٠٠ صفًا");
    expect(v.Preheader).toContain("خُصم ٢٠٠ نقطة");
    expect(new Set([v.Subject, v.Preheader, v.Heading]).size).toBe(3);
    expect(v.JobURL).toBe("https://diger.tech/dashboard/chat?jobId=job_x&c=conv_7");
    expect(rows[0].link).toBe("/dashboard/chat?jobId=job_x&c=conv_7");
    expect(rows[0].title).toContain("تغريدات عن محمد صلاح");
    expect(rows[0].body).toContain("خُصم ٢٠٠ نقطة");
  });

  it("a mission with no job (planning failed) opens its conversation; an older request with no conversation opens the list on that job", async () => {
    const { client, rows } = world();
    await sendMissionNotice(client, { userId: "u1", missionId: "msn_aaaa0001", jobId: null, kind: "unserved", facts: CASES[4].facts });
    expect(sent[0].body.vars.JobURL).toBe("https://diger.tech/dashboard/chat?c=conv_7");
    expect(rows[0].link).toBe("/dashboard/chat?c=conv_7");
    const lone: any = { auth: { admin: { getUserById: async () => ({ data: { user: { id: "u9", email: "z@example.com", user_metadata: {} } }, error: null }) } }, from: () => ({ insert: async () => ({ error: null }) }) };
    await sendMissionNotice(lone, { userId: "u9", missionId: "msn_zzzz0001", jobId: "job_old", kind: "completed", facts: CASES[0].facts });
    expect(sent[1].body.vars.JobURL).toBe("https://diger.tech/dashboard/requests?job=job_old");
  });
});

describe("«طلباتي» opens a request in ITS conversation, never in a new empty chat", () => {
  const db = () => {
    const d = createMemoryDb();
    const quoteId = "quote_old000000000001";
    const oldJob = `job_quote_${createHash("md5").update(quoteId).digest("hex")}`;
    d.seed("missions", [{ id: "msn_aaaa0001", user_id: "u1", job_id: "job_agent" }, { id: "msn_bbbb0002", user_id: "u2", job_id: "job_other" }]);
    d.seed("messages", [
      { id: "m1", user_id: "u1", role: "assistant", conversation_id: "conv_agent", plan: { agentMissionId: "msn_aaaa0001" }, created_at: "2026-10-28T10:00:00Z" },
      { id: "m2", user_id: "u1", role: "assistant", conversation_id: "conv_old", plan: null, quote: { quoteId }, created_at: "2026-10-01T10:00:00Z" },
      { id: "m3", user_id: "u2", role: "assistant", conversation_id: "conv_u2", plan: { agentMissionId: "msn_bbbb0002" }, created_at: "2026-10-28T11:00:00Z" },
    ]);
    d.seed("plans_quotes", [{ id: quoteId, user_id: "u1", status: "accepted" }]);
    return { d, oldJob };
  };

  it("an AGENT mission's job resolves to the conversation that holds its card", async () => {
    const { d } = db();
    expect(await resolveJobConversation(d, { userId: "u1", jobId: "job_agent" })).toEqual({ conversationId: "conv_agent", via: "mission" });
  });

  it("an older job resolves through its accepted quote (the job id is job_quote_<md5 of the quote id>)", async () => {
    const { d, oldJob } = db();
    expect(await resolveJobConversation(d, { userId: "u1", jobId: oldJob })).toEqual({ conversationId: "conv_old", via: "quote" });
  });

  it("another customer's request never resolves; an unknown job resolves to nothing", async () => {
    const { d } = db();
    expect(await resolveJobConversation(d, { userId: "u1", jobId: "job_other" })).toBeNull();
    expect(await resolveJobConversation(d, { userId: "u1", jobId: "job_nothing" })).toBeNull();
    expect(await resolveJobConversation(d, { userId: "u2", jobId: "job_other" })).toEqual({ conversationId: "conv_u2", via: "mission" });
  });

  it("the link opens that conversation with the job; the page maps missions to conversations itself and asks the server for any request it could not link", () => {
    expect(openJobHref({ jobId: "job_agent", conversationId: "conv_agent" })).toBe("/dashboard/chat?jobId=job_agent&c=conv_agent");
    const page = readFileSync("src/app/dashboard/requests/page.tsx", "utf8");
    expect(page).toContain('.from("missions")');
    expect(page).toContain("agentMissionId");
    expect(page).toContain("/conversation");
    // the open handler waits for the answer before navigating
    expect(page).toMatch(/const openFile = async/);
    expect(page.indexOf("/conversation")).toBeLessThan(page.indexOf("router.push(openJobHref({ jobId: job.$id, conversationId, retry }))"));
    const route = readFileSync("src/app/api/jobs/[id]/conversation/route.ts", "utf8");
    expect(route).toContain("resolveJobConversation");
    expect(route).toContain("user.id");
  });
});
