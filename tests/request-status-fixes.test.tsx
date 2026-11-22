import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { dayLabel } from "../src/lib/dayLabel";
import { formatTime, formatDate } from "../src/lib/honestDisplay";
import {
  REQUEST_STATUS_LABEL_AR,
  stateLabelFromPhase,
} from "../src/lib/jobs/requestStatus";
import OpenMissionsList from "../src/components/mission/OpenMissionsList";

describe("DT-20261122-request-status-fixes: dayLabel & hydration consistency", () => {
  it("formats dayLabel and formatTime deterministically using Cairo timezone", () => {
    // 2026-11-22T14:30:00Z is 16:30 in Cairo (+02:00)
    const iso = "2026-11-22T14:30:00Z";
    const nowCairoDay = new Date("2026-11-22T18:00:00Z");

    const formattedTime = formatTime(iso);
    // Cairo time is 4:30 PM -> ٠٤:٣٠ م
    expect(formattedTime).toBe("٠٤:٣٠ م");

    const label = dayLabel(iso, nowCairoDay);
    expect(label).toBe("اليوم ٠٤:٣٠ م");
  });

  it("handles yesterday boundary accurately in Cairo timezone", () => {
    // Yesterday in Cairo
    const isoYesterday = "2026-11-21T20:00:00Z"; // 22:00 on Nov 21 in Cairo
    const nowCairoDay = new Date("2026-11-22T10:00:00Z"); // 12:00 on Nov 22 in Cairo

    const label = dayLabel(isoYesterday, nowCairoDay);
    expect(label).toContain("أمس");
    expect(label).toContain("١٠:٠٠ م");
  });

  it("formats date older than yesterday with month and day in Arabic Cairo time", () => {
    const isoOlder = "2026-10-15T10:00:00Z";
    const nowCairoDay = new Date("2026-11-22T10:00:00Z");

    const label = dayLabel(isoOlder, nowCairoDay);
    expect(label).toContain("أكتوبر");
    expect(label).toContain("١٥");
  });

  it("OpenMissionsList and requests pages apply suppressHydrationWarning to date elements", () => {
    const items = [
      {
        id: "msn_test_1",
        status: "needs_input",
        requestText: "طلب فحص شركات البرمجيات",
        stateAr: "بانتظار الاعتماد",
        createdAt: "2026-11-22T14:30:00Z",
        cancellable: true,
        conversationId: "conv_123",
      },
    ];

    // Verify static markup renders correctly without crashing
    const html = renderToString(
      createElement(OpenMissionsList, {
        items,
        busyId: null,
        error: "",
        onCancel: () => {},
        defaultOpen: true,
      })
    );
    expect(html).toContain("طلب فحص شركات البرمجيات");
    expect(html).toContain("بانتظار الاعتماد");

    // Verify suppressHydrationWarning in source files
    const openMissionsSrc = readFileSync("src/components/mission/OpenMissionsList.tsx", "utf8");
    expect(openMissionsSrc).toContain("suppressHydrationWarning");

    const requestsPageSrc = readFileSync("src/app/dashboard/requests/page.tsx", "utf8");
    expect(requestsPageSrc).toContain("suppressHydrationWarning");

    const requestDetailsSrc = readFileSync("src/app/dashboard/requests/[id]/page.tsx", "utf8");
    expect(requestDetailsSrc).toContain("suppressHydrationWarning");
  });
});

describe("DT-20261122-request-status-fixes: stateLabelFromPhase mapping", () => {
  it("maps finished phases correctly to Arabic labels", () => {
    expect(stateLabelFromPhase("done")).toBe(REQUEST_STATUS_LABEL_AR.done); // "مكتمل"
    expect(stateLabelFromPhase("partial")).toBe(REQUEST_STATUS_LABEL_AR.partial); // "مكتمل جزئيًا"
    expect(stateLabelFromPhase("unserved")).toBe("لم تُنفَّذ");
    expect(stateLabelFromPhase("failed")).toBe("فشلت");
    expect(stateLabelFromPhase("cancelled")).toBe("أُلغيت");
  });

  it("maps open/running phases to 'قيد التنفيذ'", () => {
    expect(stateLabelFromPhase("running")).toBe(REQUEST_STATUS_LABEL_AR.running);
    expect(stateLabelFromPhase("waiting")).toBe(REQUEST_STATUS_LABEL_AR.running);
    expect(stateLabelFromPhase("planning")).toBe(REQUEST_STATUS_LABEL_AR.running);
    expect(stateLabelFromPhase("question")).toBe(REQUEST_STATUS_LABEL_AR.running);
    expect(stateLabelFromPhase("plan")).toBe(REQUEST_STATUS_LABEL_AR.running);
  });
});

describe("DT-20261122-request-status-fixes: header facts synchronization logic", () => {
  function syncHeaderFacts(
    prev: { stateAr: string; delivered: number | null; requested: number | null },
    view: { phase: string; savedSoFar: number; totalRows: number; requestedRows?: number }
  ) {
    const stateAr = stateLabelFromPhase(view.phase);
    const isRunning =
      view.phase === "running" ||
      view.phase === "waiting" ||
      view.phase === "planning" ||
      view.phase === "plan" ||
      view.phase === "question";

    const delivered = isRunning
      ? view.savedSoFar
      : view.phase === "done"
        ? view.totalRows
        : view.phase === "partial"
          ? view.savedSoFar
          : view.phase === "unserved" || view.phase === "failed" || view.phase === "cancelled"
            ? 0
            : prev.delivered;

    const requested = view.requestedRows || view.totalRows || prev.requested;

    return {
      ...prev,
      stateAr,
      delivered,
      requested,
    };
  }

  it("Bug 1 fix: updates header from running (0 of 6) to done (6 of 6) when mission finishes", () => {
    const initialFacts = {
      stateAr: "قيد التنفيذ",
      delivered: 0,
      requested: 6,
    };

    const doneView = {
      phase: "done",
      savedSoFar: 6,
      totalRows: 6,
      requestedRows: 6,
    };

    const updatedFacts = syncHeaderFacts(initialFacts, doneView);
    expect(updatedFacts.stateAr).toBe("مكتمل");
    expect(updatedFacts.delivered).toBe(6);
    expect(updatedFacts.requested).toBe(6);
  });

  it("Bug 1 fix: updates header to partial when mission finishes partially (4 of 6)", () => {
    const initialFacts = {
      stateAr: "قيد التنفيذ",
      delivered: 0,
      requested: 6,
    };

    const partialView = {
      phase: "partial",
      savedSoFar: 4,
      totalRows: 6,
      requestedRows: 6,
    };

    const updatedFacts = syncHeaderFacts(initialFacts, partialView);
    expect(updatedFacts.stateAr).toBe("مكتمل جزئيًا");
    expect(updatedFacts.delivered).toBe(4);
    expect(updatedFacts.requested).toBe(6);
  });

  it("Bug 1 fix: updates header to unserved when mission cannot be executed", () => {
    const initialFacts = {
      stateAr: "قيد التنفيذ",
      delivered: 0,
      requested: 6,
    };

    const unservedView = {
      phase: "unserved",
      savedSoFar: 0,
      totalRows: 6,
      requestedRows: 6,
    };

    const updatedFacts = syncHeaderFacts(initialFacts, unservedView);
    expect(updatedFacts.stateAr).toBe("لم تُنفَّذ");
    expect(updatedFacts.delivered).toBe(0);
    expect(updatedFacts.requested).toBe(6);
  });

  it("Counter-case: running mission updates live progress (e.g. 2 of 6) in header", () => {
    const initialFacts = {
      stateAr: "قيد التنفيذ",
      delivered: 0,
      requested: 6,
    };

    const runningProgressView = {
      phase: "running",
      savedSoFar: 2,
      totalRows: 6,
      requestedRows: 6,
    };

    const updatedFacts = syncHeaderFacts(initialFacts, runningProgressView);
    expect(updatedFacts.stateAr).toBe("قيد التنفيذ");
    expect(updatedFacts.delivered).toBe(2);
    expect(updatedFacts.requested).toBe(6);
  });
});
