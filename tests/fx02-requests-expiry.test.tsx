import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { checkCustomerText } from "@/lib/agentMission/text";
import { deliveredChargedLineAr, REQUEST_STATUS_LABEL_AR } from "@/lib/jobs/requestStatus";
import { extractDraftFromQuery } from "@/app/dashboard/chat/page";

describe("FX-02 Phase B: Requests list, details consistency and chat draft prefill", () => {
  const requestsSrc = readFileSync("src/app/dashboard/requests/page.tsx", "utf8");
  const detailsSrc = readFileSync("src/app/dashboard/requests/[id]/page.tsx", "utf8");
  const chatSrc = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");

  it("requests page tab 5 is «المبالغ المستردة» and explain line is natural Arabic without internal ledger terms", () => {
    expect(requestsSrc).toContain('["refunded", "المبالغ المستردة"]');
    expect(requestsSrc).toContain('refunded: "طلبات أُلغيت وأُعيد رصيدها المحجوز كاملًا إلى محفظتك دون أي خصم."');
    expect(requestsSrc).not.toContain('["refunded", "حجز مؤقت مُحرَّر"]');
    expect(requestsSrc).not.toContain('["refunded", "حجز مُحرَّر"]');

    const tabExplain = "طلبات أُلغيت وأُعيد رصيدها المحجوز كاملًا إلى محفظتك دون أي خصم.";
    expect(checkCustomerText(tabExplain).issues).toEqual([]);
  });

  it("formatRefundedNote says «أُعيد الرصيد المحجوز كاملًا إلى محفظتك... ولم يُخصم منك شيء»", () => {
    expect(requestsSrc).toContain("أُعيد الرصيد المحجوز كاملًا إلى محفظتك");
    expect(requestsSrc).not.toMatch(/حجز مؤقت مُحرَّر: \$\{pointsAr\(reservedCredits\)\}/);
    const refundSentence = "أُعيد الرصيد المحجوز كاملًا إلى محفظتك (١٠٠ نقطة)، ولم يُخصم منك شيء.";
    expect(checkCustomerText(refundSentence).issues).toEqual([]);
  });

  it("N2: deliveredChargedLineAr formats correct singular/dual/plural without using «صف» or «سجل»", () => {
    const full = deliveredChargedLineAr({ delivered: 6, charged: 5 });
    expect(full).toBe("تم تسليم ٦ عناصر، وحُسبت تكلفة ٥ فقط لأن عنصرًا واحدًا لم يحتوِ على بيانات الاتصال المطلوبة.");
    expect(full).not.toContain("صف");
    expect(full).not.toContain("سجل");
    expect(checkCustomerText(full).issues).toEqual([]);

    const concise = deliveredChargedLineAr({ delivered: 6, charged: 5, concise: true });
    expect(concise).toBe("استلمت ٦، ودُفع ثمن ٥ لعدم توفر بيانات الاتصال في عنصرًا واحدًا.");
    expect(concise).not.toContain("صف");
    expect(concise).not.toContain("سجل");
    expect(checkCustomerText(concise).issues).toEqual([]);
  });

  it("requests/[id] uses missionDelivered first and renders deliveredChargedLineAr on mismatch", () => {
    expect(detailsSrc).toContain("missionDelivered ?? jobDelivered ?? prev?.delivered ?? null");
    expect(detailsSrc).toContain("hasContactMismatch ? jobDelivered : (prev?.billable ?? null)");
    expect(detailsSrc).toContain("typeof facts.billable === \"number\" && facts.delivered > facts.billable");
    expect(detailsSrc).toContain("deliveredChargedLineAr({ delivered: facts.delivered, charged: facts.billable })");
  });

  it("requests/[id] passes onEdit routing to /dashboard/chat?draft=...", () => {
    expect(detailsSrc).toContain('onEdit={(requestText) => router.push(`/dashboard/chat?draft=${encodeURIComponent(requestText)}`)}');
  });

  it("chat page handles ?draft= parameter by extracting draft without auto-send or mission creation", () => {
    expect(chatSrc).toContain('const draft = search.get("draft");');
    expect(chatSrc).toContain("setInputText(draft);");
    expect(chatSrc).toContain('url.searchParams.delete("draft");');

    // Test pure query helper
    const extracted = extractDraftFromQuery("?c=123&draft=%D8%A7%D8%AC%D9%85%D8%B9%20%D9%A2%D9%A0%D9%A0");
    expect(extracted).toBe("اجمع ٢٠٠");

    expect(extractDraftFromQuery("")).toBeNull();
    expect(extractDraftFromQuery("?c=123")).toBeNull();
  });
});
