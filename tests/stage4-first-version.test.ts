import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import { g1 } from "./helpers/g1World";
import { cellsOf } from "./helpers/round11Worlds";
import { createMemoryStore, newMission, type MemoryStore } from "../agent/src/memoryStore";
import { FIRST_VERSION_TIMEOUT_MS, storeFirstVersion, workbookCells } from "../agent/src/stage4/firstVersion";
import { firstVersionFromCells, versionPathOf, type FileVersion } from "../src/lib/agentMission/stage4/versions";

beforeEach(() => vi.stubEnv("JOB_MAX_POINTS_CAP", ""));

/**
 * STAGE 4, S1 (docs/STAGE-4.md section 8): VERSION 1 AT DELIVERY, behind DIGER_STAGE4_VERSIONS. After the file is stored and the mission is settled, the worker reads back the delivered workbook, makes
 * version 1 from its cells and stores it create-only at `versions/v0001.json`. The whole helper sits in one try/catch with a time limit: it never throws, never changes the mission, never touches money.
 * Flag unset (or «test» for a customer): nothing is read, built or written, and the mission is what it is today.
 */
afterEach(() => vi.unstubAllEnvs());
const VERSION_FILES = (s: MemoryStore, id: string): string[] => [...s.files.keys()].filter((k) => k.startsWith(`${id}/versions/`));
const norm = (v: unknown): string => JSON.stringify(v).replace(/msn_[0-9a-f]+/g, "<mission>").replace(/job_[A-Za-z0-9_-]+/g, "<job>").replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<time>");
async function stableDelivery(r: Awaited<ReturnType<typeof g1>>) {
  const m = r.mission;
  const files = await Promise.all((m.files ?? []).map(async ({ sha256, ...file }) => {
    const bytes = await r.store.getFileBytes(r.missionId, file.path);
    expect(bytes, file.path).not.toBeNull();
    expect(sha256).toBe(createHash("sha256").update(bytes!).digest("hex"));
    const content = file.kind === "xlsx" ? await cellsOf(bytes!) : bytes!.toString("utf8");
    return { ...file, content };
  }));
  return { status: m.status, delivered_units: m.delivered_units, charged_points: m.charged_points, summary_ar: m.summary_ar, error: m.error, files };
}
const settles = (r: Awaited<ReturnType<typeof g1>>) => r.money.calls.filter((c) => c.name === "settle_job_atomic");

describe("flag unset: nothing is evaluated or written", () => {
  it("a whole mission with the flag unset stores no version and reads nothing for it", async () => {
    const r = await g1();
    expect(r.mission.status).toBe("completed");
    expect(VERSION_FILES(r.store, r.missionId)).toEqual([]);
  }, 60_000);
  it("the helper itself, flag unset: no store call at all (not even the account's e-mail)", async () => {
    const touched: string[] = [];
    const store = new Proxy(createMemoryStore(), { get: (t, k) => { touched.push(String(k)); return (t as any)[k]; } }) as MemoryStore;
    const out = await storeFirstVersion({ store }, { missionId: "msn_x", userId: "u1", env: {} });
    expect(out).toBe("off");
    expect(touched).toEqual([]);
  });
  it("«test» for a customer is off as well", async () => {
    const store = createMemoryStore();
    const out = await storeFirstVersion({ store }, { missionId: "msn_x", userId: "u1", env: { DIGER_STAGE4_VERSIONS: "test" } });
    expect(out).toBe("off");
    expect(VERSION_FILES(store, "msn_x")).toEqual([]);
  });
});

describe("flag on: version 1 equals the delivered file", () => {
  it("stored at versions/v0001.json, from the cells of the file the customer downloads", async () => {
    vi.stubEnv("DIGER_STAGE4_VERSIONS", "on");
    const r = await g1();
    expect(r.mission.status).toBe("completed");
    expect(VERSION_FILES(r.store, r.missionId)).toEqual([`${r.missionId}/${versionPathOf(1)}`]);
    const stored = JSON.parse((await r.store.getFile(r.missionId, versionPathOf(1)))!) as FileVersion;
    const cells = await cellsOf((await r.store.getFileBytes(r.missionId, "result/result.xlsx"))!);
    const expected = firstVersionFromCells({ missionId: r.missionId, cells, createdAt: stored.createdAt });
    expect(stored).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(stored.version).toBe(1);
    expect(stored.parent).toBeNull();
    expect(stored.reason).toBe("delivery");
    expect(stored.sheets.length).toBeGreaterThan(0);
    expect(stored.sheets.reduce((n, s) => n + s.rows.length, 0)).toBeGreaterThan(0);
  }, 60_000);

  it("the mission, the events and the money are what they are with the flag unset (the only difference is the version object)", async () => {
    const off = await g1();
    vi.stubEnv("DIGER_STAGE4_VERSIONS", "on");
    const on = await g1();
    expect(norm(await stableDelivery(on))).toBe(norm(await stableDelivery(off)));
    expect(norm(on.store.events.map((e) => [e.kind, e.message_ar]))).toBe(norm(off.store.events.map((e) => [e.kind, e.message_ar])));
    expect(settles(on)).toHaveLength(1);
    expect(norm(settles(on))).toBe(norm(settles(off)));
    expect(on.money.balance()).toBe(off.money.balance());
    const names = (r: typeof on) => [...r.store.files.keys()].map((k) => k.replace(r.missionId, "<mission>").replace(r.mission.job_id!, "<job>"))
      .filter((k) => !k.includes("/versions/") && !/\/(items|state|rows)\//.test(k))
      .map((k) => k.replace(/\/settlement\/candidate-[a-f0-9-]{36}\.xlsx$/, "/settlement/candidate.xlsx")
        .replace(/\/sealed\/[a-f0-9]{64}\//, "/sealed/<sha>/")).sort();
    expect(names(on)).toEqual(names(off));
  }, 120_000);

  it("a mission delivered twice (the settlement code run again) leaves version 1 as it was: create-only", async () => {
    const store = createMemoryStore();
    await store.putFile("msn_a", "result/result.xlsx", await xlsxOf({ "ورقة": [["المعرّف", "الاسم"], ["a1", "س"]] }), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const env = { DIGER_STAGE4_VERSIONS: "on" };
    expect(await storeFirstVersion({ store }, { missionId: "msn_a", userId: "u1", env, now: () => new Date("2026-11-04T10:00:00Z") })).toBe("stored");
    const first = await store.getFile("msn_a", versionPathOf(1));
    await storeFirstVersion({ store }, { missionId: "msn_a", userId: "u1", env, now: () => new Date("2026-11-04T11:00:00Z") });
    expect(await store.getFile("msn_a", versionPathOf(1))).toBe(first);
  });
});

async function xlsxOf(sheets: Record<string, string[][]>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const [n, rows] of Object.entries(sheets)) { const ws = wb.addWorksheet(n); for (const r of rows) ws.addRow(r); }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("flag on, but the version cannot be made or stored: never an error, never a change", () => {
  it("a store that refuses the version: the mission, the settlement and the events are the same as with the flag unset", async () => {
    const off = await g1();
    vi.stubEnv("DIGER_STAGE4_VERSIONS", "on");
    const on = await g1({ deps: (base) => { const s = base.store as MemoryStore; const put = s.putNew.bind(s); s.putNew = async (m, p, c, t) => { if (p.startsWith("versions/")) throw new Error("storage is down"); return put(m, p, c, t); }; return base; } });
    expect(on.mission.status).toBe("completed");
    expect(VERSION_FILES(on.store, on.missionId)).toEqual([]);
    expect(settles(on)).toHaveLength(1);
    expect(norm(settles(on))).toBe(norm(settles(off)));
    expect(norm(await stableDelivery(on))).toBe(norm(await stableDelivery(off)));
    expect(norm(on.store.events.map((e) => [e.kind, e.message_ar]))).toBe(norm(off.store.events.map((e) => [e.kind, e.message_ar])));
  }, 120_000);

  it("a builder that throws: the helper logs and swallows", async () => {
    const store = createMemoryStore();
    await store.putFile("msn_b", "result/result.xlsx", await xlsxOf({ "ورقة": [["المعرّف"], ["a1"]] }), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const log = vi.fn();
    const out = await storeFirstVersion({ store, log }, { missionId: "msn_b", userId: "u1", env: { DIGER_STAGE4_VERSIONS: "on" }, build: () => { throw new Error("builder"); } });
    expect(out).toBe("failed");
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain("version_not_stored");
    expect(VERSION_FILES(store, "msn_b")).toEqual([]);
  });

  it("a delivered file that cannot be read, or is not there: nothing stored, no throw", async () => {
    const store = createMemoryStore();
    const env = { DIGER_STAGE4_VERSIONS: "on" };
    expect(await storeFirstVersion({ store }, { missionId: "msn_none", userId: "u1", env })).toBe("failed");
    await store.putFile("msn_bad", "result/result.xlsx", Buffer.from("not a workbook"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(await storeFirstVersion({ store }, { missionId: "msn_bad", userId: "u1", env })).toBe("failed");
    expect(VERSION_FILES(store, "msn_bad")).toEqual([]);
  });

  it("a store that never answers: the helper gives up at its time limit (10 seconds by default)", async () => {
    expect(FIRST_VERSION_TIMEOUT_MS).toBe(10_000);
    const store = createMemoryStore();
    store.getFileBytes = () => new Promise(() => {});
    const t0 = Date.now();
    const out = await storeFirstVersion({ store }, { missionId: "msn_slow", userId: "u1", env: { DIGER_STAGE4_VERSIONS: "on" }, timeoutMs: 50 });
    expect(out).toBe("failed");
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("a flag read that throws is swallowed too (the whole helper is inside the try)", async () => {
    const env = new Proxy({}, { get: () => { throw new Error("env"); } }) as Record<string, string>;
    expect(await storeFirstVersion({ store: createMemoryStore() }, { missionId: "msn_e", userId: "u1", env })).toBe("failed");
  });
});

describe("the workbook reader gives the cells the file holds", () => {
  it("text, numbers, links, formulas and dates become the text the customer sees; the summary sheet is read too (the version builder leaves it out)", async () => {
    const wb = new ExcelJS.Workbook();
    const sum = wb.addWorksheet("الملخص"); sum.addRow(["ملخص"]);
    const ws = wb.addWorksheet("بيانات");
    ws.addRow(["المعرّف", "الاسم", "الرابط", "العدد", "الحساب", "التاريخ"]);
    ws.addRow(["r1", "سارة", { text: "الموقع", hyperlink: "https://example.com/" }, 7, { formula: "3+4", result: 7 }, new Date("2026-11-01T00:00:00Z")]);
    const cells = await workbookCells(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(Object.keys(cells)).toEqual(["الملخص", "بيانات"]);
    expect(cells["بيانات"][1]).toEqual(["r1", "سارة", "الموقع", "7", "7", "2026-11-01T00:00:00.000Z"]);
    expect(newMission({ id: "x", user_id: "u" })).toBeTruthy();
  });
});

describe("where the worker writes version one", () => {
  it("writes only after a confirmed file receipt, terminal metadata and notice on both fresh and recovered delivery", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../agent/src/runMission.ts", import.meta.url), "utf8");
    const fresh = src.slice(src.indexOf("async function settleExecution("), src.indexOf("export const NO_TOPIC_END_AR"));
    const recovered = src.slice(src.indexOf("async function acknowledgeDelivery("), src.indexOf("async function resumeExecutionDelivery("));
    expect([...src.matchAll(/storeFirstVersion\(/g)]).toHaveLength(2);
    function follows(path: string, prior: string[], guard: string) {
      const positions = [...prior, guard].map((step) => path.indexOf(step));
      expect(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]))).toBe(true);
    }
    follows(fresh, ["await advanceMissionDelivery(", "const { receipt } = result;", "await store.updateMission(", "await tell(deps, mission, jobId, noticeKind"],
      "if (receipt.csv_path && delivered > 0 && !ourFailure) await storeFirstVersion(");
    follows(recovered, ["if (receipt.mission_id !== mission.id", "await store.updateMission(", "await tell(deps, mission, mission.job_id, noticeKind"],
      "if (receipt.csv_path && physical > 0) await storeFirstVersion(");
  });
});
