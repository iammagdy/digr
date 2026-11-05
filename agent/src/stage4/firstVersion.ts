import ExcelJS from "exceljs";
import { accountIsTest } from "../redesign";
import type { AgentStore } from "../types";
import { stage4Enabled, stage4FlagMode } from "../../../src/lib/agentMission/stage4/flags";
import { firstVersionFromCells, versionPathOf, type FileVersion } from "../../../src/lib/agentMission/stage4/versions";

/**
 * STAGE 4, S1 (docs/STAGE-4.md section 8): VERSION 1 AT DELIVERY, behind DIGER_STAGE4_VERSIONS. Called by the worker only after the file is stored and the mission is settled (agent/src/runMission.ts, the end of
 * settleExecution). It reads back the workbook the customer downloads, makes version 1 from its cells and stores it create-only (`putNew`) at `versions/v0001.json` in the mission's own folder. No table, no migration.
 *
 * THE SAFETY OF IT: the whole helper (the flag read, the account lookup, the read-back, the build, the write) sits in ONE try/catch with a time limit. It never throws, never changes the mission's status or any
 * number, never touches a money value and never delays the settlement (it runs after it). With the flag unset it reads nothing and writes nothing: the first thing it does is read the flag.
 */
export const FIRST_VERSION_TIMEOUT_MS = 10_000;
const XLSX_PATH = "result/result.xlsx";
type Outcome = "off" | "stored" | "failed";
type Env = Readonly<Record<string, string | undefined>>;

/** The cells of every sheet of a workbook as the text the customer sees (the header row first). Same reading as the tests' `cellsOf`, with formulas and rich text read as their shown text. */
export async function workbookCells(xlsx: Buffer | Uint8Array): Promise<Record<string, string[][]>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsx as unknown as ArrayBuffer);
  const text = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    if (v instanceof Date) return v.toISOString();
    if (typeof v !== "object") return String(v);
    const o = v as { text?: unknown; richText?: Array<{ text?: unknown }>; result?: unknown };
    if (Array.isArray(o.richText)) return o.richText.map((p) => String(p.text ?? "")).join("");
    if (o.text !== undefined) return text(o.text);
    if (o.result !== undefined) return text(o.result);
    return "";
  };
  const out: Record<string, string[][]> = {};
  wb.eachSheet((ws) => {
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => { const cells: string[] = []; row.eachCell({ includeEmpty: true }, (c) => { cells.push(text(c.value)); }); rows.push(cells); });
    out[ws.name] = rows;
  });
  return out;
}

export interface FirstVersionDeps { store: AgentStore; log?: (line: string) => void }
export interface FirstVersionInput {
  missionId: string;
  userId: string;
  /** The environment the flag is read from (default: the process's). */
  env?: Env;
  /** The time limit in milliseconds (default 10 seconds). */
  timeoutMs?: number;
  now?: () => Date;
  /** The version builder (default: `firstVersionFromCells`; a test hands in one that throws). */
  build?: typeof firstVersionFromCells;
}

/** Never throws. «off»: the flag is not on for this account, so nothing was read or written. «stored»: version 1 is in the mission's folder. «failed»: logged, nothing changed. */
export async function storeFirstVersion(deps: FirstVersionDeps, input: FirstVersionInput): Promise<Outcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = async (): Promise<Outcome> => {
      // THE FLAG FIRST: unset (or any word but «on» / «test») is off, and nothing else is evaluated
      const mode = stage4FlagMode("DIGER_STAGE4_VERSIONS", input.env);
      if (mode === "off") return "off";
      if (!stage4Enabled("DIGER_STAGE4_VERSIONS", mode === "on" ? false : await accountIsTest(deps.store, input.userId), input.env)) return "off";
      const bytes = await deps.store.getFileBytes(input.missionId, XLSX_PATH);
      if (!bytes) throw new Error("the delivered file is not in the mission's folder");
      const version: FileVersion = (input.build ?? firstVersionFromCells)({ missionId: input.missionId, cells: await workbookCells(bytes), createdAt: (input.now ?? (() => new Date()))().toISOString() });
      await deps.store.putNew(input.missionId, versionPathOf(1), JSON.stringify(version), "application/json");
      return "stored";
    };
    const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("time limit")), input.timeoutMs ?? FIRST_VERSION_TIMEOUT_MS); });
    return await Promise.race([work(), limit]);
  } catch (e) {
    try { deps.log?.(`version_not_stored ${input.missionId} ${String((e as Error)?.message ?? e).slice(0, 120)}`); } catch { /* logging never fails the worker */ }
    return "failed";
  } finally {
    if (timer) clearTimeout(timer);
  }
}
