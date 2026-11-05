import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApproveAddonBody } from "../src/components/mission/ApproveAddon";
import { EditRequestBody } from "../src/components/mission/EditRequestCard";
import { ReviewQuoteBody } from "../src/components/mission/ReviewQuote";
import { ALREADY_APPROVED_AR, APPROVED_AR, APPROVE_CONSENT_AR, APPROVE_NOT_AVAILABLE_AR, APPROVE_SIGNED_OUT_AR, APPROVE_UNKNOWN_AR, addonApprovalUrl, approveButtonAr, fetchApprovalAvailable, sendApproval } from "../src/lib/agentMission/stage4/addonApprovalClient";
import { checkCustomerText } from "../src/lib/agentMission/text";

/**
 * LAUNCH ROUND, WORKSTREAM 2: THE APPROVAL BUTTON and the browser's client. No browser here (static markup and an injected fetch); the same journey runs in a real browser separately (docs/STAGE-4-APPROVAL-ROUTE.md section 6).
 */
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const ID = "msn_request0000000001";
const MISSION = "msn_5851abc92a1e6645a9cd";
const headers = async () => ({ Authorization: "Bearer t" });
const answer = (status: number, body: unknown) => vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;

describe("the client sends the request id and the points the page showed, and nothing else", () => {
  it("the URL is the mission's addon-approval route; the body has exactly two keys", async () => {
    const f = answer(200, { success: true, state: "approved" });
    await sendApproval({ missionId: MISSION, requestId: ID, expectedPoints: 100, fetchFn: f, headers });
    const [url, init] = (f as any).mock.calls[0];
    expect(url).toBe(addonApprovalUrl(MISSION));
    expect(url).toBe(`/api/missions/${MISSION}/addon-approval`);
    expect(init.method).toBe("POST");
    expect(Object.keys(JSON.parse(init.body)).sort()).toEqual(["expectedPoints", "requestId"]);
    expect(JSON.parse(init.body)).toEqual({ requestId: ID, expectedPoints: 100 });
    expect(init.headers.Authorization).toBe("Bearer t");
  });
  it("a bad id or a bad price is refused locally: no request leaves the browser", async () => {
    for (const bad of [{ requestId: "x", expectedPoints: 100 }, { requestId: ID, expectedPoints: 0 }, { requestId: ID, expectedPoints: 100.5 }, { requestId: ID, expectedPoints: 6000 }]) {
      const f = answer(200, {});
      const r = await sendApproval({ missionId: MISSION, ...bad, fetchFn: f, headers });
      expect(r.state).toBe("refused");
      expect(f).not.toHaveBeenCalled();
    }
  });
});

describe("what the customer is told, by the server's answer", () => {
  const run = (status: number, body: unknown) => sendApproval({ missionId: MISSION, requestId: ID, expectedPoints: 100, fetchFn: answer(status, body), headers });
  it("approved", async () => { expect(await run(200, { success: true, state: "approved", holdPoints: 100 })).toEqual({ state: "approved", message: APPROVED_AR }); });
  it("already approved (a second click)", async () => { expect(await run(409, { success: false, state: "already_approved", code: "already_approved" })).toEqual({ state: "already_approved", message: ALREADY_APPROVED_AR }); });
  it("a refusal shows the server's own Arabic sentence", async () => {
    const r = await run(402, { success: false, state: "refused", error: "رصيدك لا يكفي لهذا الطلب. اشحن رصيدك ثم اعتمده؛ لم يُخصم شيء." });
    expect(r).toEqual({ state: "refused", message: "رصيدك لا يكفي لهذا الطلب. اشحن رصيدك ثم اعتمده؛ لم يُخصم شيء." });
  });
  it("UNCERTAIN keeps the server's words (the points MAY be held)", async () => {
    const r = await run(409, { success: false, state: "uncertain", error: "لم نتمكن من تأكيد اعتماد الطلب بعد. قد تكون نقاطك حُجزت مؤقتًا." });
    expect(r.state).toBe("uncertain");
    expect(r.message).toContain("قد تكون نقاطك حُجزت");
  });
  it("an answer that is not ours (a gateway 502 with HTML, an empty 500), or a lost connection, is UNCERTAIN and never says nothing was held", async () => {
    for (const r of [await run(502, "<html>bad gateway</html>"), await run(500, ""), await sendApproval({ missionId: MISSION, requestId: ID, expectedPoints: 100, fetchFn: (async () => { throw new Error("offline"); }) as unknown as typeof fetch, headers })]) {
      expect(r).toEqual({ state: "uncertain", message: APPROVE_UNKNOWN_AR });
      expect(r.message).not.toContain("لم يُحجز");
    }
  });
  it("a signed-out answer asks to sign in and says nothing was held, WITH or without the route's JSON body (independent review, finding 2)", async () => {
    expect(await run(401, "")).toEqual({ state: "refused", message: APPROVE_SIGNED_OUT_AR });
    expect(await run(401, { success: false, error: "غير مصرح. يرجى تسجيل الدخول أولاً." })).toEqual({ state: "refused", message: APPROVE_SIGNED_OUT_AR });
  });
  it("the route's own refusals before any money function (the feature switched off mid-session, a bad id, another account) say nothing was held; a 5xx never does", async () => {
    for (const [status, body] of [[404, { success: false, error: "not_found" }], [400, { success: false, error: "bad_request" }], [403, { success: false, error: "x" }]] as const) {
      expect(await run(status, body)).toEqual({ state: "refused", message: APPROVE_NOT_AVAILABLE_AR });
    }
    for (const status of [500, 502, 503]) expect((await run(status, { success: false, error: "x" })).state).toBe("uncertain");
  });
  it("a refusal with no usable sentence, or an absurdly long one, is not shown as a refusal", async () => {
    expect((await run(409, { success: false, state: "refused" })).state).toBe("uncertain");
    expect((await run(409, { success: false, state: "refused", error: "x".repeat(500) })).state).toBe("uncertain");
  });
  it("every fixed sentence passes the customer-text check, is Arabic only, and has no raw digit", () => {
    for (const t of [APPROVE_CONSENT_AR, APPROVED_AR, ALREADY_APPROVED_AR, APPROVE_UNKNOWN_AR, APPROVE_SIGNED_OUT_AR, APPROVE_NOT_AVAILABLE_AR, approveButtonAr(100), approveButtonAr(1234)]) {
      expect(checkCustomerText(t).issues, t).toEqual([]);
      expect(t).not.toMatch(/[0-9A-Za-z]/);
    }
    expect(approveButtonAr(100)).toBe("اعتمد الطلب واحجز ١٠٠ نقطة");
  });
});

describe("the button is offered only when the server says the approval is available", () => {
  it("404 (the flag is off), signed out, an outage, a malformed answer and a lost connection: not available", async () => {
    for (const f of [answer(404, { success: false, error: "not_found" }), answer(401, { success: false }), answer(503, {}), answer(200, { success: true }), answer(200, "not json"), (async () => { throw new Error("x"); }) as unknown as typeof fetch]) {
      expect(await fetchApprovalAvailable({ missionId: MISSION, fetchFn: f, headers })).toBe(false);
    }
    expect(await fetchApprovalAvailable({ missionId: MISSION, fetchFn: answer(200, { success: true, available: true }), headers })).toBe(true);
  });
});

describe("the button's markup", () => {
  it("idle draws NOTHING (the approval is off: the page is exactly what it was)", () => {
    expect(html(createElement(ApproveAddonBody, { status: "idle", points: 100 }))).toBe("");
  });
  it("ready: the consent sentence and one enabled button with the price", () => {
    const m = html(createElement(ApproveAddonBody, { status: "ready", points: 100, onApprove: () => undefined }));
    expect(m).toContain('data-testid="approve-consent"');
    expect(m).toContain("اعتمد الطلب واحجز ١٠٠ نقطة");
    expect(m).not.toContain('disabled=""');
    expect((m.match(/<button/g) ?? []).length).toBe(1);
  });
  it("approving: the button is disabled and busy (no double click from the page)", () => {
    const m = html(createElement(ApproveAddonBody, { status: "approving", points: 100 }));
    expect(m).toContain('disabled=""');
    expect(m).toContain('aria-busy="true"');
    expect(m).toContain("جارٍ الاعتماد…");
  });
  it("approved or already approved: no button remains, the result is announced politely", () => {
    for (const state of ["approved", "already_approved"] as const) {
      const m = html(createElement(ApproveAddonBody, { status: "done", points: 100, result: { state, message: APPROVED_AR } }));
      expect(m).not.toContain("<button");
      expect(m).toContain('role="status"');
    }
  });
  it("refused or uncertain: the result is an alert and the button stays (a retry converges on the same hold)", () => {
    for (const state of ["refused", "uncertain"] as const) {
      const m = html(createElement(ApproveAddonBody, { status: "done", points: 100, result: { state, message: "x" } }));
      expect(m).toContain("<button");
      expect(m).toContain('role="alert"');
    }
  });
});

describe("the two request cards: the button sits under the waiting request; without it the markup is unchanged", () => {
  const review = { id: ID, version: 1, cells: 18, points: 100, status: "plan_ready" as const };
  const edit = { id: ID, version: 1, newVersion: 2, change: { kind: "rename_column", fromAr: "أ", toAr: "ب", sheetAr: "الورقة" } as any, units: 1, estimatePoints: 100, holdPoints: 100, status: "plan_ready" as const };
  const approval = createElement("div", { "data-testid": "approve-addon" }, "BUTTON");
  it("review: the approval slot is rendered between the request's lines and the cancel button; the default markup is byte-for-byte the previous one", () => {
    const base = { versions: [{ version: 1, reason: "delivery" as const }] as any, selected: 1, onSelect: () => undefined, onAsk: () => undefined, waiting: review, onCancel: () => undefined };
    const without = html(createElement(ReviewQuoteBody, base));
    expect(html(createElement(ReviewQuoteBody, { ...base, approval: null }))).toBe(without);
    const withIt = html(createElement(ReviewQuoteBody, { ...base, approval }));
    expect(withIt).toContain("BUTTON");
    expect(withIt.indexOf("review-request")).toBeLessThan(withIt.indexOf("BUTTON"));
    expect(withIt.indexOf("BUTTON")).toBeLessThan(withIt.indexOf("review-cancel"));
    expect(withIt.replace(html(approval), "")).toBe(without);
  });
  it("edit: the same", () => {
    const base = { schema: null, status: "ready" as const, form: null, onForm: () => undefined, onAsk: () => undefined, waiting: edit, onCancel: () => undefined };
    const without = html(createElement(EditRequestBody, base as never));
    expect(html(createElement(EditRequestBody, { ...base, approval: null } as never))).toBe(without);
    const withIt = html(createElement(EditRequestBody, { ...base, approval } as never));
    expect(withIt.indexOf("edit-waiting")).toBeLessThan(withIt.indexOf("BUTTON"));
    expect(withIt.indexOf("BUTTON")).toBeLessThan(withIt.indexOf("edit-cancel"));
    expect(withIt.replace(html(approval), "")).toBe(without);
  });
  it("no waiting request, no button: the quote flow draws no approval", () => {
    const m = html(createElement(ReviewQuoteBody, { versions: [{ version: 1, reason: "delivery" }] as any, selected: 1, onSelect: () => undefined, onAsk: () => undefined, approval }));
    expect(m).not.toContain("BUTTON");
  });
});

describe("the sources", () => {
  const read = (f: string) => readFileSync(path.resolve(__dirname, "..", f), "utf8");
  const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  it("the client and the component call no money function, no rpc and no storage, import no server module, and fetch only the approval URL", () => {
    for (const f of ["src/lib/agentMission/stage4/addonApprovalClient.ts", "src/components/mission/ApproveAddon.tsx"]) {
      const src = code(f);
      expect(src, f).not.toMatch(/\.rpc\(|accept_quote_atomic|create_quote_atomic|reserve_credits_atomic|claim_job_chunk|release_job_atomic|\.storage\b|createAdminClient|supabase\/server|addonSettlement|approvalGuard|approvalRoute/);
    }
    expect(code("src/lib/agentMission/stage4/addonApprovalClient.ts").match(/fetchFn\(/g)).toHaveLength(2);
  });
  it("after an UNCERTAIN or refused answer the cards keep the request and the button mounted (finding 3); only an approved one leaves the waiting state", () => {
    for (const f of ["src/components/mission/ReviewQuote.tsx", "src/components/mission/EditRequestCard.tsx"]) {
      const src = code(f);
      expect(src, f).toMatch(/if \(r\.state !== "approved" && r\.state !== "already_approved"\) return;/);
    }
  });
  it("the cards draw the button only for a waiting request", () => {
    expect(code("src/components/mission/ReviewQuote.tsx")).toMatch(/approval=\{waiting \? <ApproveAddon/);
    expect(code("src/components/mission/EditRequestCard.tsx")).toMatch(/approval=\{waiting \? <ApproveAddon/);
  });
});
