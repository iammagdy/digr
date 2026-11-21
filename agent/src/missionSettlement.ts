import { createHash, randomUUID } from "node:crypto";
import { billedUnits, noBillableReasonAr, type ContactKindAsked } from "../../src/lib/agentMission/billableRows";
import { missionFileTitleAr } from "../../src/lib/agentMission/fileNames";
import { estimatedGroupKeys, stageCountsOf, stageUnitsOf } from "../../src/lib/agentMission/stageUnits";
import { csvExportFromWorkbook } from "../../src/lib/server/csvFromExcel";
import { ensureOwned, isOwnershipError } from "./ownership";
import type { RunnerDeps } from "./runMission";
import type { MissionRecord } from "./types";
import { readDeliveredWorkbook, type WorkbookBillingLayout } from "./workbookBilling";

const MANIFEST = "settlement/v1.json";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

function planDigest(plan: MissionRecord["plan"]): string {
  return sha(JSON.stringify(plan, (_, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]))
    : value));
}

export interface DeliveryNotes {
  date: string;
  llm: number;
  executionTregUsd: number;
  summary: string | null;
  outputError: string | null;
  costUsd: number;
}

export interface DeliveryPreparation {
  workbook: { xlsx: Buffer; billingLayout: WorkbookBillingLayout } | null;
  notes: DeliveryNotes;
}

type Candidate = { notes: DeliveryNotes; plan_sha: string } & (
  | { empty: true; xlsx_sha?: never }
  | { empty: false; path: string; xlsx_sha: string; layout: WorkbookBillingLayout }
);
type Files = NonNullable<MissionRecord["files"]>;
interface Manifest {
  version: 1;
  job_id: string;
  mission_id: string;
  plan_sha: string;
  xlsx_sha: string | null;
  csv_sha: string | null;
  xlsx_path: string | null;
  csv_path: string | null;
  physical_units: number;
  billable_units: number;
  counts: Record<string, number>;
  stage_units: { base: number; estimated: number } | null;
  files: Files;
  unbilled: { total: number; kinds: ContactKindAsked[] };
  cost_usd: string;
  release_reason: string;
  notes: DeliveryNotes;
}
type Binding = Manifest & { snapshot_sha: string };
export type DeliveryReceipt = Partial<Binding> & {
  job_id: string;
  mission_id: string;
  kind: "settled" | "released";
  physical_units: number;
  billable_units: number;
  charged_credits: number;
  refunded_credits: number;
};
type Progress = { candidate: Candidate | null; delivery: Binding | null; verify_count: number };
type Journal =
  | { kind: "not_started" | "legacy_mismatch" | "parked" | "recorded" | "bound" }
  | { kind: "error"; error: string }
  | { kind: "receipt"; receipt: DeliveryReceipt }
  | { kind: "progress"; progress: Progress; began?: boolean }
  | { kind: "attempt"; progress: Progress; mode: "verify" | "release_unsettled"; trial_id: string }
  | { kind: "exhausted" | "wait"; progress: Progress };

type FaultCode = "candidate_missing" | "storage_unavailable" | "manifest_invalid" | "binding_mismatch";
class DeliveryFault extends Error {
  constructor(readonly code: FaultCode) { super(code); }
}

async function bounded<T>(work: () => PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DeliveryFault("storage_unavailable")), 8000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function journal(deps: RunnerDeps, mission: MissionRecord, operation: string, trial: string | null = null, binding: Candidate | Binding | { code: FaultCode } | null = null): Promise<Journal> {
  try {
    const response = await bounded(() => deps.client.rpc("claim_agent_delivery_attempt_atomic", {
      p_mission_id: mission.id, p_worker_id: deps.ownerId ?? mission.worker_id,
      p_operation: operation, p_trial_id: trial, p_binding: binding,
    }));
    const result = response as { data?: Journal; error?: unknown } | undefined;
    return result?.error || !result?.data?.kind ? { kind: "error", error: "unconfirmed" } : result.data;
  } catch {
    return { kind: "error", error: "unconfirmed" };
  }
}

export async function inspectMissionDelivery(deps: RunnerDeps, mission: MissionRecord): Promise<Journal> {
  await bounded(() => ensureOwned(deps, mission.id));
  return journal(deps, mission, "status");
}

function descriptors(workbookHash: string, csvHash: string, title: string): Files {
  return [
    { name: "result.xlsx", kind: "xlsx", path: "result/result.xlsx", sha256: workbookHash, download_name: `${title}.xlsx` },
    { name: "result.csv", kind: "csv", path: "result/result.csv", sha256: csvHash, download_name: `${title}.csv` },
  ];
}

async function prepareMissionDelivery(deps: RunnerDeps, mission: MissionRecord, candidate: Candidate) {
  if (!mission.plan || !mission.job_id || candidate.plan_sha !== planDigest(mission.plan)) throw new DeliveryFault("binding_mismatch");
  const plan = mission.plan;
  const bytes = candidate.empty ? null : await bounded(() => deps.store.getFileBytes(mission.id, candidate.path));
  if (!candidate.empty && !bytes) throw new DeliveryFault("candidate_missing");
  if (bytes && sha(bytes) !== candidate.xlsx_sha) throw new DeliveryFault("binding_mismatch");
  const readback = candidate.empty || !bytes
    ? { ok: true as const, counts: {} as Record<string, number>, unbilled: { total: 0, byStage: {}, kinds: [] as ContactKindAsked[] } }
    : await readDeliveredWorkbook(bytes, candidate.layout, plan);
  if (!readback.ok) throw new DeliveryFault("binding_mismatch");
  const { counts, unbilled } = readback;
  const physical = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (bytes && physical === 0) throw new DeliveryFault("binding_mismatch");
  const group = estimatedGroupKeys(plan.stages);
  const units = group.size > 0 ? stageUnitsOf(plan) : null;
  if (group.size > 0 && !units) throw new DeliveryFault("binding_mismatch");
  const deliveredByStage = units ? stageCountsOf(plan.stages, counts, units, physical) : null;
  const unbilledInGroup = Object.entries(unbilled.byStage).reduce((sum, [key, count]) => sum + (group.has(key) ? count : 0), 0);
  const billed = billedUnits({ delivered: physical, unbilledTotal: unbilled.total, unbilledInGroup, stageCounts: deliveredByStage });
  const csv = bytes ? (await csvExportFromWorkbook(bytes)).stages.at(-1)?.csv : undefined;
  if (bytes && csv === undefined) throw new DeliveryFault("binding_mismatch");
  const prefix = `${mission.user_id}/${mission.job_id}/sealed/${candidate.xlsx_sha}`;
  const parentStage = plan.stages.find((stage) => stage.deliver && stage.parent_key === null);
  const title = missionFileTitleAr({ plan, requestText: mission.request_text, delivered: physical, date: new Date(candidate.notes.date), parentDelivered: parentStage ? (counts[parentStage.key] ?? null) : null });
  const csvHash = csv === undefined ? null : sha(csv);
  const manifest: Manifest = {
    version: 1, job_id: mission.job_id, mission_id: mission.id, plan_sha: candidate.plan_sha,
    xlsx_sha: candidate.xlsx_sha ?? null, csv_sha: csvHash,
    xlsx_path: bytes ? `${prefix}/result.xlsx` : null, csv_path: bytes ? `${prefix}/result.csv` : null,
    counts, physical_units: physical, billable_units: billed.deliveredUnits, stage_units: billed.counts,
    files: candidate.xlsx_sha && csvHash ? descriptors(candidate.xlsx_sha, csvHash, title) : [],
    unbilled: { total: billed.reduced, kinds: unbilled.kinds },
    cost_usd: Math.max(0, candidate.notes.costUsd).toFixed(6),
    release_reason: physical > 0 && billed.deliveredUnits === 0 ? noBillableReasonAr(unbilled.kinds) : "لم يُسلَّم شيء من هذه المهمة، فعاد الحجز المؤقت كاملًا.",
    notes: candidate.notes,
  };
  return { bytes, csv, manifest };
}

async function readMissionDelivery(deps: RunnerDeps, mission: MissionRecord, progress: Progress) {
  if (!progress.candidate) throw new DeliveryFault("candidate_missing");
  let stored = await bounded(() => deps.store.getFileBytes(mission.id, MANIFEST));
  if (!stored && progress.delivery) throw new DeliveryFault("manifest_invalid");
  const prepared = await prepareMissionDelivery(deps, mission, progress.candidate);
  if (!stored) {
    await bounded(() => deps.store.putNewStrict(mission.id, MANIFEST, JSON.stringify(prepared.manifest), "application/json"));
    stored = await bounded(() => deps.store.getFileBytes(mission.id, MANIFEST));
  }
  if (!stored || stored.length > 2_097_152) throw new DeliveryFault("manifest_invalid");
  let actual: unknown;
  try { actual = JSON.parse(stored.toString("utf8")); } catch { throw new DeliveryFault("manifest_invalid"); }
  // JSONB canonicalizes the candidate's key order independently of the raw manifest bytes.
  if (!sameJson(actual, prepared.manifest) || (progress.delivery && progress.delivery.snapshot_sha !== sha(stored))) throw new DeliveryFault("binding_mismatch");
  return { ...prepared, binding: { ...prepared.manifest, snapshot_sha: sha(stored) } };
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
}

export async function advanceMissionDelivery(deps: RunnerDeps, mission: MissionRecord, initial?: () => Promise<DeliveryPreparation>): Promise<"parked" | "exhausted" | { receipt: DeliveryReceipt }> {
  const begin = await journal(deps, mission, "begin");
  if (begin.kind === "receipt") return { receipt: begin.receipt };
  if (begin.kind !== "progress") return begin.kind === "error" && begin.error === "unbound_money" ? "exhausted" : "parked";
  const trial = randomUUID();
  let claim = await journal(deps, mission, "claim", trial);
  if (claim.kind === "error" && claim.error === "unconfirmed") claim = await journal(deps, mission, "claim", trial);
  if (claim.kind === "receipt") return { receipt: claim.receipt };
  if (claim.kind === "exhausted") return "exhausted";

  const park = async () => {
    const result = await journal(deps, mission, "park");
    if (result.kind === "receipt") return { receipt: result.receipt };
    return result.kind === "exhausted" ? "exhausted" as const : "parked" as const;
  };
  if (claim.kind === "wait") return park();
  if (claim.kind !== "attempt") return "parked";

  let delivery: Binding | null = null;
  if (claim.mode === "verify") {
    let fault: FaultCode = "storage_unavailable";
    try {
      if (initial && begin.began && claim.progress.verify_count === 1 && !claim.progress.candidate && mission.plan) {
        const { workbook, notes } = await initial();
        const plan_sha = planDigest(mission.plan);
        const candidate: Candidate = workbook
          ? { empty: false, path: `settlement/candidate-${trial}.xlsx`, xlsx_sha: sha(workbook.xlsx), layout: workbook.billingLayout, notes, plan_sha }
          : { empty: true, notes, plan_sha };
        const bound = await journal(deps, mission, "bind_candidate", trial, candidate);
        if (bound.kind === "receipt") return { receipt: bound.receipt };
        if (bound.kind !== "bound") return park();
        claim.progress.candidate = candidate;
        if (workbook && !candidate.empty) {
          await bounded(() => deps.store.putNewStrict(mission.id, candidate.path, workbook.xlsx, XLSX));
        }
      }
      const verified = await readMissionDelivery(deps, mission, claim.progress);
      const binding = await journal(deps, mission, "bind_snapshot", trial, verified.binding);
      if (binding.kind === "receipt") return { receipt: binding.receipt };
      if (binding.kind !== "bound") return park();
      if (verified.bytes && verified.csv !== undefined && verified.binding.xlsx_sha && verified.binding.csv_sha && mission.job_id) {
        const jobId = mission.job_id;
        const { xlsx_sha: xlsxSha256, csv_sha: csvSha256 } = verified.binding;
        await bounded(() => ensureOwned(deps, mission.id));
        const published = await bounded(() => deps.store.publishResult({
          missionId: mission.id, userId: mission.user_id, jobId, xlsx: verified.bytes!, csv: verified.csv!,
          sealed: { xlsxSha256, csvSha256 },
        }));
        if (published.resultPath !== verified.binding.csv_path) throw new DeliveryFault("binding_mismatch");
      }
      delivery = verified.binding;
    } catch (error) {
      if (isOwnershipError(error)) throw error;
      if (error instanceof DeliveryFault) fault = error.code;
      await bounded(() => ensureOwned(deps, mission.id));
      const reported = await journal(deps, mission, "unreadable", trial, { code: fault });
      if (reported.kind === "receipt") return { receipt: reported.receipt };
      return park();
    }
  }

  try {
    await ensureOwned(deps, mission.id);
    const result = await bounded(() => deps.client.rpc("finalize_agent_delivery_atomic", {
      p_mission_id: mission.id, p_worker_id: deps.ownerId ?? mission.worker_id,
      p_delivery: delivery, p_mode: claim.mode === "verify" ? "deliver" : "release_unsettled", p_trial_id: trial,
    })) as { data?: { success?: boolean; receipt?: DeliveryReceipt }; error?: unknown };
    if (!result.error && result.data?.success === true && result.data.receipt) return { receipt: result.data.receipt };
  } catch (error) {
    if (isOwnershipError(error)) throw error;
  }
  const status = await inspectMissionDelivery(deps, mission);
  if (status.kind === "receipt") return { receipt: status.receipt };
  if (status.kind === "error") return "parked";
  return park();
}
