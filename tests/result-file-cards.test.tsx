import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { onRequestFormats, producedFormats } from "../src/lib/producedFormats";
import { settleTimelineEvents } from "../src/lib/honestDisplay";
import ActivityTimeline from "../src/app/dashboard/chat/components/ActivityTimeline";
import { FilesSection } from "../src/app/dashboard/chat/components/RunSections";

const noop = () => {};
const render = (fileIds: any) => renderToStaticMarkup(createElement(FilesSection, {
  rows: 3, requested: 3, charged: 9, fileIds, downloadingKey: null, onDownload: noop, onOpenCanvas: noop, canvasOpen: false,
}));

describe("A1: result cards show only the formats produced for the quote", () => {
  it("an Excel-only quote produces one ready format and offers the others on request", () => {
    const ids = { xlsx: "u/job/result.xlsx", pdf: null, csv: null };
    expect(producedFormats(ids)).toEqual(["xlsx"]);
    expect(onRequestFormats(ids)).toEqual(["pdf", "csv"]);
  });

  it("every produced format is ready and nothing is left to request", () => {
    const ids = { xlsx: "a", pdf: "b", csv: "c" };
    expect(producedFormats(ids)).toEqual(["xlsx", "pdf", "csv"]);
    expect(onRequestFormats(ids)).toEqual([]);
  });

  it("an older job without an artifact record presents only the default Excel as ready", () => {
    expect(producedFormats(null)).toEqual(["xlsx"]);
    expect(producedFormats(undefined)).toEqual(["xlsx"]);
    expect(producedFormats({ xlsx: null, pdf: null, csv: null })).toEqual(["xlsx"]);
  });

  it("the rendered chat card for an Excel-only quote shows exactly one download card and offers nothing else", () => {
    const html = render({ xlsx: "u/job/result.xlsx", pdf: null, csv: null });
    expect(html.match(/↓/g)?.length).toBe(1);
    expect(html).toContain("إكسل");
    expect(html).toContain("جدول البيانات فقط");
    expect(html).not.toContain("البيانات + الدليل المنهجي");
    // Quality fixes item 6: formats the quote did not produce are not offered at all.
    expect(html).not.toContain("صيغ أخرى");
    expect(html).not.toContain("جهّز ملف");
    expect(html).not.toContain("بي دي إف");
    expect(html).not.toContain("سي إس في");
    expect(html).not.toMatch(/\bExcel\b|\bPDF\b|\bCSV\b/);
  });

  it("a quote that produced all three formats shows three ready cards and no on-request row", () => {
    const html = render({ xlsx: "a", pdf: "b", csv: "c" });
    expect(html.match(/↓/g)?.length).toBe(3);
    expect(html).not.toContain("صيغ أخرى تُجهَّز عند الطلب");
  });

  it("the canvas files tab and the terminal footer no longer hard-code three download buttons", () => {
    const canvas = readFileSync("src/app/dashboard/chat/components/ResultsCanvas.tsx", "utf8");
    const terminal = readFileSync("src/app/dashboard/chat/components/ActivityTerminal.tsx", "utf8");
    expect(canvas).toContain(".filter((f) => producedFormats(fileIds).includes(f.ext))");
    expect(terminal).not.toContain('onClick={() => onDownload("pdf")}');
    expect(terminal).toContain("producedFormats(fileIds).map");
    // No «on request» offers anywhere in the result surfaces.
    expect(canvas).not.toContain("onRequestFormats");
    expect(terminal).not.toContain("onRequestFormats");
    expect(canvas).not.toContain("تُجهَّز عند الطلب");
    expect(terminal).not.toContain("تُجهَّز عند الطلب");
  });

  it("the canvas report tab exists only when a PDF was produced", () => {
    const canvas = readFileSync("src/app/dashboard/chat/components/ResultsCanvas.tsx", "utf8");
    expect(canvas).toContain('producedFormats(fileIds).includes("pdf") ? [{ id: "pdf" as const');
    expect(canvas).not.toMatch(/^\s+\{ id: "pdf" as const, label: "التقرير" \},$/m);
  });

  it("the job data API reports the stored file ids and the produced formats from the latest artifact record", () => {
    const route = readFileSync("src/app/api/jobs/[id]/data/route.ts", "utf8");
    expect(route).toContain('.from("artifact_versions")');
    expect(route).toContain("fileIds,");
    expect(route).toContain("producedFormats: producedFormats(fileIds)");
  });

  it("a plain edit regenerates only the formats the job already has, and a format that was not generated stays empty", () => {
    const route = readFileSync("src/app/api/jobs/[id]/artifacts/route.ts", "utf8");
    expect(route).toContain("producedFormats(latest ?");
    expect(route).toContain('xlsx: formats.includes("xlsx") ?');
    expect(route).not.toContain('["xlsx", "pdf", "csv"];');
  });

  it("a format made on request still goes through the saved data with no provider call", () => {
    const download = readFileSync("src/app/api/jobs/[id]/download/route.ts", "utf8");
    expect(download).toContain("Prefer regenerating deliverable formats from the saved dataset");
    expect(download).toContain("linkArtifactVersion");
    expect(download).not.toMatch(/tregClient|providerGate|reserve_provider_spend/);
  });
});

describe("A6: a finished run clears the stale «collecting / preparing» status", () => {
  const events = [
    { id: "1", kind: "info", textAr: "تم قبول الطلب.", createdAt: "2026-01-01T10:00:00Z" },
    { id: "2", kind: "info", textAr: "جاري جمع البيانات...", createdAt: "2026-01-01T10:00:01Z" },
    { id: "3", kind: "info", textAr: "تم إكمال استخراج ٢ سجلًا.", createdAt: "2026-01-01T10:00:02Z" },
    { id: "4", kind: "info", textAr: "جاري تجهيز ملفات النتائج وتنسيقها...", createdAt: "2026-01-01T10:00:03Z" },
  ] as any[];

  it("drops in-progress lines once the job reached a final state and keeps them while it runs", () => {
    expect(settleTimelineEvents(events, "running")).toHaveLength(4);
    for (const status of ["done", "failed", "cancelled", "partial"]) {
      const settled = settleTimelineEvents(events, status);
      expect(settled.map((e) => e.id)).toEqual(["1", "3"]);
    }
  });

  it("the rendered timeline of a completed job has no «جاري» line left", () => {
    const html = renderToStaticMarkup(createElement(ActivityTimeline as any, {
      status: "done", events, rowsCollected: 2, requestedRows: 2, spentPoints: 1, reservedPoints: 0,
    }));
    expect(html).toContain("تم إكمال استخراج");
    expect(html).not.toContain("جاري تجهيز ملفات النتائج");
    expect(html).not.toContain("جاري جمع البيانات");
  });

  it("the rendered timeline of a running job still shows its progress lines", () => {
    const html = renderToStaticMarkup(createElement(ActivityTimeline as any, {
      status: "running", events, rowsCollected: 1, requestedRows: 2, spentPoints: 0, reservedPoints: 1,
    }));
    expect(html).toContain("جاري تجهيز ملفات النتائج");
  });

  it("the pulsing dot on the activity button stops when the job is finished", () => {
    const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(page).toContain('activeJob.status === "running" || activeJob.status === "queued" ? "bg-emerald-500 animate-pulse" : "bg-ok"');
  });
});
