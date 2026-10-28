import { generateMissionWorkbook } from "../../src/lib/modelPlanner/missionWorkbook";
import type { StoredModelPlan } from "../../src/lib/modelPlanner/types";
import type { PricedPlan } from "../../src/lib/agentMission/plan";

type Row = Record<string, unknown>;

/** The files of a mission: linked sheets (one per delivered stage, joined by «المعرّف» and «معرّف الأصل») through the website's own mission workbook generator, and a CSV of the deepest delivered stage. */
export async function buildMissionFiles(plan: PricedPlan, rowsByStage: Record<string, Row[]>): Promise<{ xlsx: Buffer; csv: string }> {
  const index = new Map(plan.stages.map((s, i) => [s.key, i]));
  // the generator reads each cell at the column's Arabic header: two columns with the same title would collide, so a repeated title is numbered
  const titles = plan.stages.map((s) => {
    const seen = new Map<string, number>();
    return s.columns.map((c) => { const n = (seen.get(c.title_ar) ?? 0) + 1; seen.set(c.title_ar, n); return n === 1 ? c.title_ar : `${c.title_ar} ${n}`; });
  });
  const stored = {
    v: 1,
    steps: plan.stages.map((_, i) => ({ fieldMap: { columns: titles[i].map((headerAr) => ({ headerAr })) } })),
    stages: plan.stages.map((s) => ({ titleAr: s.title_ar, parent: s.parent_key === null ? null : index.get(s.parent_key) ?? null, deliver: s.deliver, effVolume: s.planned_rows, perParent: s.per_parent_rows ?? 0 })),
  } as unknown as StoredModelPlan;

  const flat: Row[] = [];
  plan.stages.forEach((s, i) => {
    for (const r of rowsByStage[s.key] ?? []) {
      const rec: Row = { mission_stage: i + 1, mission_row_id: String(r.id ?? ""), mission_parent_id: r.parent_id === undefined ? "" : String(r.parent_id) };
      s.columns.forEach((c, k) => { rec[titles[i][k]] = r[c.key] ?? ""; });
      flat.push(rec);
    }
  });
  const xlsx = await generateMissionWorkbook(flat, stored);

  const delivered = plan.stages.map((s, i) => ({ s, i })).filter(({ s }) => s.deliver && (rowsByStage[s.key] ?? []).length > 0);
  const last = delivered[delivered.length - 1];
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines: string[] = [];
  if (last) {
    const hasParent = last.s.parent_key !== null;
    lines.push([ "المعرّف", ...(hasParent ? ["معرّف الأصل"] : []), ...titles[last.i] ].map(esc).join(","));
    for (const r of rowsByStage[last.s.key]) lines.push([r.id, ...(hasParent ? [r.parent_id] : []), ...last.s.columns.map((c) => r[c.key])].map(esc).join(","));
  }
  return { xlsx, csv: `﻿${lines.join("\r\n")}` };
}
