import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PHASE 4: progress UX and e-mail.
 *  - one remaining-time figure (the chat's, from the real chunk times), one in-progress sign, no sentence twice, a live preview with counts;
 *  - the e-mail wiring: the function's own templates carry the honest wording, a failure released inside the failure record is e-mailed,
 *    refund e-mails carry customer words only, and the admin can see why an e-mail did not go out and send a test to their OWN address.
 * Fake providers and fake clients only: nothing here sends a real e-mail or reads a secret.
 */
const state = vi.hoisted(() => ({
  user: null as any,
  admin: null as any,
  adminOk: true,
  sent: [] as any[],
  sendResult: { ok: true } as any,
}));

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })) } })),
  createAdminClient: vi.fn(() => state.admin),
}));
vi.mock("../src/lib/server/userAuth", () => ({
  authenticateUser: vi.fn(async () => state.user
    ? { ok: true, user: state.user }
    : { ok: false, response: NextResponse.json({ success: false }, { status: 401 }) }),
}));
vi.mock("../src/lib/server/adminAuth", () => ({
  authenticateAdmin: vi.fn(async () => state.adminOk
    ? { ok: true, ctx: { adminId: "admin-1", adminEmail: "owner@example.test", adminName: "المدير", users: { get: vi.fn(async () => ({ email: "customer@example.test", name: "عميل" })) } } }
    : { ok: false, response: NextResponse.json({ success: false, error: "غير مصرح" }, { status: 403 }) }),
}));
vi.mock("../src/lib/server/sendPlatformEmail", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/server/sendPlatformEmail")>();
  return { ...original, sendPlatformEmail: vi.fn(async (template: string, to: string, vars: any, key?: string) => { state.sent.push({ template, to, vars, key }); return state.sendResult; }) };
});

import ActivityTerminal from "../src/app/dashboard/chat/components/ActivityTerminal";
import { buildLivePreviewSample, liveEventsForDisplay, PREVIEW_MAX_COLUMNS, PREVIEW_MAX_ROWS, stripWorkerEta } from "../src/lib/liveJobView";
import { summarizeActivityCounts } from "../src/lib/activityCounts";
import { completionNoticeFull, releasedNoticeFull, sendJobNotice, startedNoticeFull } from "../src/lib/server/jobNotices";
import { buildTestEmail, emailConfigStatus, probeSendEmailFunction, SEND_FAILURE_LABEL_AR, FUNCTION_PROBE_LABEL_AR, TEST_EMAIL_KINDS } from "../src/lib/server/emailCheck";
import { customerEmailJobTitle } from "../src/lib/customerFacingRequestLabels";
import { renderEmailTemplate } from "../supabase/functions/send-email/templates";
import { GET as previewGet } from "../src/app/api/jobs/[id]/preview/route";
import { GET as emailCheckGet, POST as emailCheckPost } from "../src/app/api/admin/email-check/route";
import { POST as testEmailPost } from "../src/app/api/admin/test-email/route";

const PAGE_LINE = "الصفحة ١: استلمنا ٥٠ سجل · الجديد ٣ · الإجمالي ٣ · مكرر أو مستبعد ٧ · قيد المراجعة ٤٠ · الوقت المتوقع بحسب زمن الصفحات المسجل: نحو ٣١ ثانية";
const PAGE_LINE_NO_ETA = "الصفحة ١: استلمنا ٥٠ سجل · الجديد ٣ · الإجمالي ٣ · مكرر أو مستبعد ٧ · قيد المراجعة ٤٠";
const PROVIDER_WORDS = /treg|icypeas|firecrawl|context\.dev|tikhub|apify|openai|anthropic|resend|supabase|usd|\$|endpoint/i;

const textOf = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const events = [
  { $id: "1", kind: "progress", textAr: "تم اعتماد الخطة وحجز النقاط بنجاح. جاري بدء معالجة الطلب...", createdAt: "2026-10-23T09:24:43Z" },
  { $id: "2", kind: "progress", textAr: PAGE_LINE, count: 3, createdAt: "2026-10-23T09:25:10Z" },
] as any[];
const render = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(ActivityTerminal as any, { events, rowsCollected: 3, requestedRows: 50, reservedPoints: 183, ...props }));

beforeEach(() => {
  state.user = null;
  state.admin = null;
  state.adminOk = true;
  state.sent.length = 0;
  state.sendResult = { ok: true };
});

describe("ONE remaining-time figure", () => {
  it("the worker's own estimate inside a page line is not shown; the rest of the line is untouched", () => {
    expect(stripWorkerEta(PAGE_LINE)).toBe(PAGE_LINE_NO_ETA);
    expect(stripWorkerEta(PAGE_LINE_NO_ETA)).toBe(PAGE_LINE_NO_ETA);
    expect(stripWorkerEta("الصفحة ٢: استلمنا ١٠ سجل · الوقت المتوقع بحسب زمن الصفحات المسجل: نحو ٢ دقيقة · مكرر أو مستبعد ٣")).toBe("الصفحة ٢: استلمنا ١٠ سجل · مكرر أو مستبعد ٣");
  });

  it("the counts the panel reads are the same with or without that segment", () => {
    expect(summarizeActivityCounts([{ textAr: stripWorkerEta(PAGE_LINE) }])).toEqual(summarizeActivityCounts([{ textAr: PAGE_LINE }]));
  });

  it("the panel shows no «الوقت المتوقع» line, for a running and for a finished request", () => {
    for (const status of ["running", "queued", "done", "failed"]) {
      const html = render({ status });
      expect(textOf(html)).not.toContain("الوقت المتوقع");
      expect(textOf(html)).not.toContain("نحو ٣١ ثانية");
      expect(textOf(html)).toContain("الصفحة ١: استلمنا ٥٠ سجل");
    }
  });

  it("the chat keeps the single figure: one computeJobProgress call and no other estimator in the customer screens", () => {
    const chat = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(chat.match(/computeJobProgress\(/g)).toHaveLength(1);
    for (const file of ["src/app/dashboard/chat/page.tsx", "src/app/dashboard/chat/components/ActivityTerminal.tsx", "src/app/dashboard/chat/components/ResultsCanvas.tsx"]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toContain("estimateRemainingSecondsFromBatchDurations");
      expect(source, file).not.toContain("estimateRemainingSecondsFromMeasuredPages");
      expect(source, file).not.toContain("estimateRemainingSecondsFromBatches");
    }
  });
});

describe("no line twice, one in-progress sign", () => {
  it("a line identical to the one before it is shown once; different lines stay", () => {
    const shown = liveEventsForDisplay([
      { textAr: "جاري تجهيز الملفات..." },
      { textAr: "جاري  تجهيز الملفات..." },
      { textAr: PAGE_LINE },
      { textAr: "جاري تجهيز الملفات..." },
    ]);
    expect(shown.map((e) => e.textAr)).toEqual(["جاري تجهيز الملفات...", PAGE_LINE_NO_ETA, "جاري تجهيز الملفات..."]);
  });

  it("the panel has exactly one in-progress sign while the job runs, and none when it ends", () => {
    expect(render({ status: "running" }).match(/data-testid="running-indicator"/g)).toHaveLength(1);
    expect(render({ status: "done" })).not.toContain("running-indicator");
  });

  it("the chat shows its own sign only while the panel is closed, and the close-the-page sentence only when the approval message is not on screen", () => {
    const chat = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    const status = chat.slice(chat.indexOf('data-testid="chat-run-status"'), chat.indexOf('data-testid="job-progress"'));
    expect(status).toContain("canvasOpen ? null : <RunningIndicator />");
    expect(chat).toContain("const postApprovalNoticeVisible = messages.some((m) => shouldShowProgressNotice(m, activeJob, terminalJobs))");
    expect(chat).toContain("{jobIsLive && !postApprovalNoticeVisible && (");
    // the wording promised nothing new: still the honest sentence for each driver
    expect(chat).toContain("closePageLineAr(driverMode)");
  });
});

describe("live preview of what is being collected", () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ id: `row_${i}`, company_name: `شركة ${i}`, industry: "اتصالات", website: `https://example${i}.test`, location: "القاهرة", description: "وصف", source_id: `s${i}` }));

  it("at most five rows and four columns, in the customer's own columns, never ids", () => {
    const sample = buildLivePreviewSample(rows, ["id", "source_id", "company_name", "industry", "website", "location", "description"], true)!;
    expect(sample.rows).toHaveLength(PREVIEW_MAX_ROWS);
    expect(sample.columns).toHaveLength(PREVIEW_MAX_COLUMNS);
    expect(sample.columns.map((c) => c.key)).toEqual(["company_name", "industry", "website", "location"]);
    expect(sample.columns.map((c) => c.titleAr)).toEqual(["اسم الشركة أو المؤسسة", "النشاط أو التخصص", "الموقع الإلكتروني", "الموقع الجغرافي"]);
    expect(sample.rows[4][0]).toBe("شركة 7");
  });

  it("nothing to show means null (the screen shows the counts only)", () => {
    expect(buildLivePreviewSample([], ["company_name"], true)).toBeNull();
    expect(buildLivePreviewSample([{ company_name: "" }], ["company_name"], true)).toBeNull();
  });

  it("a running panel shows the rows when it has them, and only the counts with a waiting line when it has not", () => {
    const sample = buildLivePreviewSample(rows, ["company_name", "industry"], true);
    const withRows = render({ status: "running", preview: sample });
    expect(withRows).toContain('data-testid="live-preview-table"');
    expect(textOf(withRows)).toContain("شركة 7");
    expect(textOf(withRows)).toContain("المقبول حتى الآن ٣ من ٥٠");
    const counts = render({ status: "running", preview: null });
    expect(counts).toContain('data-testid="live-preview-waiting"');
    expect(counts).not.toContain("live-preview-table");
    expect(textOf(counts)).toContain("استلمنا ٥٠");
    expect(textOf(counts)).toContain("قيد المراجعة ٤٠");
    expect(textOf(counts)).not.toMatch(/[A-Za-z0-9]/);
  });

  it("a finished request has no live preview (its rows come from the results)", () => {
    for (const status of ["done", "failed", "cancelled"]) expect(render({ status })).not.toContain("live-preview");
  });

  describe("the preview route", () => {
    const makeAdmin = (job: any, files: Record<string, any>) => ({
      from: () => {
        const b: any = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: job, error: null }) };
        return b;
      },
      storage: {
        from: () => ({
          download: async (path: string) => files[path] ? { data: new Blob([JSON.stringify(files[path])]), error: null } : { data: null, error: { message: "missing" } },
        }),
      },
    });
    const call = async (id = "job_1") => {
      const res = await previewGet(new NextRequest(`http://localhost/api/jobs/${id}/preview`), { params: Promise.resolve({ id }) });
      return { status: res.status, json: await res.json() };
    };
    const runningJob = { id: "job_1", user_id: "u1", status: "running", step: 2, template_slug: "treg.companies.b2b", endpoint_id: "treg.companies.b2b", platform: null, capability_slug: null, delivered_units: 4 };

    it("the owner of a running job gets the accepted rows of the newest pages; the review rows are never shown", async () => {
      state.user = { id: "u1", email: "u1@example.test", appRole: null };
      state.admin = makeAdmin(runningJob, {
        "job_1/step_1.json": { rows: rows.slice(2, 5), uncertainRows: [{ company_name: "تحت المراجعة" }] },
        "job_1/step_0.json": { rows: rows.slice(0, 2) },
      });
      const { status, json } = await call();
      expect(status).toBe(200);
      expect(json.sample.rows.map((r: string[]) => r[0])).toEqual(["شركة 0", "شركة 1", "شركة 2", "شركة 3", "شركة 4"]);
      expect(JSON.stringify(json)).not.toContain("تحت المراجعة");
      expect(JSON.stringify(json)).not.toMatch(PROVIDER_WORDS);
    });

    it("another customer is refused, a signed-out caller too", async () => {
      state.admin = makeAdmin(runningJob, { "job_1/step_1.json": { rows } });
      state.user = { id: "someone-else", email: "x@example.test", appRole: null };
      expect((await call()).status).toBe(403);
      state.user = null;
      expect((await call()).status).toBe(401);
    });

    it("no page saved yet, or a finished request: counts only (sample null)", async () => {
      state.user = { id: "u1", email: "u1@example.test", appRole: null };
      state.admin = makeAdmin({ ...runningJob, step: 0 }, {});
      expect((await call()).json.sample).toBeNull();
      state.admin = makeAdmin({ ...runningJob, status: "done" }, { "job_1/step_1.json": { rows } });
      expect((await call()).json.sample).toBeNull();
      state.admin = makeAdmin(runningJob, {});
      expect((await call()).json.sample).toBeNull();
    });
  });
});

describe("e-mail: what the customer is sent", () => {
  it("the e-mail function's OWN templates carry the honest wording (the shared copy was the only one renamed before)", () => {
    const source = readFileSync("supabase/functions/send-email/templates.ts", "utf8");
    expect(source).not.toMatch(/رجعت|>استرداد</);
    const refund = renderEmailTemplate("refund", { Name: "أحمد", Points: "٢٠", JobTitle: "بحث تيك توك", Reason: "سبب", Balance: "٣٠٠" });
    expect(refund.subject).toBe("حُرّر حجز مؤقت بقيمة ٢٠ نقطة");
    expect(refund.html).toContain("حجز مؤقت مُحرَّر");
    expect(refund.html).not.toContain("{{");
  });

  it("a request released inside the failure record is e-mailed once (same notice id, idempotent e-mail key)", async () => {
    expect(releasedNoticeFull(590).email).toBeNull();
    const withEmail = releasedNoticeFull(590, { withEmail: true });
    expect(withEmail.email).toMatchObject({ subject: "تعذّر تنفيذ طلبك وأعدنا نقاطك", buttonLabel: "افتح طلباتي" });
    expect(withEmail.email!.detail1).toContain("أعدنا ٥٩٠ نقطة محجوزة كاملة إلى رصيدك دون أي خصم");
    expect(JSON.stringify(withEmail)).not.toMatch(PROVIDER_WORDS);
    const worker = readFileSync("src/app/api/worker/chunk/route.ts", "utf8");
    expect(worker).toContain("releasedNoticeFull(Number(lastFailureData?.released_credits) || 0, { withEmail: true })");
  });

  it("the refund e-mail of a release carries customer words only: no endpoint id, no raw upstream message", () => {
    const worker = readFileSync("src/app/api/worker/chunk/route.ts", "utf8");
    expect(worker).not.toContain("نتائج استخراج ${endpointId}");
    expect(worker).toContain("JobTitle: customerEmailJobTitle(endpointId),");
    expect(worker).toContain("Reason: sanitizeActivityError(reason),");
    expect(customerEmailJobTitle("treg.tiktok.comments")).toBe("بحث تيك توك");
    expect(customerEmailJobTitle("some.unknown.thing")).toBe("بحثك");
    expect(customerEmailJobTitle(null)).toBe("بحثك");
    for (const slug of ["treg.companies.b2b", "treg.people.decision", "x-search"]) expect(customerEmailJobTitle(slug)).not.toMatch(/[A-Za-z]/);
  });

  it("a notice with an e-mail goes through the same sender and key as before", async () => {
    const sent: any[] = [];
    const admin: any = {
      auth: { admin: { getUserById: async () => ({ data: { user: { email: "c@example.test", user_metadata: { full_name: "عميل" } } }, error: null }) } },
      from: () => {
        const b: any = { select: () => b, eq: () => b, like: () => b, insert: async () => ({ error: null }), then: (r: any) => r({ count: 0, data: [], error: null }) };
        return b;
      },
    };
    const { sendPlatformEmail } = await import("../src/lib/server/sendPlatformEmail");
    expect(await sendJobNotice(admin, "u1", "job_9", releasedNoticeFull(100, { withEmail: true }))).toEqual({ inApp: true, email: true });
    expect(vi.mocked(sendPlatformEmail)).toHaveBeenCalledWith("job-update", "c@example.test", expect.objectContaining({ Heading: "تعذّر تنفيذ طلبك وأعدنا نقاطك" }), "job-update:released:job_9");
    void sent;
  });
});

describe("e-mail: admin diagnosis and a test to the admin's own address", () => {
  it("config is booleans only, never a value", () => {
    expect(emailConfigStatus({ NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "super-secret" })).toEqual({ supabaseUrl: true, serviceRoleKey: true });
    expect(emailConfigStatus({})).toEqual({ supabaseUrl: false, serviceRoleKey: false });
  });

  it("the probe tells apart: not published, key refused, old version, ready, unreachable; and it never sends", async () => {
    const env = { NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" };
    const answer = (status: number, body: any) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    expect(await probeSendEmailFunction(env, answer(404, { code: "NOT_FOUND" }))).toBe("not_deployed");
    expect(await probeSendEmailFunction(env, answer(401, { ok: false, error: "unauthorized" }))).toBe("key_rejected");
    expect(await probeSendEmailFunction(env, answer(400, { ok: false, error: "invalid_template" }))).toBe("template_missing");
    expect(await probeSendEmailFunction(env, answer(400, { ok: false, error: "invalid_to" }))).toBe("ready");
    expect(await probeSendEmailFunction(env, answer(500, { error: "resend_not_configured" }))).toBe("unknown");
    expect(await probeSendEmailFunction(env, vi.fn(async () => { throw new Error("down"); }) as unknown as typeof fetch)).toBe("unreachable");
    expect(await probeSendEmailFunction({}, answer(400, {}))).toBe("unknown");
    // the question it asks stops at the recipient check: a known template and a recipient that is not an address
    const fetcher = answer(400, { error: "invalid_to" });
    await probeSendEmailFunction(env, fetcher);
    const sentBody = JSON.parse((vi.mocked(fetcher).mock.calls[0][1] as any).body);
    expect(sentBody).toEqual({ template: "job-update", to: "probe-no-send", vars: {} });
    expect(sentBody.to).not.toContain("@");
  });

  it("every test e-mail renders from the real builders: Arabic, no token left, no provider word", () => {
    for (const kind of TEST_EMAIL_KINDS) {
      const email = buildTestEmail(kind, "المدير", "https://diger.tech");
      const { subject, html } = renderEmailTemplate(email.template as any, email.vars);
      expect(subject, kind).not.toContain("{{");
      expect(html, kind).not.toContain("{{");
      expect(subject, kind).not.toMatch(/[A-Za-z]/);
      expect(`${subject} ${JSON.stringify(email.vars)}`.replace(/https:\/\/diger\.tech[^"]*/g, ""), kind).not.toMatch(PROVIDER_WORDS);
    }
    expect(buildTestEmail("completion", "م", "https://diger.tech").template).toBe("job-done");
    expect(buildTestEmail("partial", "م", "https://diger.tech").vars.Heading).toBe(completionNoticeFull({ delivered: 40, requested: 100, chargedPoints: 360, refundedPoints: 140 }).email!.heading);
    expect(buildTestEmail("started", "م", "https://diger.tech").vars.Lead).toBe(startedNoticeFull({ targetVolumeMax: 5000, driver: "tab" }).email!.lead);
  });

  it("every failure reason and every probe verdict has an Arabic explanation", () => {
    for (const reason of ["invalid_recipient", "missing_config", "unauthorized", "invalid_request", "resend_not_configured", "resend_unreachable", "resend_rejected", "function_unavailable", "timeout", "network_error"] as const) {
      expect(SEND_FAILURE_LABEL_AR[reason]).toMatch(/[ء-ي]/);
    }
    for (const verdict of Object.values(FUNCTION_PROBE_LABEL_AR)) expect(verdict).toMatch(/[ء-ي]/);
    expect(SEND_FAILURE_LABEL_AR.resend_not_configured).toContain("Supabase");
  });

  it("the route refuses a non-admin; for an admin the diagnosis carries no secret", async () => {
    state.adminOk = false;
    expect((await emailCheckGet(new NextRequest("http://localhost/api/admin/email-check"))).status).toBe(403);
    expect((await emailCheckPost(new NextRequest("http://localhost/api/admin/email-check", { method: "POST", body: JSON.stringify({ kind: "completion" }) }))).status).toBe(403);
    expect(state.sent).toHaveLength(0);

    state.adminOk = true;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://probe.invalid";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "secret-value-123";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: "NOT_FOUND" }), { status: 404 })));
    try {
      const res = await emailCheckGet(new NextRequest("http://localhost/api/admin/email-check"));
      const text = JSON.stringify(await res.json());
      expect(text).toContain("not_deployed");
      expect(text).not.toContain("secret-value-123");
      expect(text).not.toContain("probe.invalid");
    } finally {
      vi.unstubAllGlobals();
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    }
  });

  it("a test e-mail goes ONLY to the signed-in admin's own address, whatever the body says, and the result is the real one", async () => {
    const post = (body: any) => emailCheckPost(new NextRequest("http://localhost/api/admin/email-check", { method: "POST", body: JSON.stringify(body) }));
    const ok = await (await post({ kind: "partial", to: "victim@example.test", userId: "someone" })).json();
    expect(ok.success).toBe(true);
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]).toMatchObject({ template: "job-update", to: "owner@example.test" });
    expect(state.sent[0].key).toMatch(/^admin-test:admin-1:/);
    expect(JSON.stringify(state.sent[0])).not.toContain("victim@example.test");

    state.sendResult = { ok: false, reason: "function_unavailable" };
    const failed = await (await post({ kind: "completion" })).json();
    expect(failed).toMatchObject({ success: false, reason: "function_unavailable", template: "job-done" });
    expect(failed.reasonAr).toBe(SEND_FAILURE_LABEL_AR.function_unavailable);
    expect((await post({ kind: "other" })).status).toBe(400);
  });

  it("the older test route no longer reports success for an e-mail that did not go out", async () => {
    state.sendResult = { ok: false, reason: "resend_not_configured" };
    const res = await testEmailPost(new NextRequest("http://localhost/api/admin/test-email", { method: "POST", body: JSON.stringify({ template: "job-done", userId: "u1" }) }));
    expect(await res.json()).toMatchObject({ success: false, reason: "resend_not_configured" });
    state.sendResult = { ok: true };
    const okRes = await testEmailPost(new NextRequest("http://localhost/api/admin/test-email", { method: "POST", body: JSON.stringify({ template: "job-done", userId: "u1" }) }));
    expect(await okRes.json()).toMatchObject({ success: true });
  });

  it("the admin module and card are not imported by any customer file", () => {
    const customerFiles = ["src/app/dashboard/chat/page.tsx", "src/app/dashboard/requests/page.tsx", "src/app/api/chat/accept-quote/route.ts", "src/app/api/worker/chunk/route.ts"];
    for (const file of customerFiles) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toContain("emailCheck");
      expect(source, file).not.toContain("EmailCheckCard");
    }
    expect(readFileSync("src/app/admin/settings/page.tsx", "utf8")).toContain("<EmailCheckCard />");
  });
});
