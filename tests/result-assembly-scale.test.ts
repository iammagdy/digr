import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import v8 from "node:v8";
import vm from "node:vm";

vi.mock("../src/lib/supabase/server", async () => (await import("./helpers/scaleHarness")).supabaseServerMock());
vi.mock("../src/lib/server/sendPlatformEmail", async () => (await import("./helpers/scaleHarness")).sendPlatformEmailMock());
vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/functions/shared/catalogClient")>()),
  getEndpointDetails: vi.fn(async () => null),
  searchCatalog: vi.fn(async () => []),
}));

import { FakeProvider, calls, db, driveToTheEnd, installProvider, jobRow, seedSocialJob, setupEnv } from "./helpers/scaleHarness";
import { generateCsvReport, generateExcelReport } from "../src/functions/shared/fileGenerators";
import { scaleValue, setScaleOverridesForTesting } from "../src/lib/scaleConfig";

const comment = (i: number) => ({
  comment_id: `c_${i}`,
  text: `تعليق رقم ${i} على الفيديو وهو نص يحتوي على كلمات عربية متعددة لمحاكاة تعليق حقيقي ${i}`,
  create_time: 1_790_000_000 + i,
  digg_count: i % 7,
  video_url: `https://www.tiktok.com/@u/video/${7_300_000_000_000_000_000 + (i % 50)}`,
  author_name: `user_${i % 900}`,
});
const payload = (n: number, review = 0): any => ({
  metadata: { platform: "tiktok", socialKind: "comments", title: "تعليقات تيك توك", jobId: "j", collectedAt: "2026-10-20T12:00:00.000Z", template: "social-tiktok-comments" },
  rows: Array.from({ length: n }, (_, i) => comment(i)),
  uncertainRows: Array.from({ length: review }, (_, i) => ({ ...comment(100_000 + i), _relevance_reason: `سبب ${i}` })),
});

async function load(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  return wb;
}
const cellValues = (sheet: ExcelJS.Worksheet) => {
  const rows: unknown[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => rows.push((row.values as unknown[]).slice(1).map((v) => (v && typeof v === "object" && "text" in (v as any) ? { text: (v as any).text, hyperlink: (v as any).hyperlink } : v))));
  return rows;
};

afterEach(() => setScaleOverridesForTesting(null));

describe("a large comments workbook is written as a stream", () => {
  it("defaults: results up to 5,000 rows take the same in-memory path as before; 100,000 rows to a sheet", () => {
    expect(scaleValue("streamXlsxAboveRows", {})).toBe(5000);
    expect(scaleValue("rowsPerSheet", {})).toBe(100_000);
  });

  it("the streamed workbook holds exactly what the in-memory workbook holds: same sheets, header, cells, links, review sheet", async () => {
    setScaleOverridesForTesting({ streamXlsxAboveRows: 1_000_000 });
    const standard = await load(await generateExcelReport(payload(60, 3)));
    setScaleOverridesForTesting({ streamXlsxAboveRows: 0 });
    const streamed = await load(await generateExcelReport(payload(60, 3)));
    expect(streamed.worksheets.map((s) => s.name)).toEqual(standard.worksheets.map((s) => s.name));
    expect(streamed.worksheets.map((s) => s.name)).toEqual(["التعليقات", "سجلات تحتاج مراجعة"]);
    for (const [a, b] of streamed.worksheets.map((s, i) => [s, standard.worksheets[i]] as const)) {
      expect(cellValues(a)).toEqual(cellValues(b));
      expect(a.views[0]).toMatchObject({ state: "frozen", rightToLeft: true });
    }
    const data = streamed.getWorksheet("التعليقات")!;
    expect(data.rowCount).toBe(61);
    const links = cellValues(data).slice(1).flatMap((row) => row.filter((v) => v && typeof v === "object" && "hyperlink" in (v as any)));
    // One link per record: the video's. (The comment's own link column no longer repeats the video link.)
    expect(links.length).toBe(60);
  });

  it("a result larger than a sheet continues on the next sheet, each with its header, the record numbers running on", async () => {
    setScaleOverridesForTesting({ streamXlsxAboveRows: 0, rowsPerSheet: 25 });
    const wb = await load(await generateExcelReport(payload(60)));
    expect(wb.worksheets.map((s) => s.name)).toEqual(["التعليقات ١", "التعليقات ٢", "التعليقات ٣"]);
    expect(wb.worksheets.map((s) => s.rowCount)).toEqual([26, 26, 11]);
    const header = cellValues(wb.worksheets[0])[0];
    for (const sheet of wb.worksheets) expect(cellValues(sheet)[0]).toEqual(header);
    const ids = wb.worksheets.flatMap((sheet) => cellValues(sheet).slice(1).map((row) => row[0]));
    expect(ids).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
  });

  it("memory stays low: the peak while writing 30,000 rows is a fraction of the in-memory workbook's", async () => {
    v8.setFlagsFromString("--expose-gc");
    const gc: () => void = vm.runInNewContext("gc");
    const peakMb = async (rows: number, stream: boolean) => {
      setScaleOverridesForTesting({ streamXlsxAboveRows: stream ? 0 : 1_000_000 });
      const data = payload(rows);
      gc();
      const before = process.memoryUsage().heapUsed;
      let peak = 0;
      const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().heapUsed - before); }, 2);
      const buffer = await generateExcelReport(data);
      clearInterval(timer);
      peak = Math.max(peak, process.memoryUsage().heapUsed - before);
      expect(buffer.length).toBeGreaterThan(50_000);
      return peak / 1e6;
    };
    const large = await peakMb(30_000, true);
    const standard = await peakMb(30_000, false);
    process.stdout.write(`MEM streamed30k=${large.toFixed(0)}MB inMemory30k=${standard.toFixed(0)}MB\n`);
    expect(large).toBeLessThan(standard * 0.5);
    expect(large).toBeLessThan(250);
  }, 180_000);
});

describe("the CSV is written in blocks with exactly the same content", () => {
  it("BOM, header, one line per record, final newline; the same line for a record whether it is alone or among thousands", () => {
    const many = generateCsvReport(payload(4500)).toString("utf-8");
    expect(many.charCodeAt(0)).toBe(0xfeff);
    const lines = many.split("\n");
    expect(lines).toHaveLength(4500 + 2); // header + records + the empty piece after the final newline
    expect(lines[lines.length - 1]).toBe("");
    const alone = generateCsvReport(payload(1)).toString("utf-8").split("\n");
    expect(lines[1]).toBe(alone[1]);
    expect(lines[0]).toBe(alone[0]);
    // a record at each block edge (blocks are 2,000 records)
    for (const index of [1999, 2000, 2001, 3999, 4000]) {
      const single = generateCsvReport({ ...payload(1), rows: [comment(index)] }).toString("utf-8").split("\n")[1];
      // the record number (first field) follows the position in the file; everything after it is the same
      expect(lines[1 + index].replace(/^"[^"]*",/, "")).toBe(single.replace(/^"[^"]*",/, ""));
    }
  });

  it("no records: the header and the same two newlines as before", () => {
    const empty = generateCsvReport(payload(0)).toString("utf-8");
    expect(empty.endsWith("\n\n")).toBe(true);
    expect(empty.split("\n")).toHaveLength(3);
  });
});

describe("a big job through the real worker produces the streamed workbook and the CSV, settled once", () => {
  let restore: () => void;
  beforeEach(() => { restore = setupEnv(); });
  afterEach(() => { setScaleOverridesForTesting(null); restore(); });

  it("600 comments, three sheets of 250: every record in the file once, the file matches the delivered count, one settlement", async () => {
    setScaleOverridesForTesting({ absoluteMaxPages: 100, streamXlsxAboveRows: 100, rowsPerSheet: 250 });
    installProvider(new FakeProvider({ commentsPerVideo: 150, videos: 4, pageSize: 20 }));
    const jobId = seedSocialJob({ target: 600, videoCount: 4, perVideo: 150, outputFormats: ["csv", "xlsx"] });
    const run = await driveToTheEnd(jobId, { maxTicks: 60 });
    expect(run.finalStatus).toBe("completed");
    expect(calls("settle_job_atomic")).toHaveLength(1);
    expect(calls("release_job_atomic")).toHaveLength(0);
    const job = jobRow(jobId);
    expect(job.delivered_units).toBe(600);
    expect(job.charged).toBe(Math.min(Math.ceil(600 * db.unitPrice), db.reserved));

    const xlsx = db.results.get(`user_1/${jobId}/result.xlsx`)!;
    const csv = db.results.get(`user_1/${jobId}/result.csv`)!;
    expect(xlsx).toBeTruthy();
    expect(csv).toBeTruthy();
    const wb = await load(xlsx);
    expect(wb.worksheets.map((s) => s.name)).toEqual(["التعليقات ١", "التعليقات ٢", "التعليقات ٣"]);
    expect(wb.worksheets.reduce((sum, s) => sum + s.rowCount - 1, 0)).toBe(600);
    expect(csv.toString("utf-8").split("\n").length).toBe(600 + 2);
  }, 60_000);
});
