import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import FileWorkflow, { FileWorkflowBody } from "../src/components/mission/FileWorkflow";
import { FILE_WORKFLOW_ERRORS_AR, FILE_WORKFLOW_HEADING_AR, FILE_WORKFLOW_NONE_AR, FILE_WORKFLOW_RETRY_AR, workflowItemLinesAr, workflowItemTitleAr, workflowPhaseLabelAr, type AddonPhase, type WorkflowItemView } from "../src/lib/agentMission/stage4/fileWorkflowLabels";
import { fetchFileWorkflow, fileWorkflowUrl } from "../src/lib/agentMission/stage4/fileWorkflowClient";
import { checkCustomerLabel, checkCustomerText } from "../src/lib/agentMission/text";

/**
 * STAGE C: ONE UNDERSTANDABLE FILE PAGE. The status card says, for every request on the file, which of these it is: waiting for approval, approval being checked, approved and processing, delivered, charged but delivery pending, failed without a recorded charge, cancelled, or closed after
 * an approval attempt. It never says «nothing was reserved» for a request whose approval may have moved money, never shows a payment line without a recorded charge, and never says «delivered» before the output is verified published. Arabic only, points never provider costs, mobile first.
 */
const MISSION = "msn_5851abc92a1e6645a9cd";
const PHASES: AddonPhase[] = ["waiting_approval", "approval_unverified", "processing", "delivered", "charged_delivery_pending", "failed_no_charge", "cancelled", "ended_unverified", "delivery_pending"];
const item = (over: Partial<WorkflowItemView> = {}): WorkflowItemView => ({ kind: "edit", version: 2, newVersion: 3, phase: "waiting_approval", ...over });
const render = (props: Partial<Parameters<typeof FileWorkflowBody>[0]> = {}) => renderToStaticMarkup(createElement(FileWorkflowBody, { status: "ready", view: { items: [item()] }, ...props }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("the words of every phase", () => {
  it("the labels, exactly", () => {
    expect(Object.fromEntries(PHASES.map((p) => [p, workflowPhaseLabelAr(p)]))).toEqual({
      waiting_approval: "بانتظار اعتمادك",
      approval_unverified: "نتحقق من حالة الاعتماد",
      processing: "اعتُمد الطلب ويجري تنفيذه",
      delivered: "اكتمل وسُلِّم",
      charged_delivery_pending: "خُصم الطلب والتسليم لم يكتمل",
      failed_no_charge: "لم يكتمل الطلب",
      cancelled: "أُلغي الطلب",
      ended_unverified: "أُغلق الطلب",
      delivery_pending: "اكتمل التنفيذ ولم يُؤكَّد النشر",
    });
  });
  it("titles: the kind and the version", () => {
    expect(workflowItemTitleAr(item({ kind: "review", version: 1, newVersion: null }))).toBe("مراجعة الملف — النسخة ١");
    expect(workflowItemTitleAr(item({ kind: "edit", version: 2 }))).toBe("تعديل الملف — النسخة ٢");
    expect(workflowItemTitleAr(item({ kind: "review_fix", version: 12 }))).toBe("تصحيح بعد المراجعة — النسخة ١٢");
  });
  it("waiting: nothing held or charged, and nothing starts before approval", () => {
    expect(workflowItemLinesAr(item())).toEqual(["الطلب جاهز ولم يُحجز أو يُخصم شيء.", "لن يبدأ التنفيذ قبل أن تعتمد."]);
  });
  it("approval unverified: never «nothing was held», never a confirmation", () => {
    const lines = workflowItemLinesAr(item({ phase: "approval_unverified" }));
    expect(lines).toEqual(["بدأت محاولة لاعتماد هذا الطلب ولم تكتمل. قد تكون نقاطك قد حُجزت مؤقتًا، ونتحقق من ذلك الآن.", "لن نعرض لك تأكيدًا قبل أن نتأكد."]);
    expect(lines.join(" ")).not.toMatch(/لم يُحجز|لم يُخصم|لم تُحجز/);
  });
  it("processing: the hold is stated only when the job is known; the output is not shown as published", () => {
    expect(workflowItemLinesAr(item({ phase: "processing", held: true }))).toEqual(["حُجزت نقاط الطلب مؤقتًا، ولن يُخصم إلا ما يُنجز.", "لم يُنشر الناتج بعد، وسيظهر هنا عند اكتماله."]);
    expect(workflowItemLinesAr(item({ phase: "processing", held: false }))).toEqual(["قد تكون نقاط الطلب حُجزت مؤقتًا، ولن يُخصم إلا ما يُنجز.", "لم يُنشر الناتج بعد، وسيظهر هنا عند اكتماله."]);
    for (const held of [true, false]) expect(workflowItemLinesAr(item({ phase: "processing", held })).join(" ")).not.toMatch(/لم يُحجز|لم يُخصم|اكتمل وسُلّم|جاهز للتنزيل/);
  });
  it("delivered: the output is where to find it; a charge line only with a recorded charge", () => {
    expect(workflowItemLinesAr(item({ kind: "review", version: 1, newVersion: null, phase: "delivered", chargedPoints: 100 }))).toEqual(["نتيجة المراجعة منشورة، وتجدها في قسم «نتيجة مراجعة الملف».", "سُجّل خصم ١٠٠ نقطة لهذا الطلب."]);
    expect(workflowItemLinesAr(item({ kind: "edit", version: 2, newVersion: 3, phase: "delivered", chargedPoints: 172 }))).toEqual(["النسخة ٣ منشورة وجاهزة للتنزيل من قائمة نسخ الملف.", "سُجّل خصم ١٧٢ نقطة لهذا الطلب."]);
    expect(workflowItemLinesAr(item({ phase: "delivered" }))).toEqual(["النسخة ٣ منشورة وجاهزة للتنزيل من قائمة نسخ الملف."]);
    expect(workflowItemLinesAr(item({ phase: "delivered", chargedPoints: 1 }))[1]).toBe("سُجّل خصم نقطة واحدة لهذا الطلب.");
  });
  it("charged but not delivered: the charge, that the output is not published, and that it is not complete", () => {
    expect(workflowItemLinesAr(item({ phase: "charged_delivery_pending", chargedPoints: 100 }))).toEqual(["سُجّل خصم ١٠٠ نقطة لهذا الطلب.", "لكن الناتج لم يُنشر بعد. نحاول إكماله، وسيراجع فريقنا الطلب إن لم يكتمل.", "لا تعتبر الطلب مكتملًا حتى يظهر ناتجه هنا."]);
    expect(workflowItemLinesAr(item({ phase: "charged_delivery_pending" }))[0]).toBe("سُجّل أن هذا الطلب خُصم.");
  });
  it("failed: only what is known (no recorded charge); cancelled: nothing held; closed after an attempt: unverified; completed with no output: not shown as complete", () => {
    expect(workflowItemLinesAr(item({ phase: "failed_no_charge" }))).toEqual(["لم يُسجَّل أي خصم لهذا الطلب.", "يمكنك تقديم طلب جديد."]);
    expect(workflowItemLinesAr(item({ phase: "cancelled" }))).toEqual(["أُلغي الطلب قبل اعتماده. لم يُحجز أو يُخصم شيء."]);
    expect(workflowItemLinesAr(item({ phase: "ended_unverified" }))).toEqual(["أُغلق هذا الطلب بعد محاولة اعتماد. نتحقق من حالة نقاطك، ولن نؤكد شيئًا قبل أن نتأكد."]);
    expect(workflowItemLinesAr(item({ phase: "delivery_pending" }))).toEqual(["لم نجد الناتج منشورًا بعد، ولن نعرضه لك كمكتمل حتى يُنشر."]);
  });
  it("«nothing held» is said ONLY for the two phases where nothing can have been held; success only for «delivered»", () => {
    for (const p of PHASES) {
      const all = [workflowPhaseLabelAr(p), ...workflowItemLinesAr(item({ phase: p, chargedPoints: p === "delivered" || p === "charged_delivery_pending" ? 100 : undefined, held: p === "processing" ? true : undefined }))].join(" ");
      const saysNothingHeld = /لم يُحجز أو يُخصم شيء/.test(all);
      expect([p, saysNothingHeld]).toEqual([p, p === "waiting_approval" || p === "cancelled"]);
      expect([p, /اكتمل وسُلِّم|منشورة وجاهزة|نتيجة المراجعة منشورة/.test(all)]).toEqual([p, p === "delivered"]);
      if (p !== "delivered" && p !== "charged_delivery_pending") expect([p, /سُجّل خصم/.test(all)]).toEqual([p, false]);
    }
  });
  it("every sentence passes the customer-text rules: Arabic only, Arabic-Indic numerals, points not provider costs, no emoji, no spreadsheet word", () => {
    const all: string[] = [FILE_WORKFLOW_HEADING_AR, FILE_WORKFLOW_NONE_AR, FILE_WORKFLOW_RETRY_AR, ...Object.values(FILE_WORKFLOW_ERRORS_AR)];
    for (const kind of ["review", "review_fix", "edit"] as const) for (const phase of PHASES) for (const version of [1, 2, 12]) for (const chargedPoints of [undefined, 1, 2, 100, 5000]) for (const held of [true, false]) {
      const it = item({ kind, phase, version, newVersion: kind === "review" ? null : version + 1, ...(chargedPoints && (phase === "delivered" || phase === "charged_delivery_pending") ? { chargedPoints } : {}), ...(phase === "processing" ? { held } : {}) });
      all.push(workflowItemTitleAr(it), workflowPhaseLabelAr(phase), ...workflowItemLinesAr(it));
    }
    for (const s of all) {
      expect(checkCustomerText(s).issues, s).toEqual([]);
      expect(s, s).not.toMatch(/[0-9]/); expect(s, s).not.toMatch(/\p{Extended_Pictographic}/u); expect(s, s).not.toMatch(/USD|\$|openai|anthropic|claude|supabase|plan_ready|job_|msn_/i);
    }
    for (const s of [FILE_WORKFLOW_HEADING_AR, FILE_WORKFLOW_RETRY_AR, ...PHASES.map(workflowPhaseLabelAr)]) expect(checkCustomerLabel(s).issues, s).toEqual([]);
  });
});

describe("the card on the page", () => {
  it("a labelled region with the heading and one list item per request: title, status label, details", () => {
    const html = render({ view: { items: [item(), item({ kind: "review", version: 1, newVersion: null, phase: "delivered", chargedPoints: 100 })] } });
    expect(html).toMatch(/<section[^>]*aria-labelledby="file-workflow-heading"/);
    expect(html).toMatch(/<h2[^>]*id="file-workflow-heading"[^>]*>حالة طلباتك على هذا الملف<\/h2>/);
    expect(html.match(/<li[ >]/g)).toHaveLength(2);
    const t = text(html);
    for (const s of ["تعديل الملف — النسخة ٢", "بانتظار اعتمادك", "الطلب جاهز ولم يُحجز أو يُخصم شيء.", "مراجعة الملف — النسخة ١", "اكتمل وسُلِّم", "سُجّل خصم ١٠٠ نقطة لهذا الطلب."]) expect(t).toContain(s);
    expect(html).toContain('data-phase="waiting_approval"'); expect(html).toContain('data-phase="delivered"');
  });
  it("no request yet: the plain sentence about what can be asked and that nothing moves before approval", () => {
    const t = text(render({ view: { items: [] } }));
    expect(t).toContain(FILE_WORKFLOW_NONE_AR);
    expect(FILE_WORKFLOW_NONE_AR).toBe("لم تطلب مراجعة أو تعديلًا على هذا الملف بعد. تظهر لك التكلفة قبل أي خطوة، ولا يُخصم شيء قبل أن تعتمد.");
    expect(render({ view: { items: [] } })).not.toContain("<ul");
  });
  it("loading is a live status; an error is an alert with a real retry button; neither shows a request", () => {
    const loading = render({ status: "loading", view: null });
    expect(loading).toMatch(/role="status"/); expect(loading).toMatch(/aria-busy="true"/); expect(loading).not.toContain("<li");
    const failed = render({ status: "error", view: null, error: FILE_WORKFLOW_ERRORS_AR.unavailable, onRetry: () => {} });
    expect(failed).toMatch(/role="alert"/); expect(failed).toMatch(/<button[^>]*type="button"[^>]*>إعادة المحاولة<\/button>/);
    expect(failed).not.toContain("<li");
    expect(render({ status: "error", view: null, error: "x" })).not.toContain("<button");
  });
  it("mobile first: one column, wrapping text, touch-sized retry, no fixed pixel width", () => {
    const html = render({ view: { items: [item({ phase: "processing", held: true })] } });
    expect(html).toMatch(/\bbreak-words\b/);
    expect(html).not.toMatch(/\bw-\[\d{3,}px\]|\bmin-w-\[\d{3,}px\]|\bgrid-cols-[2-9]\b(?![^"]*\b(?:sm|md|lg):)/);
    expect(render({ status: "error", view: null, error: "x", onRetry: () => {} })).toMatch(/<button[^>]*class="[^"]*\bmin-h-11\b[^"]*\bw-full\b[^"]*\bsm:w-auto\b/);
  });
  it("a request that is processing is announced politely, so the change to «delivered» is read out; the digits are Arabic-Indic", () => {
    const html = render({ view: { items: [item({ phase: "processing", held: true })] } });
    expect(html).toMatch(/aria-live="polite"/);
    expect(text(html)).not.toMatch(/[0-9]/);
  });
  it("it draws NOTHING when the feature is off and before the first read", () => {
    expect(render({ status: "idle", view: null })).toBe("");
    expect(renderToStaticMarkup(createElement(FileWorkflow, { missionId: MISSION }))).toBe("");
  });
  it("it has no approval, payment or price control", () => {
    const html = render({ view: { items: PHASES.map((phase) => item({ phase })) } });
    expect(html).not.toContain("<button"); expect(html).not.toContain("<input"); expect(html).not.toContain("<select");
    expect(text(html)).not.toMatch(/اعتمد الآن|ادفع|اشتر/);
  });
});

describe("the browser's side: it reads, validates and shows nothing it cannot verify", () => {
  const headers = async () => ({ Authorization: "Bearer t" });
  const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body } as unknown as Response);
  const wire = (items: unknown[]) => ({ success: true, workflow: { items } });
  it("url; GET only, no body, no cache", async () => {
    expect(fileWorkflowUrl(MISSION)).toBe(`/api/missions/${MISSION}/workflow`);
    expect(fileWorkflowUrl("a/b")).toBe("/api/missions/a%2Fb/workflow");
    const f = vi.fn(async () => ok(wire([item()])));
    expect(await fetchFileWorkflow({ missionId: MISSION, fetchFn: f as any, headers })).toEqual({ state: "ok", view: { items: [item()] } });
    expect(f).toHaveBeenCalledWith(fileWorkflowUrl(MISSION), { cache: "no-store", headers: { Authorization: "Bearer t" } });
  });
  it("404 and 401 mean the feature is off or nothing is theirs (hidden); 5xx and a lost connection are retryable errors", async () => {
    expect(await fetchFileWorkflow({ missionId: MISSION, fetchFn: (async () => ok({}, 404)) as any, headers })).toEqual({ state: "off" });
    expect(await fetchFileWorkflow({ missionId: MISSION, fetchFn: (async () => ok({}, 401)) as any, headers })).toEqual({ state: "off" });
    expect(await fetchFileWorkflow({ missionId: MISSION, fetchFn: (async () => ok({}, 503)) as any, headers })).toEqual({ state: "error", message: FILE_WORKFLOW_ERRORS_AR.unavailable });
    expect(await fetchFileWorkflow({ missionId: MISSION, fetchFn: (async () => { throw new Error("x"); }) as any, headers })).toEqual({ state: "error", message: FILE_WORKFLOW_ERRORS_AR.network });
  });
  it("a request is shown only if it is well-formed; a charge or a hold flag where it does not belong makes the whole answer an error, so a payment line can never be invented", async () => {
    const run = async (items: unknown[]) => fetchFileWorkflow({ missionId: MISSION, fetchFn: (async () => ok(wire(items))) as any, headers });
    const bad: unknown[][] = [
      [{ ...item(), phase: "paid" }], [{ ...item(), kind: "approve" }], [{ ...item(), version: 0 }], [{ ...item(), newVersion: "3" }], [{ ...item(), chargedPoints: 100 }],
      [{ ...item({ phase: "processing" }), chargedPoints: 100 }], [{ ...item({ phase: "delivered" }), chargedPoints: -1 }], [{ ...item({ phase: "delivered" }), chargedPoints: 1.5 }], [{ ...item({ phase: "waiting_approval" }), held: true }], [{ ...item({ phase: "processing" }), held: "yes" }],
      [null], ["x"], [{ ...item({ kind: "review", newVersion: 3 }) }], [{ ...item({ kind: "edit", newVersion: null }) }], [{ ...item({ kind: "edit", version: 2, newVersion: 9 }) }],
    ];
    for (const b of bad) expect(await run(b), JSON.stringify(b)).toEqual({ state: "error", message: FILE_WORKFLOW_ERRORS_AR.unavailable });
    expect(await fetchFileWorkflow({ missionId: MISSION, fetchFn: (async () => ok({ success: true, workflow: { items: "x" } })) as any, headers })).toEqual({ state: "error", message: FILE_WORKFLOW_ERRORS_AR.unavailable });
    expect(await fetchFileWorkflow({ missionId: MISSION, fetchFn: (async () => ok({ success: false })) as any, headers })).toEqual({ state: "error", message: FILE_WORKFLOW_ERRORS_AR.unavailable });
    expect(await run([item({ phase: "processing", held: true }), item({ phase: "delivered", chargedPoints: 100 }), item({ kind: "review", version: 1, newVersion: null, phase: "charged_delivery_pending", chargedPoints: 100 })])).toMatchObject({ state: "ok" });
  });
  it("extra fields the server might add are dropped", async () => {
    const r = await fetchFileWorkflow({ missionId: MISSION, fetchFn: (async () => ok(wire([{ ...item(), id: "msn_0123456789abcdef0123", jobId: "job_quote_x", summaryAr: "x" }]))) as any, headers });
    expect(r).toEqual({ state: "ok", view: { items: [item()] } });
  });
});

describe("the page: one understandable order, and the sources stay client-safe", () => {
  const read = (f: string) => readFileSync(path.join(__dirname, "..", f), "utf8");
  it("the request page draws the file's sections in one order: the mission card, the status, the versions, the review price, the report, the edit", () => {
    const src = read("src/app/dashboard/requests/[id]/page.tsx");
    const order = ["<AgentMissionCard", "<FileWorkflow", "<VersionList", "<ReviewQuote", "<ReviewReport", "<EditRequestCard"].map((s) => src.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // each only for a delivered mission, and the status never replaces the existing sections
    expect(src).toMatch(/<FileWorkflow missionId=\{missionId\} \/>/);
  });
  it("the labels and the client import nothing of the money side, the card, the quotes or the server", () => {
    const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const f of ["src/lib/agentMission/stage4/fileWorkflowLabels.ts", "src/lib/agentMission/stage4/fileWorkflowClient.ts", "src/components/mission/FileWorkflow.tsx"]) {
      const src = code(f);
      expect(src, f).not.toMatch(/from\s+["'][^"']*(?:addonSettlement|addonQuote|quotes|addonRow|reviewPreview"|reviewRequest"|editRequest"|lifecycle|price|missionPricing|gateway|supabase\/server|versionFile|fileWorkflow")/);
      expect(src, f).not.toMatch(/process\.env|DIGER_STAGE4|\.rpc\(|method:\s*"(POST|PUT|PATCH|DELETE)"/);
    }
  });
});
