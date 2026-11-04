import { createHash } from "node:crypto";
import { buildShapeDigest } from "../../../src/lib/modelPlanner/digest";
import type { TregCatalog } from "../../../src/lib/treg/catalog";
import { cellText, isRealValue, valueAtPath, type RereadRecipe } from "../../../src/lib/agentMission/stage4/reread";
import type { FileVersion } from "../../../src/lib/agentMission/stage4/versions";
import { RAW_PATH, type Gateway } from "../gateway";
import type { AgentStore } from "../types";
import { JSON_TYPE, rowsDir, type RereadStop } from "./addonFiles";

/**
 * MONEY PR 7a, PHASE 2B-1: THE RE-READ OF AN EDIT OR A REVIEW FIX. For each UNIT (a row of a new column, or a cell to correct) the tools of its recipe are tried in order through the EXISTING gateway (`tregCall`): it enforces
 * the catalog, the block list, the data policy, the add-on's USD budget (hold / points per USD: addonProviderBudgetUsd) and the provider's daily cap BEFORE every call, and records every call under the add-on's own id. A tool's
 * answer is read with the same page reader the gateway uses (`buildShapeDigest`); the first REAL value wins (a stated gap or an empty field is not a value: decision D4) and the next tool is tried only for a unit the one before could
 * not fill. This file plans nothing and prices nothing: the recipe and the budget come from the approved add-on row.
 *
 * Every finished unit is written as its own create-only object (rows/u_<hash>.json), so a run that was cut resumes from them and never pays twice for a unit.
 */
export interface RereadUnit {
  /** Stable: row id and target column. */
  key: string;
  rowId: string;
  column: string;
  /** A value the customer typed: no call, it counts as filled. */
  typed?: string;
  recipe: RereadRecipe | null;
}
export interface RereadResult {
  /** Unit key -> the value found (null: the unit was searched and nothing real was found). A unit that was never reached is absent. */
  values: Map<string, string | null>;
  /** Why the run stopped before every unit was reached (null: every unit was reached). */
  stop: RereadStop | "interrupted" | "lost";
}

const STOP_REFUSALS: Readonly<Record<string, Exclude<RereadStop, null | "deadline">>> = { daily_cap: "daily_cap", daily_limit: "daily_cap", over_budget: "budget", recording_unavailable: "recording" };
const unitFile = (addonId: string, key: string): string => `${rowsDir(addonId)}/u_${createHash("sha256").update(key).digest("hex").slice(0, 24)}.json`;

export async function runReread(input: {
  store: AgentStore;
  gateway: Gateway;
  catalog: TregCatalog;
  /** The delivered mission's folder, where the add-on keeps its objects. */
  of: string;
  /** The add-on's own id: the gateway's raw pages are saved under it. */
  addonId: string;
  base: FileVersion;
  sheet: string;
  units: ReadonlyArray<RereadUnit>;
  deadlineMs: number;
  shouldStop: () => boolean;
  /** True when this worker no longer owns the add-on's row (its lease ended and another worker took it): checked before every unit, so the old worker stops paying for what the new one is reading. */
  lost?: () => Promise<boolean>;
  log?: (line: string) => void;
}): Promise<RereadResult> {
  const { store, gateway, catalog } = input;
  const values = new Map<string, string | null>();
  // RESUME: the units a cut run already finished
  const wanted = new Set(input.units.map((u) => unitFile(input.addonId, u.key)));
  for (const f of await store.listFiles(input.of, rowsDir(input.addonId))) {
    if (!wanted.has(f.name)) continue;
    const text = await store.getFile(input.of, f.name);
    if (text === null) continue;
    const row = JSON.parse(text) as { key?: unknown; value?: unknown };
    if (typeof row.key === "string") values.set(row.key, typeof row.value === "string" ? row.value : null);
  }
  const sheet = input.base.sheets.find((s) => s.nameAr === input.sheet);
  const finish = async (u: RereadUnit, value: string | null): Promise<void> => {
    values.set(u.key, value);
    await store.putNew(input.of, unitFile(input.addonId, u.key), JSON.stringify({ key: u.key, value }), JSON_TYPE);
  };
  let stop: RereadResult["stop"] = null;

  const lookup = async (u: RereadUnit): Promise<{ value: string | null; stopped: boolean }> => {
    const row = sheet?.rows.find((r) => r.id === u.rowId);
    if (!row || !sheet || !u.recipe) return { value: null, stopped: false };
    for (const tool of u.recipe.tools) {
      const at = sheet.headers.indexOf(tool.bind.from);
      const bound = at >= 0 ? cellText(row.cells[at]) : "";
      if (bound === "") continue;
      const answer = await gateway.tregCall({ endpoint_id: tool.endpointId, params: { ...tool.params, [tool.bind.param]: bound } });
      if (!answer.ok) {
        const code = "refused" in answer ? STOP_REFUSALS[answer.refused] : undefined;
        if (code) { stop = code; return { value: null, stopped: true }; }
        continue;
      }
      const raw = await store.getFile(input.addonId, RAW_PATH(answer.call_id));
      const endpoint = catalog.byId.get(tool.endpointId);
      if (raw === null || !endpoint) continue;
      let rows: unknown[] = [];
      try { rows = buildShapeDigest(JSON.parse(raw), endpoint).reading?.rows ?? []; } catch { rows = []; }
      for (const r of rows) {
        const v = valueAtPath(r, tool.valueField);
        if (isRealValue(v)) return { value: cellText(v), stopped: false };
      }
    }
    return { value: null, stopped: false };
  };

  for (const u of input.units) {
    if (values.has(u.key)) continue;
    if (u.typed !== undefined) { await finish(u, isRealValue(u.typed) ? u.typed.trim() : null); continue; }
    if (stop) break;
    if (input.shouldStop()) { stop = "interrupted"; break; }
    if (Date.now() >= input.deadlineMs) { stop = "deadline"; break; }
    if (input.lost && (await input.lost())) { stop = "lost"; break; }
    const found = await lookup(u);
    // a unit the run could not finish because a limit refused its call is NOT written: it was not searched to the end
    if (found.stopped) break;
    await finish(u, found.value);
  }
  return { values, stop };
}
