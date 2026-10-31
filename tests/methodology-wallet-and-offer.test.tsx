import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "./helpers/fakeSupabase";

// the suite lowers the job cap to 600 through the environment, and the estimate reads it when its module is loaded; section 3 checks the figures of the production default (25,000), so the variable is cleared before the imports
const state = vi.hoisted(() => { process.env.JOB_MAX_POINTS_CAP = ""; return { user: null as any, admin: null as any }; });
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })) } })),
  createAdminClient: vi.fn(() => state.admin),
}));

import { GET as walletHistory } from "../src/app/api/wallet/history/route";
import { calculateBalance } from "../src/lib/supabase/ledger";
import { METHODOLOGY_CHARGE_PREFIX, groupMissionRows, isMethodologyChargeId, jobLedgerTotals, methodologyPurchaseLineAr } from "../src/lib/walletView";
import { methodologyChargeId, methodologyOffered } from "../src/lib/methodologyOffer";
import { ESTIMATE_MAX_VOLUME, estimateFormProblemAr, estimateMission } from "../src/lib/missionEstimate";

const src = (file: string) => readFileSync(file, "utf8");

// ================================================================================================================ 1. the methodology purchase is its own wallet line
describe("1. wallet: the methodology purchase (chg_meth_<job id>) is a line of its own; the job's delivery line sums only its settlement rows", () => {
  // the three legacy jobs of the ledger (read-only rows, 2026-10-15 / 2026-10-20 / 2026-10-24): the stored delivery charge is 30, 9 and 789; the methodology purchase is a separate 10
  const JOBS = [
    { user: "47693c59-89f1-405d-bec1-e72271517870", job: "job_quote_a3c3cfb336561dbdf6db254e50410952", day: "2026-10-15", res: 35, chg: 30, delivered: 10, at: ["22:39:55.285515", "22:40:02.459075", "22:50:23.258201"] },
    { user: "b0d08be8-db61-4860-841e-fa963045557e", job: "job_quote_6eac10b4fed6c6c4cae72323cf3915d2", day: "2026-10-20", res: 11, chg: 9, delivered: 3, at: ["06:17:55.077197", "06:18:28.093043", "06:20:27.141304"] },
    { user: "f0db9918-9b0b-464b-964a-17533cdbdb72", job: "job_quote_8b49da80a3e1992bebb48235a2c7a354", day: "2026-10-24", res: 2973, chg: 789, delivered: 61, at: ["07:32:16.109376", "07:35:05.857349", "10:08:52.578571"] },
  ];
  const rowsOf = (j: (typeof JOBS)[number]) => [
    { id: `res_${j.job}`, user_id: j.user, delta: -j.res, type: "reserve", job_id: j.job, note: "حجز رصيد للطلب", created_at: `${j.day} ${j.at[0]}+00` },
    { id: `chg_${j.job}`, user_id: j.user, delta: -j.chg, type: "charge", job_id: j.job, note: "خصم تكلفة النتائج المسلمة", created_at: `${j.day} ${j.at[1]}+00` },
    { id: `rel_${j.job}`, user_id: j.user, delta: j.res, type: "release", job_id: j.job, note: "إرجاع الحجز عند التسوية النهائية للمهمة", created_at: `${j.day} ${j.at[1]}+00` },
    { id: `chg_meth_${j.job}`, user_id: j.user, delta: -10, type: "charge", job_id: j.job, note: `شراء صياغة المنهجية الأكاديمية للطلب ${j.job}`, created_at: `${j.day} ${j.at[2]}+00` },
  ];
  const historyOf = async (user: string, tables: Record<string, any[]>) => {
    state.user = { id: user, email: "c@x.test", app_metadata: {}, user_metadata: {} };
    state.admin = fakeSupabase({ missing: ["credit_ledger_typed"], tables }) as any;
    return (await (await walletHistory(new NextRequest("http://localhost/api/wallet/history"))).json()).rows as any[];
  };
  const entriesOf = (rows: any[]) => groupMissionRows(rows.map((r) => ({ ...r, $id: r.id })));

  it("the 2026-10-15 job (stored 30, ledger 40 with the purchase): two lines, the delivery line 30 and the purchase line 10", async () => {
    const j = JOBS[0];
    const rows = await historyOf(j.user, { credit_ledger: rowsOf(j), missions: [], jobs: [{ id: j.job, user_id: j.user, status: "completed", delivered_units: j.delivered, charged_credits: 30, reserved_credits: 35 }] });
    expect(rows).toHaveLength(4);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    // the three settlement rows carry the delivery line, which says 30 (not 40)
    for (const id of [`res_${j.job}`, `chg_${j.job}`, `rel_${j.job}`]) expect(byId[id].missionLineAr).toBe("خُصم ٣٠ نقطة مقابل ١٠ عناصر");
    // the purchase row has no delivery line and says what it is, with no internal id in its note
    const meth = byId[`chg_meth_${j.job}`];
    expect(meth.missionLineAr).toBeNull();
    expect(meth.labelAr).toBe("شراء المنهجية الرسمية للطلب: ١٠ نقاط");
    expect(meth.note).toBe("");
    expect(JSON.stringify(rows)).not.toMatch(/"note":"[^"]*job_quote/);
    const entries = entriesOf(rows);
    expect(entries.map((e) => e.kind).sort()).toEqual(["mission", "row"]);
    const group = entries.find((e) => e.kind === "mission") as Extract<(typeof entries)[number], { kind: "mission" }>;
    const single = entries.find((e) => e.kind === "row") as Extract<(typeof entries)[number], { kind: "row" }>;
    expect(group.rows.map((r: any) => r.id).sort()).toEqual([`chg_${j.job}`, `rel_${j.job}`, `res_${j.job}`].sort());
    expect(group.rows.reduce((n, r: any) => n + r.delta, 0)).toBe(-30);
    expect((single.row as any).id).toBe(`chg_meth_${j.job}`);
    expect((single.row as any).delta).toBe(-10);
  });

  it("the three affected jobs read 30, 9 and 789, each with a separate purchase line of 10", async () => {
    const lines: string[] = [];
    for (const j of JOBS) {
      const rows = await historyOf(j.user, { credit_ledger: rowsOf(j), missions: [], jobs: [{ id: j.job, user_id: j.user, status: "completed", delivered_units: j.delivered }] });
      lines.push([...new Set(rows.filter((r) => r.missionLineAr).map((r) => r.missionLineAr))].join(""));
      expect(entriesOf(rows)).toHaveLength(2);
    }
    expect(lines).toEqual(["خُصم ٣٠ نقطة مقابل ١٠ عناصر", "خُصم ٩ نقاط مقابل ٣ عناصر", "خُصم ٧٨٩ نقطة مقابل ٦١ عنصرًا"]);
  });

  it("the sum of all the wallet's lines is still the balance (calculateBalance): the group nets and the single lines add up to every row's delta", async () => {
    const j = JOBS[0];
    const topup = { id: "top_t1", user_id: j.user, delta: 500, type: "topup", job_id: null, created_at: "2026-10-14 10:00:00+00" };
    const ledger = [topup, ...rowsOf(j)];
    const rows = await historyOf(j.user, { credit_ledger: ledger, missions: [], jobs: [{ id: j.job, user_id: j.user, status: "completed", delivered_units: j.delivered }] });
    const entries = entriesOf(rows);
    const linesTotal = entries.reduce((n, e) => n + (e.kind === "row" ? (e.row as any).delta : e.rows.reduce((m, r: any) => m + r.delta, 0)), 0);
    const balance = await calculateBalance(fakeSupabase({ tables: { credit_ledger: ledger } }) as any, j.user);
    expect(linesTotal).toBe(balance);
    expect(balance).toBe(500 - 40);
    // the job's own totals leave the purchase out (30 charged), the balance still has it
    const totals = jobLedgerTotals(ledger.map((r) => ({ id: r.id, jobId: r.job_id, type: r.type, delta: r.delta })));
    expect(totals.get(j.job)).toMatchObject({ reserved: 35, released: 35, charged: 30, net: -30, otherTypes: false, rows: 3 });
  });

  it("a job with no methodology row is unchanged: one group of its three rows, its line, and the totals as before", async () => {
    const j = JOBS[1];
    const settle = rowsOf(j).slice(0, 3);
    const rows = await historyOf(j.user, { credit_ledger: settle, missions: [], jobs: [{ id: j.job, user_id: j.user, status: "completed", delivered_units: j.delivered }] });
    expect(new Set(rows.map((r) => r.missionLineAr))).toEqual(new Set(["خُصم ٩ نقاط مقابل ٣ عناصر"]));
    const entries = entriesOf(rows);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("mission");
    expect(rows.every((r) => !String(r.labelAr).includes("المنهجية"))).toBe(true);
  });

  it("the row is recognised by its exact id prefix, never by the note: a charge noted «المنهجية» with an ordinary id stays in the job; a `chg_meth_` id with any note is the purchase", () => {
    const rows = [
      { id: "res_job_x", jobId: "job_x", type: "reserve", delta: -50 },
      { id: "rel_job_x", jobId: "job_x", type: "release", delta: 50 },
      { id: "chg_job_x", jobId: "job_x", type: "charge", delta: -20, note: "شراء صياغة المنهجية الأكاديمية للطلب" },
      { id: "chg_meth_job_x", jobId: "job_x", type: "charge", delta: -10, note: "خصم تكلفة النتائج المسلمة" },
    ];
    expect(jobLedgerTotals(rows).get("job_x")).toMatchObject({ reserved: 50, released: 50, charged: 20, net: -20, rows: 3 });
    expect(isMethodologyChargeId("chg_meth_job_x")).toBe(true);
    expect(isMethodologyChargeId("chg_job_x")).toBe(false);
    expect(isMethodologyChargeId("xchg_meth_job_x")).toBe(false);
    expect(isMethodologyChargeId(null)).toBe(false);
    // the prefix is the one the purchase function writes
    expect(methodologyChargeId("job_x").startsWith(METHODOLOGY_CHARGE_PREFIX)).toBe(true);
    expect(src("supabase/migrations/20261016002600_purchase_methodology_atomic.sql")).toContain(`'${METHODOLOGY_CHARGE_PREFIX}'`);
    expect(methodologyPurchaseLineAr(-10)).toBe("شراء المنهجية الرسمية للطلب: ١٠ نقاط");
    expect(methodologyPurchaseLineAr(-5)).toBe("شراء المنهجية الرسمية للطلب: ٥ نقاط");
  });

  it("the wallet page draws that line with the Cairo day and time and no internal note, and the purchase code is untouched (the route, the SQL function and the price)", () => {
    const page = src("src/app/dashboard/topup/page.tsx");
    expect(page).toContain("isMethodologyChargeId(row.id ?? row.$id)");
    expect(page).toContain("methodologyPurchaseLineAr(row.delta)");
    expect(page).toMatch(/compact \|\| isMethodologyRow\(l\) \? formatMomentCairo\(l\.createdAt\)/);
    expect(src("src/app/api/wallet/history/route.ts")).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(/);
    // the purchase itself is as it was: 10 points, the same function, the same deterministic id
    expect(src("src/app/api/jobs/[id]/methodology/route.ts")).toContain('adminClient.rpc("purchase_methodology_atomic"');
    expect(src("src/lib/methodologyOffer.ts")).toContain("export const METHODOLOGY_POINTS = 10;");
  });
});

// ================================================================================================================ 2. the methodology offer only where the purchase can work
describe("2. methodology offer: not shown where the purchase would be refused (no saved data)", () => {
  it("a finished job with delivered items and saved rows is offered; with no saved rows (a mission-era job: /data gives none) it is not", () => {
    expect(methodologyOffered({ status: "completed", delivered: 50, savedRows: 50 })).toBe(true);
    expect(methodologyOffered({ status: "done", delivered: 3, savedRows: 3 })).toBe(true);
    expect(methodologyOffered({ status: "completed", delivered: 50, savedRows: 0 })).toBe(false);
    expect(methodologyOffered({ status: "completed", delivered: 50, savedRows: undefined })).toBe(false);
  });

  it("the old conditions still hold (finished, something delivered), and a caller that does not pass the new field gets the old answer", () => {
    expect(methodologyOffered({ status: "running", delivered: 50, savedRows: 50 })).toBe(false);
    expect(methodologyOffered({ status: "completed", delivered: 0, savedRows: 50 })).toBe(false);
    expect(methodologyOffered({ status: "completed", delivered: 50 })).toBe(true);
    expect(methodologyOffered(null)).toBe(false);
  });

  it("the results panel passes the rows it loaded from the saved data to both places that draw the offer, and the route is not changed", () => {
    const panel = src("src/app/dashboard/chat/components/ResultsCanvas.tsx");
    expect(panel.match(/methodologyOffered\(\{ status: jobStatus, delivered: deliveredCount, savedRows: records\.length \}\)/g)).toHaveLength(2);
    // the rows come from /api/jobs/<id>/data, which reads the same candidate files the purchase reads
    const data = src("src/app/api/jobs/[id]/data/route.ts");
    const methodology = src("src/app/api/jobs/[id]/methodology/route.ts");
    for (const candidate of ["${jobDoc.user_id}/${jobId}/data.json", "${jobId}/data.json", "json_${jobId}"]) expect(data).toContain(candidate);
    expect(methodology).toContain("${jobDoc.user_id}/${jobId}/data.json");
    expect(methodology).toContain("تعذر العثور على بيانات الطلب المكتملة؛ لم يتم خصم أي نقاط.");
  });
});

// ================================================================================================================ 3. calculator note and over-limit wording
describe("3. calculator: the note and over-limit messages say the item's noun («النتائج» where no noun fits), never «سجل»", () => {
  // the numbers before this change (captured from the previous code): wording changes, these do not
  const GOLDEN: Array<[any, Record<string, number | boolean>]> = [
    [{ kind: "posts", platform: "x", volume: 50 }, { unitPricePoints: 0.11715, volume: 50, expectedPoints: 200, reservePoints: 200, maxVolumeInOneJob: 4500, jobsNeeded: 1, fitsInOneJob: true }],
    [{ kind: "comments", platform: "youtube", volume: 100 }, { unitPricePoints: 0.275, volume: 100, expectedPoints: 200, reservePoints: 200, maxVolumeInOneJob: 2000, jobsNeeded: 1, fitsInOneJob: true }],
    [{ kind: "videos", platform: "tiktok", volume: 1000 }, { unitPricePoints: 6, volume: 1000, expectedPoints: 6000, reservePoints: 6900, maxVolumeInOneJob: 200, jobsNeeded: 5, fitsInOneJob: false }],
    [{ kind: "posts", platform: "x", volume: 900000 }, { unitPricePoints: 0.11715, volume: 900000, expectedPoints: 105435, reservePoints: 121251, maxVolumeInOneJob: 4500, jobsNeeded: 200, fitsInOneJob: false }],
    [{ kind: "comments", platform: "facebook", volume: 800000 }, { unitPricePoints: 1.034, volume: 800000, expectedPoints: 827200, reservePoints: 951280, maxVolumeInOneJob: 1500, jobsNeeded: 534, fitsInOneJob: false }],
    [{ kind: "companies", volume: 20000 }, { unitPricePoints: 3.168, volume: 20000, expectedPoints: 63360, reservePoints: 72864, maxVolumeInOneJob: 500, jobsNeeded: 40, fitsInOneJob: false }],
    [{ kind: "people", volume: 5000 }, { unitPricePoints: 258, volume: 5000, expectedPoints: 1290000, reservePoints: 1483500, maxVolumeInOneJob: 96, jobsNeeded: 53, fitsInOneJob: false }],
    [{ kind: "comments", platform: "youtube", budgetPoints: 500 }, { unitPricePoints: 0.275, volume: 1581, expectedPoints: 435, reservePoints: 500, maxVolumeInOneJob: 2000, jobsNeeded: 1, fitsInOneJob: true }],
  ];

  it("no number, formula, cap or estimate changes: every figure of the result is what it was", () => {
    for (const [input, expected] of GOLDEN) expect(estimateMission(input), JSON.stringify(input)).toMatchObject({ status: "ok", ...expected });
  });

  it("the price note says «النتائج المطابقة», and the over-limit note names the item with the same number: ٤٥٠٠ تغريدة, ٢٠٠ فيديو, ١٥٠٠ تعليق, ٥٠٠ شركة, ٩٦ شخص", () => {
    const notes = (input: any) => (estimateMission(input).notesAr as string[]).join(" | ");
    expect(notes({ kind: "posts", platform: "x", volume: 50 })).toContain("يُخصم فقط مقابل النتائج المطابقة التي تصلك فعلًا");
    expect(notes({ kind: "posts", platform: "x", volume: 900000 })).toContain("يتسع حاليًا لحوالي ٤٥٠٠ تغريدة، فيلزم حوالي ٢٠٠ طلبات منفصلة");
    expect(notes({ kind: "videos", platform: "tiktok", volume: 1000 })).toContain("يتسع حاليًا لحوالي ٢٠٠ فيديو، فيلزم حوالي ٥ طلبات منفصلة");
    expect(notes({ kind: "comments", platform: "facebook", volume: 800000 })).toContain("يتسع حاليًا لحوالي ١٥٠٠ تعليق، فيلزم حوالي ٥٣٤ طلبات منفصلة");
    expect(notes({ kind: "companies", volume: 20000 })).toContain("يتسع حاليًا لحوالي ٥٠٠ شركة، فيلزم حوالي ٤٠ طلبات منفصلة");
    expect(notes({ kind: "people", volume: 5000 })).toContain("يتسع حاليًا لحوالي ٩٦ شخص (سقف الحجز ٢٥٠٠٠ نقطة)، فيلزم حوالي ٥٣ طلبات منفصلة");
  });

  it("the «write the number» notes and the form's over-limit message use the item's noun or none", () => {
    expect((estimateMission({ kind: "posts", platform: "x", volume: 0 }).notesAr as string[])[0]).toBe("اكتب العدد المطلوب أو ميزانيتك بالنقاط لنحسب لك التكلفة.");
    expect((estimateMission({ kind: "posts", platform: "x", volume: 0, openEnded: true }).notesAr as string[])[0]).toBe("الطلب المفتوح يحتاج حدًا أقصى: اكتب العدد المطلوب أو ميزانيتك بالنقاط.");
    expect(estimateFormProblemAr({ kind: "posts", platform: "x", volume: ESTIMATE_MAX_VOLUME + 1, budget: 0 })).toBe("الحد الأقصى للحساب هنا ١٠٠٠٠٠٠ تغريدة؛ اكتب عددًا أقل، أو قسّم طلبك على أكثر من طلب.");
    expect(estimateFormProblemAr({ kind: "comments", platform: "youtube", volume: ESTIMATE_MAX_VOLUME + 1, budget: 0 })).toContain("١٠٠٠٠٠٠ تعليق");
    expect(estimateFormProblemAr({ kind: "companies", platform: "n/a", volume: ESTIMATE_MAX_VOLUME + 1, budget: 0 })).toContain("١٠٠٠٠٠٠ شركة");
    // the bound itself is as it was
    expect(ESTIMATE_MAX_VOLUME).toBe(1_000_000);
    expect(estimateFormProblemAr({ kind: "posts", platform: "x", volume: ESTIMATE_MAX_VOLUME, budget: 0 })).toBeNull();
  });

  it("no message of the estimate says «سجل» / «السجلات» (the two estimates, every kind, the notes and the form problems), and no such word is left in the file's code", () => {
    const texts: string[] = [];
    for (const [input] of GOLDEN) texts.push(...(estimateMission(input).notesAr as string[]));
    texts.push(...(estimateMission({ kind: "posts", platform: "x", volume: 0 }).notesAr as string[]), ...(estimateMission({ kind: "people", volume: 0, openEnded: true }).notesAr as string[]));
    for (const kind of ["comments", "posts", "videos", "companies", "people"] as const) texts.push(estimateFormProblemAr({ kind, platform: kind === "companies" || kind === "people" ? "n/a" : "x", volume: ESTIMATE_MAX_VOLUME + 1, budget: 0 }) ?? "");
    for (const text of texts) expect(text).not.toMatch(/سجل/);
    const code = src("src/lib/missionEstimate.ts").split("\n").filter((line) => !/^\s*(?:\*|\/\/|\/\*)/.test(line));
    expect(code.filter((line) => /سجل/.test(line))).toEqual([]);
  });
});
