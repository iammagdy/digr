import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseRelativeAge } from "../src/lib/agentMission/relativeDates";
import { DATE_PRECISION_APPROX_AR, DATE_PRECISION_TITLE_AR } from "../src/lib/agentMission/relativeDates";
import { replayMission, type MissionReplay } from "./helpers/missionReplay";

/**
 * ROUND 14, part C: `published_time` ARRIVED IN ENGLISH on the real pages of live round 12 (msn_5d5a9b2a933aeaa47d81: the comments tool asked with `language_code: "en"`). On its 123 stored comment rows: «11 months ago» 120 times, «9 months ago» twice, «11 months ago (edited)» once (the form of round 13 that was then only synthetic);
 * the replies tool's `publishedTime` is «11 months ago» on all 4. The videos' own dates are «N years ago», «Streamed 6 years ago» and «11 months ago». No Chinese text anywhere. This test reads the real pages and the file the code builds from them: every date is read, and the round-12 file now says «تقريبي».
 */
const M = "msn_5d5a9b2a933aeaa47d81";
const raw = (n: number) => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${M}/raw/call_${String(n).padStart(4, "0")}.json`, import.meta.url), "utf8"));
const READ = Date.parse("2026-11-03T15:52:30Z");

describe("the real English texts", () => {
  it("the comments' published_time is English («11 months ago», «9 months ago», «11 months ago (edited)»), never Chinese, and every one is read", () => {
    const texts: string[] = [];
    for (const n of [6, 7, 8, 9, 10, 11, 12, 13]) for (const c of raw(n).data.comments) texts.push(String(c.published_time));
    expect(new Set(texts)).toEqual(new Set(["11 months ago", "9 months ago", "11 months ago (edited)"]));
    expect(texts.length).toBe(123);
    for (const t of texts) { expect(t).not.toMatch(/[　-鿿]/); expect(parseRelativeAge(t, READ), t).not.toBeNull(); }
  });
  it("the replies' publishedTime and the videos' published_time are read too (years, «Streamed 6 years ago»)", () => {
    for (const n of [14, 15, 16]) for (const c of raw(n).output.data.comments) expect(parseRelativeAge(String(c.publishedTime), READ)).not.toBeNull();
    for (const n of [3, 4]) for (const v of raw(n).data.videos) expect(parseRelativeAge(String(v.published_time), READ), String(v.published_time)).not.toBeNull();
  });
});

describe("the round-12 file, rebuilt from the real pages with the code of this PR", () => {
  let r: MissionReplay;
  let sheets: Record<string, string[][]>;
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(READ));
    r = await replayMission({ fixture: M, request: "هات فيديوهين على يوتيوب عن نهائي السوبر المصري الأهلي والزمالك من القنوات الرسمية، مع كل التعليقات والردود.", createdAt: "2026-11-03T15:44:11Z", planningAt: "2026-11-03T15:51:30Z", readAt: "2026-11-03T15:52:30Z", platform: "youtube", occurrence: { kind: "latest" },
      replay: { only: { "tikhub.youtube.video.comments": ["video_id", "continuation_token"], "tikhub.x.youtube-web-search-channel": ["channel_id"] }, cut80: { "tikhub.youtube.video.comments": ["continuation_token"], "anyapi.youtube.comment_replies": ["continuationToken"] } },
      adjustPlan: (plan) => { const s = plan.stages.find((x) => x.key === "videos")!; const pool = [...(s.pinned_rows ?? []), ...(s.spare_rows ?? [])]; const LIVE = ["gCut2DcB9sM", "GIWkArP7RJE"]; s.pinned_rows = LIVE.map((id) => pool.find((x) => String(x.id) === id)!); s.spare_rows = pool.filter((x) => !LIVE.includes(String(x.id))); for (const st of plan.stages) if (st.parent_key === "videos") st.parent_pins = LIVE; } });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.built.xlsx as never);
    sheets = {};
    wb.eachSheet((ws) => { const rows: string[][] = []; ws.eachRow((row) => { const cells: string[] = []; row.eachCell({ includeEmpty: true }, (c) => cells.push(c.value instanceof Date ? c.value.toISOString().slice(0, 10) : String(c.value ?? ""))); rows.push(cells); }); sheets[ws.name] = rows; });
  }, 240_000);
  afterAll(() => { vi.useRealTimers(); });

  it("every comment and reply row has a date and «دقة التاريخ» = «تقريبي»: 99 of 99 (95 comments and 4 replies), none empty, none «دقيق»", () => {
    const rows = sheets["التعليقات"];
    const head = rows[0];
    const date = head.indexOf("تاريخ ووقت التعليق");
    const precision = head.indexOf(DATE_PRECISION_TITLE_AR);
    expect(date).toBeGreaterThanOrEqual(0);
    expect(precision).toBe(date + 1);
    const body = rows.slice(1);
    expect(body).toHaveLength(99);
    expect(body.every((x) => x[precision] === DATE_PRECISION_APPROX_AR)).toBe(true);
    expect(body.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x[date]))).toBe(true);
    expect(new Set(body.map((x) => x[date]))).toEqual(new Set(["2025-12-03", "2026-02-02"]));
  });
  it("the videos' dates are marked too, and the limits say how many dates are approximate", () => {
    const videos = sheets["الفيديوهات"];
    const precision = videos[0].indexOf(DATE_PRECISION_TITLE_AR);
    expect(precision).toBeGreaterThan(0);
    expect(videos.slice(1).every((x) => x[precision] === DATE_PRECISION_APPROX_AR)).toBe(true);
    const summary = sheets[Object.keys(sheets)[0]].flat().join("\n");
    expect(summary).toContain("٩٥ من ٩٥ تاريخًا تقريبيًا");
    expect(summary).toContain("٢ من ٢ تاريخًا تقريبيًا");
    expect(r.built.contract.violations).toEqual([]);
  });
});
