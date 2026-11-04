import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { VersionListBody } from "../src/components/mission/VersionList";
import { VERSION_DOWNLOAD_BUTTON_AR, VERSION_DOWNLOAD_ERRORS_AR, VERSION_DOWNLOADING_AR, versionDownloadLabelAr, versionTitleAr, type VersionSummary } from "../src/lib/agentMission/stage4/versionLabels";
import { downloadVersionFile, versionFileUrl } from "../src/lib/agentMission/stage4/versionDownload";
import { checkCustomerLabel, checkCustomerText } from "../src/lib/agentMission/text";

/**
 * MONEY PR 7b, PHASE 2B-2 TASK 1: THE VERSION LIST WITH ITS DOWNLOAD BUTTON (docs/MONEY-PR-7A.md section 14). «النسخة ١ — الملف الأصلي», «النسخة ٢ — بعد التعديل», the date, and «تحميل الملف». The click is a pure function with
 * injected `fetch` and `save` (no browser needed): loading, success and every failure answer are tested here. Arabic only, Arabic-Indic numerals, no emoji, no provider, no money.
 */
const MISSION = "msn_5851abc92a1e6645a9cd";
const rows: VersionSummary[] = [
  { version: 1, parent: null, reason: "delivery", createdAt: "2026-11-02T12:00:00.000Z", digest: "a".repeat(64) },
  { version: 2, parent: 1, reason: "edit", createdAt: "2026-11-03T09:30:00.000Z", digest: "b".repeat(64) },
  { version: 3, parent: 2, reason: "review_fix", createdAt: "2026-11-03T10:30:00.000Z", digest: "c".repeat(64) },
];
const render = (props: Partial<Parameters<typeof VersionListBody>[0]> = {}) => renderToStaticMarkup(createElement(VersionListBody, { versions: rows, onDownload: () => {}, ...props }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("the labels", () => {
  it("«النسخة ١ — الملف الأصلي», «النسخة ٢ — بعد التعديل», and the review correction", () => {
    expect(versionTitleAr(1, "delivery")).toBe("النسخة ١ — الملف الأصلي");
    expect(versionTitleAr(2, "edit")).toBe("النسخة ٢ — بعد التعديل");
    expect(versionTitleAr(3, "review_fix")).toBe("النسخة ٣ — بعد تصحيح المراجعة");
    expect(VERSION_DOWNLOAD_BUTTON_AR).toBe("تحميل الملف");
    expect(versionDownloadLabelAr(2)).toContain("تحميل الملف");
    expect(versionDownloadLabelAr(2)).toContain("النسخة ٢");
  });
  it("every sentence it can show passes the customer-text rules (numbers up to a hundred, every reason), with no Latin digit", () => {
    const all: string[] = [VERSION_DOWNLOAD_BUTTON_AR, VERSION_DOWNLOADING_AR, ...Object.values(VERSION_DOWNLOAD_ERRORS_AR)];
    for (let n = 1; n <= 100; n += 1) { for (const r of ["delivery", "edit", "review_fix"] as const) all.push(versionTitleAr(n, r)); all.push(versionDownloadLabelAr(n)); }
    for (const s of all) { expect(checkCustomerText(s).issues, s).toEqual([]); expect(checkCustomerLabel(s).issues, s).toEqual([]); expect(s, s).not.toMatch(/[0-9]/); expect(s, s).not.toMatch(/\p{Extended_Pictographic}/u); }
  });
});

describe("TEST 13: the list is usable on a phone", () => {
  it("each published version has its number, its kind, its date and an accessible download button; Arabic-Indic numerals only", () => {
    const html = render();
    for (const r of rows) expect(html).toContain(versionTitleAr(r.version, r.reason));
    expect(html.match(/data-testid="version-row"/g)).toHaveLength(3);
    expect(html.match(/<button/g)).toHaveLength(3);
    expect(html.match(/>تحميل الملف</g)).toHaveLength(3);
    for (const r of rows) expect(html).toContain(`aria-label="${versionDownloadLabelAr(r.version)}"`);
    expect(html.match(/type="button"/g)).toHaveLength(3);
    expect(text(html)).not.toMatch(/[0-9]/);
    expect(html).not.toMatch(/<a |href=/);
  });
  it("a touch-sized button (at least 44px), rows that wrap and a button that takes the full width on a small screen", () => {
    const html = render();
    expect(html).toMatch(/<button[^>]*class="[^"]*\bmin-h-11\b/);
    expect(html).toMatch(/<button[^>]*class="[^"]*\bw-full\b[^"]*\bsm:w-auto\b/);
    expect(html).toMatch(/<li[^>]*class="[^"]*\bflex-col\b[^"]*\bsm:flex-row\b/);
    expect(html).toMatch(/focus-visible:outline/);
  });
  it("while a version is downloading its button is disabled and says so, and only that one", () => {
    const html = render({ busy: 2 });
    expect(html.match(/disabled=""/g)).toHaveLength(1);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain(VERSION_DOWNLOADING_AR);
    expect(html.match(/>تحميل الملف</g)).toHaveLength(2);
  });
  it("a failed download shows its Arabic message under that version, as an alert, and no other row", () => {
    const html = render({ failed: { version: 2, message: VERSION_DOWNLOAD_ERRORS_AR.unavailable } });
    expect(html.match(/role="alert"/g)).toHaveLength(1);
    expect(html).toContain(VERSION_DOWNLOAD_ERRORS_AR.unavailable);
    expect(html.indexOf("role=\"alert\"")).toBeGreaterThan(html.indexOf(versionTitleAr(2, "edit")));
    expect(html.indexOf("role=\"alert\"")).toBeLessThan(html.indexOf(versionTitleAr(3, "review_fix")));
  });
  it("only what the versions route lists is drawn: nothing for no version, no pending or internal word, no price", () => {
    expect(renderToStaticMarkup(createElement(VersionListBody, { versions: [] }))).toBe("");
    const t = text(render());
    expect(t).not.toMatch(/pending|freeze|addon|digest|supabase|openai|anthropic|\$|USD|نقطة|نقاط|سعر|دولار/i);
  });
});

describe("the click: one pure function with injected fetch and save", () => {
  const xlsx = () => new Response(Buffer.from("PK\u0003\u0004data"), { status: 200, headers: { "Content-Disposition": "attachment; filename=\"a.xlsx\"; filename*=UTF-8''%D8%AA%D8%B9%D9%84%D9%8A%D9%82%D8%A7%D8%AA%20-%20%D8%A7%D9%84%D9%86%D8%B3%D8%AE%D8%A9%20%D9%A2.xlsx" } });
  it("asks exactly the version route of its own mission with the bearer token, then hands the file to save under the server's name", async () => {
    const fetchFn = vi.fn(async () => xlsx());
    const save = vi.fn();
    const r = await downloadVersionFile({ missionId: MISSION, version: 2, fetchFn: fetchFn as any, headers: async () => ({ Authorization: "Bearer t" }), save });
    expect(r).toEqual({ ok: true });
    expect(versionFileUrl(MISSION, 2)).toBe(`/api/missions/${MISSION}/file?name=result.xlsx&version=2&stream=1`);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((fetchFn.mock.calls[0] as unknown as [string, any])[0]).toBe(versionFileUrl(MISSION, 2));
    expect((fetchFn.mock.calls[0] as unknown as [string, any])[1].headers).toEqual({ Authorization: "Bearer t" });
    expect(save).toHaveBeenCalledTimes(1);
    expect((save.mock.calls[0] as any[])[1]).toBe("تعليقات - النسخة ٢.xlsx");
  });
  it("every failure is a controlled Arabic message and nothing is saved: 404, 503, 500, 401, 400, a network error, an unreadable body", async () => {
    const answers: Array<[string, () => Promise<Response>, string]> = [
      ["404", async () => new Response(JSON.stringify({ success: false, error: "not_found" }), { status: 404 }), VERSION_DOWNLOAD_ERRORS_AR.not_found],
      ["503", async () => new Response("{}", { status: 503 }), VERSION_DOWNLOAD_ERRORS_AR.unavailable],
      ["500", async () => new Response("{}", { status: 500 }), VERSION_DOWNLOAD_ERRORS_AR.damaged],
      ["401", async () => new Response("{}", { status: 401 }), VERSION_DOWNLOAD_ERRORS_AR.unauthorized],
      ["400", async () => new Response("{}", { status: 400 }), VERSION_DOWNLOAD_ERRORS_AR.unavailable],
      ["network", async () => { throw new TypeError("fetch failed"); }, VERSION_DOWNLOAD_ERRORS_AR.network],
      ["body", async () => ({ ok: true, status: 200, headers: new Headers(), blob: async () => { throw new Error("cut"); } }) as unknown as Response, VERSION_DOWNLOAD_ERRORS_AR.network],
    ];
    for (const [label, fetchFn, message] of answers) {
      const save = vi.fn();
      const r = await downloadVersionFile({ missionId: MISSION, version: 1, fetchFn, headers: async () => ({}), save });
      expect(r, label).toEqual({ ok: false, message });
      expect(save, label).not.toHaveBeenCalled();
      expect(checkCustomerText(message).issues, label).toEqual([]);
    }
  });
  it("it refuses to ask for a version number that is not a positive whole number", async () => {
    const fetchFn = vi.fn();
    for (const v of [0, -1, 1.5, Number.NaN, 10000]) expect(await downloadVersionFile({ missionId: MISSION, version: v, fetchFn: fetchFn as any, headers: async () => ({}), save: vi.fn() })).toMatchObject({ ok: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
