import ExcelJS from "exceljs";
import { approveAddonOnce } from "../../src/lib/agentMission/addonSettlement";
import { generateVersionWorkbook } from "../../src/lib/agentMission/stage4/versionFile";
import { firstVersionFromCells, type FileVersion } from "../../src/lib/agentMission/stage4/versions";
import { createMemoryStore, newMission, type MemoryStore } from "../../agent/src/memoryStore";
import { addonRunWorld, M12 } from "./addonRunWorld";
import { USER } from "./addonWorld";

/**
 * STAGE F: ONE FAKE WORLD FOR THE END-TO-END FLOWS. The worker (memory store, hardened money fake, fake recorder, fake provider: `addonRunWorld`) and the site's routes see the SAME data: `routeClient` answers the routes' supabase-like calls over the worker's own
 * `missions` map and its own `files` map, so a row a route makes is the row the approval and the worker read, and a version the worker publishes is the version a route lists and serves. Nothing here can reach a database, a bucket, a provider or a model;
 * `fetch` is stubbed to throw by the tests. Every write, every rpc, every other table and every signed link of the routes is COUNTED.
 */
export const ME = USER;
export const OTHER_USER = "22222222-2222-4222-8222-222222222222";
export const MISSION = M12;
export const OTHER_MISSION = "msn_aaaaaaaaaaaaaaaaaaaa";
export const MISSING_MISSION = "msn_bbbbbbbbbbbbbbbbbbbb";
export const CLIENTS_SHEET = "العملاء";
export const NOTES_SHEET = "الملاحظات";
export const CLIENTS_HEADERS = ["الاسم", "البريد الإلكتروني", "الهاتف", "المعرّف"];
export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** A small delivered file with two sheets and a few honest faults for the review to find: an empty name, a bad e-mail, a short phone, and one stated gap. Ids last, as in the real files. */
export function sampleVersion(missionId = MISSION): FileVersion {
  return firstVersionFromCells({
    missionId, createdAt: "2026-11-04T09:00:00.000Z",
    cells: {
      [CLIENTS_SHEET]: [CLIENTS_HEADERS,
        ["أحمد", "a@b.co", "01000000000", "c_1"],
        ["", "not-an-email", "123", "c_2"],
        ["سارة", "غير متوفر", "01111111111", "c_3"],
        ["منى", "m@x.org", "01222222222", "c_4"]],
      [NOTES_SHEET]: [["الملاحظة", "المعرّف"], ["ممتاز", "n_1"], ["", "n_2"]],
    },
  });
}

export type RouteFaults = { storage: boolean; db: boolean };

/** The routes' supabase-like client over the worker's own data. */
export function routeClient(store: MemoryStore) {
  const faults: RouteFaults = { storage: false, db: false };
  const log: string[] = [];
  const other: string[] = [];
  const storageWrites: string[] = [];
  const signed: string[] = [];
  const valueAt = (row: unknown, col: string): unknown => col.split(/->>?/).reduce((v: any, k) => (v === null || v === undefined ? v : v[k]), row);

  function builder(table: string) {
    let op: "select" | "insert" | "update" = "select";
    let payload: any;
    let wantRows = false;
    const filters: Array<(r: any) => boolean> = [];
    const run = (): { data: any; error: any } => {
      if (table !== "missions") { other.push(`${op} ${table}`); return { data: null, error: { message: `unexpected table ${table}` } }; }
      if (faults.db) return { data: null, error: { message: "database is down" } };
      if (op === "insert") {
        if (store.missions.has(payload.id)) return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "missions_pkey"' } };
        store.missions.set(payload.id, newMission({ ...payload }));
        log.push(`insert ${payload.id} ${payload.status}`);
        return { data: null, error: null };
      }
      const hit = [...store.missions.values()].filter((r) => filters.every((f) => f(r)));
      if (op === "update") {
        for (const r of hit) { Object.assign(r, payload); log.push(`update ${r.id} ${JSON.stringify(payload)}`); }
        return { data: wantRows ? hit.map((r) => ({ id: r.id })) : null, error: null };
      }
      return { data: hit.map((r) => ({ ...r })), error: null };
    };
    const b: any = {
      select: () => { if (op !== "select") wantRows = true; return b; },
      insert: (row: any) => { op = "insert"; payload = row; return b; },
      update: (patch: any) => { op = "update"; payload = patch; return b; },
      eq: (c: string, v: unknown) => { filters.push((r) => valueAt(r, c) === v); return b; },
      is: (c: string, v: unknown) => { filters.push((r) => (v === null ? valueAt(r, c) === null || valueAt(r, c) === undefined : valueAt(r, c) === v)); return b; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(valueAt(r, c))); return b; },
      limit: () => b,
      maybeSingle: async () => { const { data, error } = run(); return { data: Array.isArray(data) ? data[0] ?? null : null, error }; },
      then: (resolve: any, reject: any) => Promise.resolve().then(run).then(resolve, reject),
    };
    return b;
  }

  const files = store.files;
  const bucket = {
    list: async (dir: string) => {
      if (faults.storage) return { data: null, error: { message: "upstream failure", statusCode: "503" } };
      const names = [...new Set([...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1).split("/")[0]))];
      return { data: names.map((name) => ({ name, id: files.has(`${dir}/${name}`) ? `id_${name}` : null })), error: null };
    },
    download: async (p: string) => {
      if (faults.storage) return { data: null, error: { message: "upstream failure", statusCode: "503" } };
      const v = files.get(p);
      return v === undefined ? { data: null, error: { message: "Object not found", statusCode: "404" } } : { data: new Blob([v as any]), error: null };
    },
    upload: async (p: string) => { storageWrites.push(`upload ${p}`); return { data: {}, error: null }; },
    remove: async (p: string) => { storageWrites.push(`remove ${p}`); return { data: {}, error: null }; },
    createSignedUrl: async (p: string) => { signed.push(p); return { data: { signedUrl: `https://storage.example/signed/${p}` }, error: null }; },
  };
  return {
    from: (t: string) => builder(t),
    storage: { from: () => bucket },
    rpc: async (name: string) => { other.push(`rpc ${name}`); return { data: null, error: null }; },
    auth: { admin: { getUserById: async () => ({ data: { user: null } }) } },
    faults, log, other, storageWrites, signed,
  };
}
export type RouteClient = ReturnType<typeof routeClient>;

/**
 * The world of a flow: a DELIVERED mission (its Excel original and its version 1), another customer's delivered mission, the worker's pieces and the routes' client over the same data.
 * `approveAndClaim` is the REAL approval of the existing money core (fake clients only) followed by the worker's claim; nothing here calls a route for it, because the live approval endpoint does not exist (docs/STAGE-4-APPROVAL-BOUNDARY.md).
 */
export async function e2eWorld(options: { balance?: number; /** `"m12"`: the stored real TikTok file instead of the small sample. */ version?: FileVersion | "m12" } = {}) {
  const w = await addonRunWorld({ balance: options.balance ?? 10_000, ...(options.version === "m12" ? {} : { version: options.version ?? sampleVersion() }) });
  const original = await generateVersionWorkbook(w.v1);
  const filesOf = [{ name: "result.xlsx", path: "result/result.xlsx", kind: "xlsx", download_name: "ملف العملاء.xlsx" }];
  Object.assign(w.store.missions.get(MISSION)!, { files: filesOf, delivered_units: 4, updated_at: "2026-11-04T09:30:00.000Z" });
  w.store.files.set(`${MISSION}/result/result.xlsx`, original);
  w.store.missions.set(OTHER_MISSION, newMission({ id: OTHER_MISSION, user_id: OTHER_USER, status: "completed", files: filesOf as any, delivered_units: 1, request_text: "طلب شخص آخر" }));
  w.store.files.set(`${OTHER_MISSION}/result/result.xlsx`, original);
  const routes = routeClient(w.store);
  const ledgerTypes = () => w.money.ledger.map((r) => r.type);
  async function approveAndClaim(rowId: string) {
    const approved = await approveAddonOnce(w.money.client, { id: rowId, actorId: ME, expectUserId: ME });
    if (!approved.ok) throw new Error(`approval failed: ${JSON.stringify(approved)}`);
    const claimed = await w.store.claimMission("worker-1", 120);
    if (!claimed || claimed.id !== rowId) throw new Error("the add-on was not claimed");
    return { row: claimed, id: rowId, jobId: approved.jobId, hold: approved.holdPoints };
  }
  const addonRows = () => [...w.store.missions.values()].filter((m) => (m.plan as any)?.addon);
  const openRows = () => addonRows().filter((m) => ["queued", "planning", "needs_input", "plan_ready", "approved", "executing"].includes(m.status));
  return { ...w, original, routes, ledgerTypes, approveAndClaim, addonRows, openRows, startBalance: options.balance ?? 10_000 };
}
export type E2eWorld = Awaited<ReturnType<typeof e2eWorld>>;

// ---------------------------------------------------------------------------------------------------------------- reading a real .xlsx back

export const cellText = (v: ExcelJS.CellValue): string => (v === null || v === undefined ? "" : typeof v === "object" ? String((v as any).text ?? (v as any).result ?? "") : String(v));
export interface ParsedSheet { name: string; headers: string[]; rows: string[][] }
/** The real parse: the bytes are loaded by exceljs, never read from the version object. */
export async function parseXlsx(bytes: Uint8Array): Promise<ParsedSheet[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(bytes) as any);
  return wb.worksheets.map((ws) => {
    const all: string[][] = [];
    ws.eachRow({ includeEmpty: true }, (row) => { all.push(Array.from({ length: ws.columnCount }, (_, j) => cellText(row.getCell(j + 1).value))); });
    return { name: ws.name, headers: all[0] ?? [], rows: all.slice(1) };
  });
}
/** A sheet as the stored version says it must be. */
export const sheetsOfVersion = (v: FileVersion): ParsedSheet[] => v.sheets.map((s) => ({ name: s.nameAr, headers: [...s.headers], rows: s.rows.map((r) => [...r.cells]) }));
export const newMemoryStoreForTests = createMemoryStore;
