import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fileNameFromDisposition } from "../src/lib/downloadName";
import { methodologyChargeId, METHODOLOGY_POINTS } from "../src/lib/methodologyOffer";
import { replayMission } from "./helpers/missionReplay";
import { FB20, MISSIONS } from "./helpers/round14Missions";

/**
 * ROUND 21, item 3 (the purchase): the EXISTING route `/api/jobs/<jobId>/methodology` and the EXISTING ledger row `chg_meth_<jobId>` serve a delivered compiled mission. Price 50 points; ONE charge per mission; the re-download is free; a failure before the charge never charges; a page that showed another price is refused;
 * the file is served by the site under its own Arabic name (`Content-Disposition` with `filename*`). The database, storage and the purchase function are an in-memory fake that behaves as the real ones do (the real RPC refuses an unaffordable charge and an existing id).
 */
const world = vi.hoisted(() => ({
  user: "u1",
  job: null as null | Record<string, unknown>,
  mission: null as null | Record<string, unknown>,
  ledger: [] as Array<{ id: string; user_id: string; delta: number }>,
  balance: 1000,
  xlsx: null as null | Buffer,
  uploads: [] as Array<{ bucket: string; path: string; body: Buffer }>,
  removed: [] as string[],
  signed: [] as Array<{ bucket: string; path: string; download?: string }>,
  rpc: [] as Array<{ name: string; args: Record<string, unknown>; uploadsSoFar: number }>,
}));

vi.mock("../src/lib/supabase/server", () => {
  const rowsOf = (table: string): Array<Record<string, unknown>> => (table === "jobs" ? (world.job ? [world.job] : []) : table === "missions" ? (world.mission ? [world.mission] : []) : table === "credit_ledger" ? (world.ledger as unknown as Array<Record<string, unknown>>) : []);
  const from = (table: string) => {
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    const run = () => rowsOf(table).filter((r) => filters.every((f) => f(r)));
    const c: Record<string, unknown> = {
      select: () => c,
      eq: (col: string, v: unknown) => { filters.push((r) => r[col] === v); return c; },
      in: (col: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[col])); return c; },
      gt: () => c, order: () => c, limit: () => c,
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      single: async () => { const r = run()[0]; return r ? { data: r, error: null } : { data: null, error: { message: "not found" } }; },
      then: (resolve: (v: unknown) => unknown) => resolve({ data: run(), error: null }),
    };
    return c;
  };
  const storage = {
    from: (bucket: string) => ({
      download: async (path: string) => (bucket === "agent-missions" && world.xlsx ? { data: new Blob([new Uint8Array(world.xlsx)]), error: null } : { data: null, error: { message: "not found" } }),
      upload: async (path: string, body: Buffer) => { world.uploads.push({ bucket, path, body }); return { error: null }; },
      remove: async (paths: string[]) => { world.removed.push(...paths); return { error: null }; },
      createSignedUrl: async (path: string, _ttl: number, o?: { download?: string }) => { world.signed.push({ bucket, path, download: o?.download }); return { data: { signedUrl: `https://signed.example/${bucket}/${path}` }, error: null }; },
    }),
  };
  const rpc = async (name: string, args: Record<string, unknown>) => {
    world.rpc.push({ name, args, uploadsSoFar: world.uploads.length });
    if (name !== "purchase_methodology_atomic") return { data: null, error: null };
    const id = `chg_meth_${args.p_job_id}`;
    if (world.ledger.some((r) => r.id === id)) return { data: { success: true, already_purchased: true, balance: world.balance, charged: 0 }, error: null };
    if (world.balance < Number(args.p_amount)) return { data: { success: false, error: "insufficient_balance", balance: world.balance }, error: null };
    world.ledger.push({ id, user_id: String(args.p_user_id), delta: -Number(args.p_amount) });
    world.balance -= Number(args.p_amount);
    return { data: { success: true, already_purchased: false, balance: world.balance, charged: Number(args.p_amount) }, error: null };
  };
  return {
    createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: { id: world.user, app_metadata: {}, user_metadata: {} } }, error: null })) } })),
    createAdminClient: vi.fn(() => ({ from, storage, rpc })),
  };
});

import { GET, POST } from "../src/app/api/jobs/[id]/methodology/route";

const JOB = "job_m21_1";
const TITLE = "تعليقات منشورات قناة العربية - ٨ - ٤ نوفمبر ٢٠٢٦";
const MISSION_ROW = { id: "msn_aaaaaaaaaaaaaaaaaaaa", user_id: "u1", status: "completed", job_id: JOB, delivered_units: 10, request_text: "هات منشورين من صفحة قناة العربية", plan_public: { compiled: true }, files: [{ name: "result.xlsx", path: "result/result.xlsx", kind: "xlsx", download_name: `${TITLE}.xlsx` }] };
const call = (method: "POST" | "GET", body?: unknown, query = "") => {
  const req = new NextRequest(`http://localhost/api/jobs/${JOB}/methodology${query}`, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer t" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const ctx = { params: Promise.resolve({ id: JOB }) };
  return method === "POST" ? POST(req, ctx) : GET(req, ctx);
};
const buy = () => call("POST", { confirmed: true, expectedPoints: METHODOLOGY_POINTS });

let realXlsx: Buffer;
beforeAll(async () => {
  const input = MISSIONS.find((m) => m.id === FB20)!.input;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(input.readAt));
  realXlsx = (await replayMission(input)).built.xlsx;
  vi.useRealTimers();
}, 300_000);
afterAll(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

beforeEach(() => {
  world.user = "u1";
  world.job = { id: JOB, user_id: "u1", status: "completed", created_at: "2026-11-04T07:10:14Z" };
  world.mission = { ...MISSION_ROW };
  world.ledger = [];
  world.balance = 1000;
  world.xlsx = realXlsx;
  world.uploads = [];
  world.removed = [];
  world.signed = [];
  world.rpc = [];
});

describe("the price", () => {
  it("is 50 points everywhere it is stated: the route's constant, the screens' constant, and nothing else says ١٠ for the methodology", () => {
    expect(METHODOLOGY_POINTS).toBe(50);
    expect(readFileSync("src/app/api/jobs/[id]/methodology/route.ts", "utf8")).toContain("const METHODOLOGY_DEFAULT_POINTS = 50;");
    const dialog = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(dialog).not.toContain("مقابل ١٠ نقاط");
    expect(dialog).toContain("pointsAr(METHODOLOGY_POINTS)");
  });
  it("a request that does not name the price the page showed (an old tab) is refused before anything is read or charged", async () => {
    for (const body of [{ confirmed: true }, { confirmed: true, expectedPoints: 10 }, { confirmed: true, expectedPoints: "١٠" }]) {
      const res = await call("POST", body);
      const json = await res.json();
      expect(res.status).toBe(409);
      expect(json.priceChanged).toBe(true);
      expect(json.error).toContain("لم يتم خصم أي نقاط");
    }
    expect(world.rpc).toEqual([]);
    expect(world.uploads).toEqual([]);
    expect(world.ledger).toEqual([]);
  });
  it("no confirmation, no charge", async () => {
    const res = await call("POST", { expectedPoints: 50 });
    expect(res.status).toBe(400);
    expect(world.rpc).toEqual([]);
  });
});

describe("a delivered compiled mission: one charge of 50 points, the existing ledger row, a free re-download", () => {
  it("builds the PDF from the delivered file, saves it, charges 50 once on chg_meth_<job>, and answers with the Arabic name", async () => {
    const res = await buy();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.chargedPoints).toBe(50);
    expect(json.remainingBalance).toBe(950);
    expect(world.rpc).toHaveLength(1);
    expect(world.rpc[0].args).toMatchObject({ p_user_id: "u1", p_job_id: JOB, p_amount: 50 });
    expect(world.ledger).toEqual([{ id: methodologyChargeId(JOB), user_id: "u1", delta: -50 }]);
    expect(world.uploads).toHaveLength(1);
    expect(world.uploads[0]).toMatchObject({ bucket: "results", path: `u1/${JOB}/methodology-addon.pdf` });
    expect(world.uploads[0].body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(json.downloadName).toBe(`منهجية جمع البيانات - ${TITLE}.pdf`);
    expect(String(json.methodologyText)).toContain("ديجر.");
  });

  it("the money rules: the charge is made AFTER the file is built and saved (the one upload came first), never above the 50 the page showed, and only through the existing function", async () => {
    await buy();
    expect(world.rpc).toHaveLength(1);
    expect(world.rpc[0].uploadsSoFar).toBe(1);
    expect(world.rpc.every((r) => r.name === "purchase_methodology_atomic")).toBe(true);
    expect(Math.abs(world.ledger[0].delta)).toBeLessThanOrEqual(METHODOLOGY_POINTS);
    expect(Number(world.rpc[0].args.p_amount)).toBe(METHODOLOGY_POINTS);
  });

  it("idempotent: a second purchase of the same mission charges nothing (the ledger row exists), builds the file again and the balance is unchanged", async () => {
    await buy();
    world.uploads = [];
    world.rpc = [];
    const again = await (await buy()).json();
    expect(again.success).toBe(true);
    expect(again.chargedPoints).toBe(0);
    expect(world.rpc).toEqual([]);
    expect(world.ledger).toHaveLength(1);
    expect(world.balance).toBe(950);
    expect(world.uploads).toHaveLength(1);
  });

  it("not enough points: nothing is charged, the saved file is removed, and the answer says so", async () => {
    world.balance = 10;
    const res = await buy();
    const json = await res.json();
    expect(res.status).toBe(402);
    expect(json.insufficient_balance).toBe(true);
    expect(json.required).toBe(50);
    expect(world.ledger).toEqual([]);
    expect(world.removed).toEqual([`u1/${JOB}/methodology-addon.pdf`]);
  });

  it("the delivered file cannot be read: nothing is charged and nothing is saved", async () => {
    world.xlsx = null;
    const res = await buy();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("لم يتم خصم أي نقاط");
    expect(world.rpc).toEqual([]);
    expect(world.uploads).toEqual([]);
  });

  it("the delivered file has no methodology section (an older file): nothing is charged and nothing is saved", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("ملخص المهمة").addRow(["لا شيء"]);
    world.xlsx = Buffer.from(await wb.xlsx.writeBuffer());
    const res = await buy();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("لم يتم خصم أي نقاط");
    expect(world.rpc).toEqual([]);
    expect(world.uploads).toEqual([]);
  });

  it("another customer's job, and a job that is not finished, are refused before anything is read", async () => {
    world.user = "u2";
    expect((await buy()).status).toBe(403);
    world.user = "u1";
    world.job = { ...(world.job as object), status: "running" };
    expect((await buy()).status).toBe(409);
    expect(world.rpc).toEqual([]);
    expect(world.uploads).toEqual([]);
  });

  it("a job that is not a delivered compiled mission keeps the saved-data path: with no saved data it is refused and charges nothing", async () => {
    world.mission = { ...MISSION_ROW, plan_public: { compiled: false } };
    const res = await buy();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("بيانات الطلب");
    expect(world.rpc).toEqual([]);
  });
});

describe("the download: the site serves the bought file under its own Arabic name", () => {
  it("not bought: refused, nothing served", async () => {
    const res = await call("GET", undefined, "?file=1");
    expect(res.status).toBe(402);
  });
  it("bought: the PDF with Content-Disposition filename* (percent-encoded UTF-8) and an ASCII fallback; the storage link carries no download name", async () => {
    await buy();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(world.uploads[0].body, { status: 200 })));
    world.signed = [];
    const res = await call("GET", undefined, "?file=1");
    expect(res.status).toBe(200);
    const header = res.headers.get("Content-Disposition") ?? "";
    const m = /^attachment; filename="([\x20-\x7e]+)"; filename\*=UTF-8''((?:%[0-9A-F]{2}|[A-Za-z0-9._~!$&+^`|#-])+)$/.exec(header);
    expect(m, header).not.toBeNull();
    expect(m![1]).toMatch(/\.pdf$/);
    expect(decodeURIComponent(m![2])).toBe(`منهجية جمع البيانات - ${TITLE}.pdf`);
    expect(fileNameFromDisposition(header)).toBe(`منهجية جمع البيانات - ${TITLE}.pdf`);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(world.signed).toEqual([{ bucket: "results", path: `u1/${JOB}/methodology-addon.pdf`, download: undefined }]);
    // nothing is charged by a download
    expect(world.rpc).toHaveLength(1);
  });
  it("the plain status read (no file) says whether it was bought, as before", async () => {
    expect(await (await call("GET")).json()).toEqual({ success: true, purchased: false });
    await buy();
    expect(await (await call("GET")).json()).toEqual({ success: true, purchased: true });
  });
});
