import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RejectionReasonLine } from "../src/app/dashboard/topup/RejectionReasonLine";
import {
  cleanRejectReason, notificationIdForTopup, REJECT_REASON_MAX_CHARS, rejectionReasonFor, rejectReasonFromNotificationBody, topupIdFromNotificationId,
} from "../src/lib/topupRejectReason";
import type { TopupRecord } from "../src/app/dashboard/topup/types";

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** The row exactly as page.tsx builds it from the `topups` table (see loadTopups): there is no reject_reason column in the schema, so it is null. */
const topupRow = (over: Partial<TopupRecord> & { $id: string; status: TopupRecord["status"] }): TopupRecord => ({
  id: over.$id, userId: "11111111-2222-4333-8444-555555555555", amountEgp: 100, reference: "rcpt_9f2c4e7a1b3d5f60718293a4b5c6d7e8", senderName: "", senderPhone: "",
  receiptFileId: "u/r.png", credits: null, createdAt: "2026-10-12T09:00:00Z", reviewedAt: null, rejectReason: null, ...over,
});
/** The notification exactly as the reject route inserts it for the customer (same id and body format; pinned against the route's source below). */
const notification = (topupId: string, reason: string) => ({ id: `notif_${topupId}`, body: `تم رفض طلب الشحن. السبب: ${reason}` });

describe("the reason a rejected request shows", () => {
  it("a rejected request with a reason shows it, once, under the request", () => {
    const row = topupRow({ $id: "tp_1", status: "rejected" });
    const reason = rejectionReasonFor({ status: row.status, columnReason: row.rejectReason, notificationBody: notification("tp_1", "المبلغ المحوّل مختلف").body });
    expect(reason).toBe("المبلغ المحوّل مختلف");
    const html = renderToStaticMarkup(createElement(RejectionReasonLine, { reason }));
    expect(html).toContain('data-testid="topup-reject-reason"');
    expect(html.replace(/<[^>]+>/g, "")).toBe("سبب الرفض: المبلغ المحوّل مختلف");
    expect(html).toContain("text-bad"); // the existing error token, no new colour
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}/);
  });

  it("a rejected request WITHOUT a reason shows nothing at all: no line, no placeholder", () => {
    for (const body of [undefined, null, "", "تم رفض طلب الشحن.", "تم رفض طلب الشحن. السبب:", "تم رفض طلب الشحن. السبب:    "]) {
      const reason = rejectionReasonFor({ status: "rejected", columnReason: null, notificationBody: body as never });
      expect(reason, String(body)).toBeNull();
      expect(renderToStaticMarkup(createElement(RejectionReasonLine, { reason }))).toBe("");
    }
    expect(renderToStaticMarkup(createElement(RejectionReasonLine, { reason: null }))).not.toContain("غير محدد");
  });

  it("approved and pending requests never show a reason, whatever text is around", () => {
    for (const status of ["approved", "pending"] as const) {
      const reason = rejectionReasonFor({ status, columnReason: "سبب قديم", notificationBody: notification("tp_2", "المبلغ المحوّل مختلف").body });
      expect(reason, status).toBeNull();
      expect(renderToStaticMarkup(createElement(RejectionReasonLine, { reason }))).toBe("");
    }
  });

  it("the column wins when the table has one; the notification is the fallback", () => {
    expect(rejectionReasonFor({ status: "rejected", columnReason: "من العمود", notificationBody: notification("tp_1", "من الإشعار").body })).toBe("من العمود");
    expect(rejectionReasonFor({ status: "rejected", columnReason: null, notificationBody: notification("tp_1", "من الإشعار").body })).toBe("من الإشعار");
  });

  it("a long reason is capped (200 characters, ending with «…»); a short one is untouched", () => {
    const long = "سبب ".repeat(120);
    const capped = cleanRejectReason(long)!;
    expect(Array.from(capped).length).toBeLessThanOrEqual(REJECT_REASON_MAX_CHARS);
    expect(capped.endsWith("…")).toBe(true);
    const exact = "ا".repeat(REJECT_REASON_MAX_CHARS);
    expect(cleanRejectReason(exact)).toBe(exact);
    expect(Array.from(cleanRejectReason(exact + "ا")!).length).toBe(REJECT_REASON_MAX_CHARS);
    expect(cleanRejectReason("الإيصال غير واضح")).toBe("الإيصال غير واضح");
  });

  it("HTML in a reason is shown as text, never as markup", () => {
    const html = renderToStaticMarkup(createElement(RejectionReasonLine, { reason: cleanRejectReason('<img src=x onerror=alert(1)> <b>غير واضح</b>') }));
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    for (const file of ["src/app/dashboard/topup/RejectionReasonLine.tsx", "src/app/dashboard/topup/page.tsx", "src/app/dashboard/topup/SubmittedCard.tsx"]) {
      expect(src(file), file).not.toContain("dangerouslySetInnerHTML");
    }
  });

  it("no internal id, e-mail address or control character reaches the customer; digits are Arabic-Indic; one line", () => {
    const text = cleanRejectReason("الإيصال  غير\nواضح rcpt_9f2c4e7a1b3d5f60718293a4b5c6d7e8 راسل admin@diger.tech أو 0123456789abcdef0123456789abcdef رقم 12\u0007")!;
    expect(text).not.toMatch(/rcpt_|@|[0-9a-f]{24,}|[0-9]/i);
    expect(text).not.toMatch(/[\u0000-\u001f]/);
    expect(text).not.toMatch(/\s{2,}/);
    expect(text).toContain("رقم ١٢");
    expect(cleanRejectReason("rcpt_9f2c4e7a1b3d5f60718293a4b5c6d7e8")).toBeNull();
    expect(cleanRejectReason("a1b2c3d4-e5f6-4789-a012-b3c4d5e6f708")).toBeNull();
    expect(cleanRejectReason(undefined)).toBeNull();
    expect(cleanRejectReason(42)).toBeNull();
  });

  it("the older notification text, which also carried the receipt id before the marker, never leaks it", () => {
    const old = "تم رفض طلب الشحن (مرجع: rcpt_9f2c4e7a1b3d5f60718293a4b5c6d7e8). السبب: المبلغ المحوّل مختلف";
    expect(rejectReasonFromNotificationBody(old)).toBe("المبلغ المحوّل مختلف");
    expect(rejectionReasonFor({ status: "rejected", notificationBody: old })).not.toMatch(/rcpt_|مرجع/);
    // a reason that itself contains the marker is kept whole after the FIRST one
    expect(rejectReasonFromNotificationBody("تم رفض طلب الشحن. السبب: أولًا السبب: ثانيًا")).toBe("أولًا السبب: ثانيًا");
  });

  it("the notification id and body the page reads are the ones the reject route writes (the coupling is pinned)", () => {
    const route = src("src/app/api/admin/topups/approve/route.ts");
    expect(route).toContain("id: `notif_${topupId}`");
    expect(route).toContain("body: `تم رفض طلب الشحن. السبب: ${confirmedRejectReason}`");
    expect(notificationIdForTopup("tp_1")).toBe("notif_tp_1");
    expect(topupIdFromNotificationId("notif_tp_1")).toBe("tp_1");
    expect(notification("tp_1", "س").id).toBe(notificationIdForTopup("tp_1"));
  });
});

describe("how the wallet page gets it: the customer's own rows, read only, no SQL", () => {
  const page = src("src/app/dashboard/topup/page.tsx");
  it("one select of the customer's own notifications for their rejected requests, and nothing is written", () => {
    expect(page).toContain(".from(NOTIFICATIONS_COLLECTION)");
    expect(page).toContain('.select("id, body")');
    expect(page).toContain('.eq("user_id", user.id)');
    expect(page).toContain(".in(\"id\", rejectedKey.split(\",\").map(notificationIdForTopup))");
    expect(page).not.toMatch(/NOTIFICATIONS_COLLECTION\)\s*\.(insert|update|delete|upsert)/);
    expect(page).not.toContain(".rpc(");
  });
  it("the reason is set only through rejectionReasonFor, for the list and for the submitted card, and the line is the shared component", () => {
    expect(page).toContain("rejectionReasonFor({ status: topup.status, columnReason: topup.rejectReason, notificationBody: rejectNotes[topup.$id] })");
    expect(page).toContain("rejectReason: reasonOf(submitted)");
    expect(page).toContain("rejectReason: reasonOf(topup)");
    expect(page).toContain("<RejectionReasonLine reason={");
    expect(page).not.toMatch(/\{t\.rejectReason\}/); // the raw column text is no longer printed directly
  });
  it("no timer or polling was added for it, and no migration, policy or grant was touched", () => {
    const effect = page.slice(page.indexOf("const rejectedKey"), page.indexOf("/* records delivered this month"));
    expect(effect).not.toMatch(/setInterval|setTimeout|startNotificationPolling/);
    expect(effect).toContain("[user, rejectedKey]");
  });
  it("the proposal for a durable column exists and says it is NOT APPLIED", () => {
    const proposal = src("docs/proposals/topup-reject-reason-column.md");
    expect(proposal).toContain("NOT APPLIED");
    expect(proposal).toContain("reject_topup_atomic");
  });
});
