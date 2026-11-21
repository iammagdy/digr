import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { checkCustomerText } from "@/lib/agentMission/text";
import {
  customerMissionView,
  EXPIRED_PLAN_END_AR,
  EXPIRED_PLAN_NOTE_AR,
  columnLabelAr,
  type MissionRowForCustomer,
} from "@/lib/agentMission/customerView";
import { AgentMissionCardBody } from "@/components/mission/AgentMissionCard";

describe("FX-02 Phase C: customer view and mission card fixes (N9, N4, N2, N12, N13)", () => {
  const baseMission: MissionRowForCustomer = {
    id: "msn_test",
    status: "completed",
    question_ar: null,
    plan_public: {
      summary_ar: "جمع بيانات",
      stages: [
        {
          key: "s1",
          title_ar: "المرحلة الأولى",
          expected_rows: 10,
          deliver: true,
          columns: [{ key: "col1", title_ar: "الاسم" }],
          sample_rows: [],
        },
      ],
      price: { max_charge_points: 100, reserve_points: 120 },
    },
    reserved_points: 120,
    unit_price_points: 10,
    delivered_units: 10,
    charged_points: 100,
    summary_ar: null,
    files: [{ name: "data.xlsx", kind: "xlsx" }],
    created_at: "2026-11-20T10:00:00Z",
  };

  it("N9: expired plan renders 72h end sentence, explanation note and renewal button", () => {
    const expiredMission: MissionRowForCustomer = {
      ...baseMission,
      status: "cancelled",
      error: "expired: not approved within 72 hours",
      summary_ar: "انتهت صلاحية الخطة",
    };
    const view = customerMissionView({
      mission: expiredMission,
      events: [],
    });

    expect(view.phase).toBe("cancelled");
    expect(view.expired).toBe(true);
    expect(view.endLineAr).toBe(EXPIRED_PLAN_END_AR);
    expect(view.expiredNoteAr).toBe(EXPIRED_PLAN_NOTE_AR);
    expect(checkCustomerText(EXPIRED_PLAN_END_AR).issues).toEqual([]);
    expect(checkCustomerText(EXPIRED_PLAN_NOTE_AR).issues).toEqual([]);

    const html = renderToStaticMarkup(
      <AgentMissionCardBody
        view={view as any}
        isGuest={false}
        onRetry={vi.fn()}
      />
    );
    expect(html).toContain(EXPIRED_PLAN_END_AR);
    expect(html).toContain(EXPIRED_PLAN_NOTE_AR);
    expect(html).toContain("تجديد الخطة وإعادة الطلب");
    expect(html).not.toContain("ابدأها من جديد");
  });

  it("N9 counter-case: manual cancellation keeps generic cancel line and original retry button", () => {
    const manualCancelled: MissionRowForCustomer = {
      ...baseMission,
      status: "cancelled",
      error: null,
      summary_ar: null,
    };
    const view = customerMissionView({
      mission: manualCancelled,
      events: [],
    });

    expect(view.phase).toBe("cancelled");
    expect(view.expired).toBeFalsy();
    expect(view.endLineAr).toBe("أُلغيت هذه المهمة ولم يُخصم شيء.");
    expect(view.expiredNoteAr).toBeUndefined();

    const html = renderToStaticMarkup(
      <AgentMissionCardBody
        view={view as any}
        isGuest={false}
        onRetry={vi.fn()}
      />
    );
    expect(html).toContain("أُلغيت هذه المهمة ولم يُخصم شيء.");
    expect(html).toContain("ابدأها من جديد");
    expect(html).not.toContain("تجديد الخطة وإعادة الطلب");
  });

  it("N4: partial delivery shows shortage reason and refund line from stored numbers", () => {
    const partialMission: MissionRowForCustomer = {
      ...baseMission,
      status: "completed",
      delivered_units: 5,
      reserved_points: 200,
      charged_points: 168,
      summary_ar: "نفاد التعليقات المتاحة في المصدر",
    };
    const view = customerMissionView({
      mission: partialMission,
      events: [],
    });

    expect(view.phase).toBe("partial");
    expect(view.partialReasonAr).toBe("اكتمل الجمع بعدد أقل من المطلوب: نفاد التعليقات المتاحة في المصدر.");
    expect(view.partialRefundAr).toBe("رجع لمحفظتك ٣٢ نقطة.");
    expect(checkCustomerText(view.partialReasonAr!).issues).toEqual([]);
    expect(checkCustomerText(view.partialRefundAr!).issues).toEqual([]);

    const html = renderToStaticMarkup(
      <AgentMissionCardBody
        view={view as any}
        isGuest={false}
      />
    );
    expect(html).toContain("اكتمل الجمع بعدد أقل من المطلوب: نفاد التعليقات المتاحة في المصدر.");
    expect(html).toContain("رجع لمحفظتك ٣٢ نقطة.");
  });

  it("N4 counter-case: partial mission with unknown hold hides refund line entirely", () => {
    const partialNoReserve: MissionRowForCustomer = {
      ...baseMission,
      status: "completed",
      delivered_units: 5,
      reserved_points: null,
      charged_points: 50,
      summary_ar: "توقف البحث",
    };
    const view = customerMissionView({
      mission: partialNoReserve,
      events: [],
    });

    expect(view.phase).toBe("partial");
    expect(view.partialRefundAr).toBeNull();
  });

  it("N2: completed mission with charged_units < delivered_units emits unified delivered/charged sentence", () => {
    const missionWithDiff: MissionRowForCustomer = {
      ...baseMission,
      status: "completed",
      delivered_units: 6,
      charged_units: 5,
    };
    const view = customerMissionView({
      mission: missionWithDiff,
      events: [],
    });

    expect(view.resultLinesAr[0]).toBe("تم تسليم ٦ عناصر، وحُسبت تكلفة ٥ فقط لأن عنصرًا واحدًا لم يحتوِ على بيانات الاتصال المطلوبة.");
    expect(view.resultLinesAr[0]).not.toContain("صف");
    expect(view.resultLinesAr[0]).not.toContain("سجل");
    expect(checkCustomerText(view.resultLinesAr[0]).issues).toEqual([]);
  });

  it("N12: sample and editor columns with non-Arabic titles fall back to «عمود ١»", () => {
    const latinColMission: MissionRowForCustomer = {
      ...baseMission,
      plan_public: {
        summary_ar: "بيانات الشركات",
        stages: [
          {
            key: "s1",
            title_ar: "الشركات",
            expected_rows: 5,
            deliver: true,
            columns: [
              { key: "company_name", title_ar: "Company Name" },
              { key: "website", title_ar: "Website URL" },
            ],
            sample_rows: [["Acme Corp", "https://example.com"]],
          },
        ],
        price: { max_charge_points: 50, reserve_points: 60 },
      },
    };
    const view = customerMissionView({
      mission: latinColMission,
      events: [],
    });

    expect(view.samples).not.toBeNull();
    expect(view.samples!.columns[0].titleAr).toBe("عمود ١");
    expect(view.samples!.columns[1].titleAr).toBe("عمود ٢");
    expect(view.samples!.columns[0].titleAr).not.toContain("تعذّر عرض تفاصيل هذه الخطوة");
  });

  it("N13: stored summary with digits passing checkCustomerText is shown; provider names or foreign Latin are dropped", () => {
    // Valid digits summary matching card numbers
    const validDigitsMission: MissionRowForCustomer = {
      ...baseMission,
      delivered_units: 250,
      summary_ar: "اكتمل جمع ٢٥٠ تغريدة مطابقة لطلبك",
    };
    const viewValid = customerMissionView({
      mission: validDigitsMission,
      events: [],
    });
    expect(viewValid.resultSummaryAr).toBe("اكتمل جمع ٢٥٠ تغريدة مطابقة لطلبك");

    // Mismatched digits summary (contains 250 but delivered is 10)
    const mismatchDigitsMission: MissionRowForCustomer = {
      ...baseMission,
      delivered_units: 10,
      summary_ar: "اكتمل جمع ٢٥٠ تغريدة مطابقة لطلبك",
    };
    const viewMismatch = customerMissionView({
      mission: mismatchDigitsMission,
      events: [],
    });
    expect(viewMismatch.resultSummaryAr).toBeNull();

    // Summary with provider name
    const providerMission: MissionRowForCustomer = {
      ...baseMission,
      delivered_units: 5,
      summary_ar: "تم جمع ٥ تغريدات من تريغ",
    };
    const viewProvider = customerMissionView({
      mission: providerMission,
      events: [],
    });
    expect(viewProvider.resultSummaryAr).toBeNull();

    // Summary with foreign Latin text
    const latinMission: MissionRowForCustomer = {
      ...baseMission,
      delivered_units: 5,
      summary_ar: "collected 5 from apify provider",
    };
    const viewLatin = customerMissionView({
      mission: latinMission,
      events: [],
    });
    expect(viewLatin.resultSummaryAr).toBeNull();

    // Summary without digits but with provider name
    const providerNoDigits: MissionRowForCustomer = {
      ...baseMission,
      summary_ar: "تم جمع النتائج من تريغ بالكامل",
    };
    const viewProviderNoDigits = customerMissionView({
      mission: providerNoDigits,
      events: [],
    });
    expect(viewProviderNoDigits.resultSummaryAr).toBeNull();
  });
});
