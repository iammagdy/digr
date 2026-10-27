import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REQUEST_STATUS_LABEL_AR, collectedBeforeStopText, deliveredOfRequestedAr, partialDeliveryText, resolveRequestKind } from "../src/lib/jobs/requestStatus";

describe("one status source of truth", () => {
  it("is «مكتمل» only when the requested volume was delivered", () => {
    expect(resolveRequestKind({ status: "completed", delivered: 5, requested: 5 })).toBe("done");
    expect(resolveRequestKind({ status: "done", delivered: 7, requested: 5 })).toBe("done");
    expect(resolveRequestKind({ status: "completed", delivered: 4, requested: 5 })).toBe("partial");
    expect(resolveRequestKind({ status: "completed", delivered: 0, requested: 5 })).toBe("partial");
    // Unknown requested volume cannot be called partial.
    expect(resolveRequestKind({ status: "completed", delivered: 3, requested: null })).toBe("done");
  });

  it("describes a finished short run with requested versus delivered in Arabic-Indic digits", () => {
    expect(REQUEST_STATUS_LABEL_AR.partial).toBe("مكتمل جزئيًا");
    expect(partialDeliveryText(4, 5)).toBe("تم تسليم ٤ من ٥ سجلات؛ الخصم يقتصر على السجلات المسلّمة المطابقة.");
  });

  it("a failed, cancelled or refused run is refunded even if it had collected rows (evidence: 86 failed jobs, 0 charged)", () => {
    for (const status of ["failed", "cancelled", "refused"]) {
      expect(resolveRequestKind({ status, delivered: 5, requested: 20 })).toBe("refunded");
    }
    expect(collectedBeforeStopText(5, 20)).toContain("لم يُخصم أي رصيد");
    expect(collectedBeforeStopText(5, 20)).toContain("٥ من ٢٠");
  });

  it("queued and running stay running", () => {
    expect(resolveRequestKind({ status: "queued" })).toBe("running");
    expect(resolveRequestKind({ status: "running", delivered: 10, requested: 20 })).toBe("running");
  });

  it("the requests list and the activity panel both use the shared resolver", () => {
    const list = readFileSync("src/app/dashboard/requests/page.tsx", "utf8");
    const terminal = readFileSync("src/app/dashboard/chat/components/ActivityTerminal.tsx", "utf8");
    expect(list).toContain("resolveRequestKind({ status: j.status, delivered: j.rowsCollected, requested: j.targetVolumeMax })");
    expect(terminal).toContain("resolveRequestKind({ status, delivered: rowsCollected, requested: requestedRows })");
    // No second, local copy of the rule.
    expect(list).not.toMatch(/delivered < req\b/);
  });

  it("the requests list keeps refreshing so a request started elsewhere appears", () => {
    const list = readFileSync("src/app/dashboard/requests/page.tsx", "utf8");
    expect(list).toContain("ticks % 4 === 0");
    expect(list).toContain("document.hidden");
  });
});

describe("«تم تسليم X من Y»: the noun follows the ONE plural rule (countPlainAr), never a fixed «سجلاً»", () => {
  it.each([
    [0, 1, "تم تسليم ٠ من سجل واحد"],
    [1, 2, "تم تسليم ١ من سجلين"],
    [8, 10, "تم تسليم ٨ من ١٠ سجلات"],
    [4, 5, "تم تسليم ٤ من ٥ سجلات"],
    [10, 11, "تم تسليم ١٠ من ١١ سجل"],
    [40, 100, "تم تسليم ٤٠ من ١٠٠ سجل"],
    [3, 3, "تم تسليم ٣ من ٣ سجلات"],
  ])("delivered %i of %i → %s", (delivered, requested, expected) => {
    expect(deliveredOfRequestedAr(delivered, requested)).toBe(expected);
  });

  it("the kind of the count can be given (posts, comments)", () => {
    expect(deliveredOfRequestedAr(8, 10, "comments")).toBe("تم تسليم ٨ من ١٠ تعليقات");
    expect(deliveredOfRequestedAr(8, 10, "posts")).toBe("تم تسليم ٨ من ١٠ منشورات");
    expect(deliveredOfRequestedAr(8, 10, "tweets")).toBe("تم تسليم ٨ من ١٠ تغريدات");
  });

  it("the text collected before a stop uses the same rule", () => {
    expect(collectedBeforeStopText(8, 10)).toBe("جُمع ٨ من ١٠ سجلات قبل التوقف ولم يُخصم أي رصيد؛ تُستكمل عند إعادة المحاولة.");
    expect(collectedBeforeStopText(40, 100)).toContain("جُمع ٤٠ من ١٠٠ سجل قبل التوقف");
  });
});
