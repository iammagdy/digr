import { describe, expect, it, vi } from "vitest";
import { readWorkbook, replay, type ReplayResult } from "./helpers/agentReplay";
import { dispatcher, planFlow, SECTOR_WORLD } from "./helpers/g1World";

/**
 * INTEGRATION OF STAGE 2 + STAGE 3 + STAGE 4 ON main (integration-readiness round): the three stages are independent siblings of main and each is proved alone. This runs ONE whole companies mission (plan, engine, settlement, file: fakes only, no provider, no
 * payment) under every combination that matters and pins what must NOT depend on the flags: the money (one reserve, one release, at most one charge, never above the hold) and the delivered Excel are identical with the Stage 2 live sheet and the Stage 4 version
 * store on or off; the live DONE snapshot and the stored version 1 equal the delivered file; nothing is written for a stage whose flag is off. Stage 3 (companies by code) changes the file's cells on purpose, so it is compared with itself.
 */
type Combo = { name: string; s2: boolean; s3: boolean; s4: boolean };
const COMBOS: Combo[] = [
  { name: "all OFF", s2: false, s3: false, s4: false },
  { name: "Stage 2 live sheet ON", s2: true, s3: false, s4: false },
  { name: "Stage 4 versions ON", s2: false, s3: false, s4: true },
  { name: "Stage 3 companies ON", s2: false, s3: true, s4: false },
  { name: "Stage 2 + 3 + 4 ALL ON", s2: true, s3: true, s4: true },
];

const run = (c: Combo): Promise<ReplayResult> => {
  vi.stubEnv("DIGER_STAGE2_LIVE_SHEET", c.s2 ? "on" : "");
  vi.stubEnv("DIGER_STAGE3_COMPANIES", c.s3 ? "on" : "");
  vi.stubEnv("DIGER_STAGE4_VERSIONS", c.s4 ? "on" : "");
  return replay({ request: SECTOR_WORLD.electromechanical.request, planning: planFlow("electromechanical"), execution: () => [], answers: Array.from({ length: 200 }, () => dispatcher({})) }).finally(() => vi.unstubAllEnvs());
};

const norm = (v: unknown): string => (v instanceof Date ? v.toISOString() : v && typeof v === "object" && "text" in (v as object) ? String((v as { text: unknown }).text) : v === null || v === undefined ? "" : String(v));
async function fileSheets(r: ReplayResult): Promise<Record<string, string[][]>> {
  const wb = await readWorkbook(r);
  const out: Record<string, string[][]> = {};
  wb.eachSheet((ws, i) => { if (i === 1) return; const rows: string[][] = []; ws.eachRow({ includeEmpty: false }, (row, n) => { if (n > 1) rows.push(Array.from({ length: ws.columnCount }, (_, j) => norm(row.getCell(j + 1).value))); }); out[ws.name] = rows; });
  return out;
}
const ledger = (r: ReplayResult) => r.money.ledger.map((l) => `${l.type}`);
const keys = (r: ReplayResult, prefix: string) => [...(r.store as unknown as { files: Map<string, unknown> }).files.keys()].filter((k) => k.startsWith(`${r.missionId}/${prefix}`));
const money = (r: ReplayResult) => ({ status: r.mission.status, delivered: r.mission.delivered_units, charged: r.mission.charged_points, ledger: ledger(r) });

describe("the same companies mission under every combination of the three stages' flags", () => {
  const results = new Map<string, ReplayResult>();
  const sheets = new Map<string, Record<string, string[][]>>();
  it("every run completes and settles ONCE: one reserve, one release, at most one charge, the charge never above the hold, no negative balance", async () => {
    for (const c of COMBOS) {
      const r = await run(c);
      results.set(c.name, r);
      sheets.set(c.name, await fileSheets(r));
      expect(r.mission.status, c.name).toBe("completed");
      const types = ledger(r);
      expect(types.filter((t) => t === "reserve"), c.name).toHaveLength(1);
      expect(types.filter((t) => t === "release"), c.name).toHaveLength(1);
      expect(types.filter((t) => t === "charge").length, c.name).toBeLessThanOrEqual(1);
      const reserve = r.money.ledger.find((l) => l.type === "reserve")!;
      const charge = r.money.ledger.find((l) => l.type === "charge");
      if (charge) expect(-charge.delta, c.name).toBeLessThanOrEqual(-reserve.delta);
      expect(r.money.balance(), c.name).toBeGreaterThanOrEqual(0);
    }
  }, 240_000);

  it("the Stage 2 live sheet and the Stage 4 version store change NOTHING a customer receives or pays: the file and the money equal the all-OFF run", () => {
    const off = results.get("all OFF")!;
    for (const name of ["Stage 2 live sheet ON", "Stage 4 versions ON"]) {
      expect(sheets.get(name), name).toEqual(sheets.get("all OFF"));
      expect(money(results.get(name)!), name).toEqual(money(off));
    }
  });

  it("with all three ON the file and the money equal the Stage 3-only run (the other two stages add side objects only)", () => {
    expect(sheets.get("Stage 2 + 3 + 4 ALL ON")).toEqual(sheets.get("Stage 3 companies ON"));
    expect(money(results.get("Stage 2 + 3 + 4 ALL ON")!)).toEqual(money(results.get("Stage 3 companies ON")!));
  });

  it("nothing is written for a stage whose flag is off", () => {
    for (const c of COMBOS) {
      const r = results.get(c.name)!;
      expect(keys(r, "live/").length > 0, `${c.name}: live objects`).toBe(c.s2);
      expect(keys(r, "versions/").length > 0, `${c.name}: version objects`).toBe(c.s4);
    }
  });

  it("the live DONE snapshot equals the delivered file, sheet by sheet and cell by cell, also when Stage 3 changed the cells", async () => {
    for (const name of ["Stage 2 live sheet ON", "Stage 2 + 3 + 4 ALL ON"]) {
      const r = results.get(name)!;
      const done = keys(r, "live/").filter((k) => k.endsWith("_done.json")).sort().at(-1)!;
      expect(done, name).toBeTruthy();
      const snap = JSON.parse(String(await r.store.getFile(r.missionId, done.slice(r.missionId.length + 1))));
      expect(snap.status, name).toBe("done");
      const file = sheets.get(name)!;
      expect(snap.sheets.map((s: { nameAr: string }) => s.nameAr), name).toEqual(Object.keys(file));
      let compared = 0;
      for (const s of snap.sheets as Array<{ nameAr: string; rows: Array<{ cells: Array<{ k: string; v: string }> }> }>) {
        expect(s.rows.length, `${name} / ${s.nameAr}: row count`).toBe(file[s.nameAr].length);
        s.rows.forEach((row, i) => row.cells.forEach((c, j) => {
          const fv = file[s.nameAr][i][j];
          compared += 1;
          expect(c.k === "date" ? Date.parse(c.v) : String(c.v ?? ""), `${name} / ${s.nameAr} / row ${i + 2} col ${j + 1}`).toBe(c.k === "date" ? Date.parse(fv) : fv);
        }));
      }
      // not vacuous: real rows and many cells were compared
      expect(snap.sheets.length, name).toBeGreaterThanOrEqual(1);
      expect(compared, name).toBeGreaterThan(30);
    }
  }, 120_000);

  it("the stored version 1 has the delivered file's sheets and row counts (the original is never changed)", async () => {
    for (const name of ["Stage 4 versions ON", "Stage 2 + 3 + 4 ALL ON"]) {
      const r = results.get(name)!;
      const v1 = JSON.parse(String(await r.store.getFile(r.missionId, "versions/v0001.json")));
      const file = sheets.get(name)!;
      expect(v1.sheets.map((s: { nameAr: string }) => s.nameAr), name).toEqual(Object.keys(file));
      for (const s of v1.sheets as Array<{ nameAr: string; rows: unknown[] }>) expect(s.rows.length, `${name} / ${s.nameAr}`).toBe(file[s.nameAr].length);
    }
  });

  it("no paid add-on exists in any run: no add-on mission row, no review or edit object", () => {
    for (const c of COMBOS) {
      const r = results.get(c.name)!;
      expect(keys(r, "addons/"), c.name).toEqual([]);
      expect(keys(r, "reviews/"), c.name).toEqual([]);
    }
  });
});
