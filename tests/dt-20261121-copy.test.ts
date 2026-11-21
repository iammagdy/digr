import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { childShortfallClauseAr } from "../agent/src/finalize";
import { STALE_MISSION_PLAN_AR } from "../src/lib/agentMission/approval";
import { MISSION_APPROVAL_PENDING_AR } from "../src/lib/agentMission/lifecycle";
import { APPROVE_UNKNOWN_AR } from "../src/lib/missionApprove";

describe("DT-20261121-copy: 6 MUST customer-facing Arabic copy fixes", () => {
  it("MUST 1 (approval.ts): stale plan update explains card update and confirms nothing charged", () => {
    expect(STALE_MISSION_PLAN_AR).toBe(
      "تغيّرت الخطة أو السعر أثناء مراجعتك، وجرى تحديث البطاقة بالسعر الجديد؛ لم يُخصم شيء من رصيدك. راجع الخطة واضغط «اعتمد» للمتابعة.",
    );
    expect(STALE_MISSION_PLAN_AR).not.toContain("قبل تأكيد الاعتماد مرة أخرى");
  });

  it("MUST 2 (missionApprove.ts): connection drop during approval confirms nothing charged if still waiting", () => {
    expect(APPROVE_UNKNOWN_AR).toBe(
      "تعذّر تأكيد الاعتماد بسبب انقطاع الاتصال. حدّث الصفحة وتحقق من «طلباتي»: إن كانت المهمة تعمل فقد بدأت، وإن بقيت الخطة بانتظار اعتمادك فلم يُخصم شيء ويمكنك الضغط على «اعتمد» مجددًا.",
    );
    expect(APPROVE_UNKNOWN_AR).not.toContain("لم نستطع تأكيد الاعتماد الآن");
  });

  it("MUST 3 (lifecycle.ts & AgentMissionCard.tsx): pending approval promises points never held twice without promising nothing charged", () => {
    expect(MISSION_APPROVAL_PENDING_AR).toBe(
      "نتحقق الآن من اعتماد طلبك بعد انقطاع مؤقت، ولن تُحجز نقاطك مرتين. حدّث الصفحة للاطّلاع على أحدث حالة.",
    );
    expect(MISSION_APPROVAL_PENDING_AR).not.toContain("حالة اعتماد طلبك");
    expect(MISSION_APPROVAL_PENDING_AR).not.toContain("لم يُخصم");

    const cardSource = readFileSync(`${process.cwd()}/src/components/mission/AgentMissionCard.tsx`, "utf8");
    expect(cardSource).toContain("نتحقق الآن من اعتماد طلبك بعد انقطاع مؤقت، ولن تُحجز نقاطك مرتين. حدّث الصفحة للاطّلاع على أحدث حالة.");
    expect(cardSource).not.toContain("نتحقق الآن من حالة اعتماد طلبك. حدّث الصفحة للاطّلاع على الحالة.");
  });

  it("MUST 4 (customerActions.ts): plan_changed confirms nothing charged from balance", () => {
    const actionsSource = readFileSync(`${process.cwd()}/src/lib/agentMission/customerActions.ts`, "utf8");
    expect(actionsSource).toContain(
      'plan_changed: "تغيّر سعر الخطة في النظام، ولم يُخصم شيء من رصيدك. أعد إرسال الطلب ليُحسب لك بالسعر المحدّث."',
    );
    expect(actionsSource).not.toContain('plan_changed: "تغيّر سعر الخطة؛ اطلب المهمة من جديد ليُحسب لك سعر محدّث."');
  });

  it("MUST 5 (customerActions.ts): quote_expired confirms nothing charged from balance", () => {
    const actionsSource = readFileSync(`${process.cwd()}/src/lib/agentMission/customerActions.ts`, "utf8");
    expect(actionsSource).toContain(
      'quote_expired: "انتهت صلاحية السعر المعروض، ولم يُخصم أي رصيد. اضغط «اعتمد» مجددًا لتحديث السعر وتأكيد البدء."',
    );
    expect(actionsSource).not.toContain('quote_expired: "انتهت صلاحية السعر. اضغط اعتمد مرة أخرى."');
  });

  describe("MUST 6 (finalize.ts & runMission.ts): total-only vs capped child shortfall reason", () => {
    it("total-only Facebook plan explains available posts did not have enough comments to reach total", () => {
      const clause = childShortfallClauseAr("بوست", "منشورات", "تعليقات", true);
      expect(clause).toBe("لأن المنشورات المتاحة لم تحتوِ على عدد تعليقات كافٍ لبلوغ إجمالي المطلوب");
      expect(clause).not.toContain("أقل من العدد المطلوب لكل");
    });

    it("total-only YouTube plan explains available videos did not have enough comments to reach total", () => {
      const clause = childShortfallClauseAr("فيديو", "فيديوهات", "تعليقات", true);
      expect(clause).toBe("لأن الفيديوهات المتاحة لم تحتوِ على عدد تعليقات كافٍ لبلوغ إجمالي المطلوب");
      expect(clause).not.toContain("أقل من العدد المطلوب لكل");
    });

    it("capped plan (TikTok 237 case) keeps per-parent shortfall wording", () => {
      const clause = childShortfallClauseAr("فيديو", "فيديوهات", "تعليقات", false);
      expect(clause).toBe("لأن بعض الفيديوهات عليها تعليقات أقل من العدد المطلوب لكل فيديو");
      expect(clause).not.toContain("المتاحة لم تحتوِ");

      // Default call without 4th argument defaults to capped behavior
      expect(childShortfallClauseAr("فيديو", "فيديوهات", "تعليقات")).toBe("لأن بعض الفيديوهات عليها تعليقات أقل من العدد المطلوب لكل فيديو");
    });

    it("counter-case: capped plan with fill_total_across_parents: true but numeric per_parent_rows preserves per-parent wording", () => {
      const stage = {
        per_parent_rows: 15,
        engine: { fill_total_across_parents: true as const },
      };
      const isFillTotal = stage.engine?.fill_total_across_parents === true && stage.per_parent_rows === undefined;
      expect(isFillTotal).toBe(false);

      const clause = childShortfallClauseAr("فيديو", "فيديوهات", "تعليقات", isFillTotal);
      expect(clause).toBe("لأن بعض الفيديوهات عليها تعليقات أقل من العدد المطلوب لكل فيديو");
      expect(clause).not.toContain("المتاحة لم تحتوِ");
    });
  });
});
