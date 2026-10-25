import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REQUEST_STATUS_LABEL_AR, collectedBeforeStopText, partialDeliveryText, resolveRequestKind } from "../src/lib/jobs/requestStatus";

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
    expect(partialDeliveryText(4, 5)).toBe("تم تسليم ٤ من ٥ سجلاً؛ الخصم يقتصر على السجلات المسلّمة المطابقة.");
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
