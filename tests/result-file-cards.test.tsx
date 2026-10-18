import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { onRequestFormats, producedFormats } from "../src/lib/producedFormats";
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

  it("the rendered chat card for an Excel-only quote has one download card and the others as «generate on request»", () => {
    const html = render({ xlsx: "u/job/result.xlsx", pdf: null, csv: null });
    // One ready-file card (it carries the download arrow), described as data only.
    expect(html.match(/↓/g)?.length).toBe(1);
    expect(html).toContain("جدول البيانات فقط");
    expect(html).not.toContain("البيانات + الدليل المنهجي");
    // The unproduced formats are offered on request, not shown as ready cards.
    expect(html).toContain("صيغ أخرى تُجهَّز عند الطلب");
    expect(html).toContain("جهّز ملف بي دي إف");
    expect(html).toContain("جهّز ملف سي إس في");
    expect(html).not.toContain("جهّز ملف إكسل");
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
