import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OVERVIEW_PAYMENT_AR } from "../src/components/landing/Overview";
import { REQUEST_STATUS_LABEL_AR } from "../src/lib/jobs/requestStatus";
import { checkCustomerText } from "../src/lib/agentMission/text";

describe("FX-02 Phase A: N8 Customer Wording", () => {
  it("Overview payment text uses natural customer wording and passes checkCustomerText", () => {
    expect(OVERVIEW_PAYMENT_AR).toBe(
      "تدفع مقابل ما يُسلَّم لك فعلًا فقط: يُحجز المبلغ مؤقتًا عند الاعتماد، ويُخصم منه ثمن ما استلمته، وما تبقّى يعود تلقائيًا إلى محفظتك."
    );
    expect(OVERVIEW_PAYMENT_AR).not.toContain("حجز مؤقت مُحرَّر");
    expect(checkCustomerText(OVERVIEW_PAYMENT_AR).issues).toEqual([]);
  });

  it("requestStatus.ts refunded label uses «تعذر التنفيذ · رصيد مسترد» and passes checkCustomerText", () => {
    expect(REQUEST_STATUS_LABEL_AR.refunded).toBe("تعذر التنفيذ · رصيد مسترد");
    expect(REQUEST_STATUS_LABEL_AR.refunded).not.toContain("حجز مؤقت مُحرَّر");
    expect(checkCustomerText(REQUEST_STATUS_LABEL_AR.refunded).issues).toEqual([]);
  });

  it("topup/page.tsx uses natural refund wording without «حجز مؤقت مُحرَّر» or «حجز مُحرَّر»", () => {
    const page = readFileSync("src/app/dashboard/topup/page.tsx", "utf8");
    expect(page).toContain('["refund", "مسترد للمحفظة"]');
    expect(page).toContain("رصيد مسترد للمحفظة");
    expect(page).toContain("رصيد محجوز عاد لمحفظتك دون خصم");
    expect(page).toContain(
      "يُحجز الرصيد مؤقتًا عند بدء الطلب، ويُخصم منه ثمن ما استلمته فقط، ثم يعود باقي الرصيد المحجوز إلى محفظتك فور التسليم."
    );

    // Verify none of the old strings exist in topup/page.tsx
    expect(page).not.toContain('["refund", "حجز مُحرَّر"]');
    expect(page).not.toContain("محجوز ومُحرَّر</p>");
    expect(page).not.toContain("حجز مؤقت رُفع ولم يُخصم");
    expect(page).not.toContain("في سجل الحركات يظهر الحجز المُحرَّر");
  });

  it("buildIndex.ts uses updated N9 expired note", () => {
    const code = readFileSync("src/lib/requests/buildIndex.ts", "utf8");
    expect(code).toContain('expired: "انتهت مهلة اعتماد الخطة (٧٢ ساعة) دون تأكيد، ولم يُخصم أي رصيد من محفظتك."');
    expect(checkCustomerText("انتهت مهلة اعتماد الخطة (٧٢ ساعة) دون تأكيد، ولم يُخصم أي رصيد من محفظتك.").issues).toEqual([]);
  });
});
