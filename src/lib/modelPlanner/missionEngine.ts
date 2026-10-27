import type { ProviderAdapterCallInput, ProviderAdapterCallOutput } from "../server/tregAdapter";
import { readField, ROLE_KEYS } from "./fieldMap";
import { countryRowGate } from "./countryGate";
import { MAX_CALLS_PER_CHUNK, MAX_MISSION_QUEUE, MODEL_PLAN_PURPOSE_PARAM, MODEL_PLAN_REQUEST_PARAM } from "./constants";
import { alternateStep, callStage, failureAr, reviewTopicRows, type InterpreterDeps } from "./stageCall";
import { safeArabicSentence } from "./customerSafe";
import { MANAGER_CALL_ESTIMATE_USD, type ManagerRequest, type ManagerResult } from "./manager";
import type { PlanStep, StepFacts, StoredModelPlan, StoredStage } from "./types";

/**
 * THE MISSION ENGINE: runs an approved plan of one to four stages, one worker chunk at a time. A stage is either a ROOT (it pages through its own endpoint) or runs ONCE for each row
 * of an earlier stage (its parent), taking the first page of that call. Rows keep their parent's id, so the files can be linked afterwards. The state between chunks travels in the
 * cursor (a small JSON text).
 *
 * The model manages the mission at its DECISION POINTS only (see manager.ts): after the first page of a stage, on a bad page (empty, failed, off-topic), when a stage hands its rows to
 * the next stage, and in a final review. Its spend is capped (plan.managerBudgetUsd). Everything that can cost money stays in code: the call budget, the per-call ceiling, the volumes and
 * the price were fixed when the customer approved, and a manager that fails or runs out of budget changes nothing.
 */
interface QueueItem {
  /** The values this stage's parameters take for this parent row. */
  p: Record<string, string | number>;
  /** The parent row's id (written on every row this item produces). */
  k: string;
  /** Values the grandchildren need from the rows this item came from (a stage reads its parent's rows AND the rows its parent came from), by stage index. */
  a?: Record<string, Record<string, string | number>>;
}

interface StageState {
  next: string | number | null;
  page: number;
  offset: number;
  queue: QueueItem[];
  listDone: boolean;
  /** Rows this stage collected (delivered or only used as parents) and rows delivered to the customer. */
  collected: number;
  delivered: number;
  /** Parent rows this stage has run for. */
  expanded: number;
  calls: number;
  /** Rows the rules left out (a filter, the country gate, the topic review): never delivered, never charged. */
  excluded: number;
  /** The first page of the stage was shown to the manager. */
  checked: boolean;
  /** 0 = the approved endpoint; k = the k-th alternative the plan carries (chosen by the manager). */
  alt: number;
  seq: number;
  stopped?: string;
}

export interface MissionState {
  v: 2;
  stages: StageState[];
  reviewUsd: number;
  mgrUsd: number;
  finalDone: boolean;
}

const freshStage = (): StageState => ({ next: null, page: 1, offset: 0, queue: [], listDone: false, collected: 0, delivered: 0, expanded: 0, calls: 0, excluded: 0, checked: false, alt: 0, seq: 0 });

export function parseMissionState(cursor: string | null, stageCount: number): MissionState {
  const fresh: MissionState = { v: 2, stages: Array.from({ length: stageCount }, freshStage), reviewUsd: 0, mgrUsd: 0, finalDone: false };
  if (!cursor) return fresh;
  try {
    const parsed = JSON.parse(cursor);
    if (parsed && parsed.v === 2 && Array.isArray(parsed.stages) && parsed.stages.length === stageCount) {
      return { ...fresh, ...parsed, stages: parsed.stages.map((s: Partial<StageState>) => ({ ...freshStage(), ...s })) };
    }
  } catch { /* a cursor that is not ours starts over */ }
  return fresh;
}

type Row = Record<string, unknown>;
type StepWithFacts = PlanStep & { facts: StepFacts };

const MANAGER_SAMPLE_ROWS = 5;
const MAX_NOTES = 8;

export async function runMissionChunk(input: ProviderAdapterCallInput, plan: StoredModelPlan, deps: InterpreterDeps): Promise<ProviderAdapterCallOutput> {
  const stages = plan.stages as StoredStage[];
  const n = stages.length;
  const now = deps.now ?? Date.now;
  const state = parseMissionState(input.cursor, n);
  const manager = deps.manager;
  const budgetUsd = Math.max(0, plan.managerBudgetUsd ?? 0);
  const wanted = Math.max(1, Math.floor(input.remainingNeeded || input.targetVolumeMax || 1));
  const request = String(input.params?.[MODEL_PLAN_REQUEST_PARAM] ?? "").trim() || plan.topic || "";
  const withPurpose: InterpreterDeps = deps.sensitive ? { ...deps, sensitive: { ...deps.sensitive, purpose: deps.sensitive.purpose || String(input.params?.[MODEL_PLAN_PURPOSE_PARAM] ?? "") } } : deps;
  const titles = stages.map((s) => s.titleAr);
  const multi = n > 1;
  const gate0 = countryRowGate(plan.country, plan.steps[0].facts.entity);
  const children = (i: number) => stages.map((s, j) => (s.parent === i ? j : -1)).filter((j) => j >= 0);
  // the fields a stage's rows must hand down to stages further away than their children: read by a step whose parent is another stage
  const handDown: Array<Set<string>> = stages.map(() => new Set<string>());
  plan.steps.forEach((st, j) => { for (const p of st.params) if (p.source === "prior_step" && p.fromStep && p.fromStep.step - 1 !== stages[j].parent) handDown[p.fromStep.step - 1]?.add(p.fromStep.field); });

  let costMicro = 0;
  let calls = 0;
  let lastCallId = "";
  let lastHttp = 200;
  const delivered: Row[] = [];
  const usage: NonNullable<ProviderAdapterCallOutput["reviewModelUsage"]> = [];
  const notes: NonNullable<ProviderAdapterCallOutput["missionNotes"]> = [];
  let missionStopped = false;

  const satisfied = (i: number) => state.stages[i].collected >= stages[i].effVolume;
  const budgetLeft = () => !input.deadlineMs || now() + 15_000 < input.deadlineMs;
  const note = (kind: string, stage: number | undefined, textAr: string) => { if (notes.length < MAX_NOTES) notes.push({ kind, ...(stage !== undefined ? { stage: stage + 1 } : {}), textAr }); };
  const stepOf = (i: number): StepWithFacts => {
    const step = plan.steps[i] as StepWithFacts;
    const alt = state.stages[i].alt;
    const carried = step.facts.alternates?.[alt - 1];
    return alt > 0 && carried ? alternateStep(step, carried) : step;
  };
  const alternativesLeft = (i: number) => Math.max(0, (plan.steps[i].facts.alternates?.length ?? 0) - state.stages[i].alt);

  /** One management call, inside the mission's model budget; a failure, a missing manager or an empty budget is «continue». */
  async function ask(req: ManagerRequest): Promise<ManagerResult["decision"]> {
    if (!manager || state.mgrUsd + MANAGER_CALL_ESTIMATE_USD > budgetUsd + 1e-12) return { action: "continue" };
    const left = input.deadlineMs ? input.deadlineMs - now() - 5_000 : undefined;
    if (left !== undefined && left < 4_000) return { action: "continue" };
    let result: ManagerResult;
    try { result = await manager.decide(req, left !== undefined ? Math.min(left, 12_000) : undefined); } catch { return { action: "continue" }; }
    if (result.usage) { usage.push(result.usage); state.mgrUsd += Math.max(0, result.usage.costUsd); }
    return result.decision;
  }

  /** A stage nobody can run any more: it stops (the rest of the mission goes on). */
  const stopStage = (i: number, reasonAr: string) => { const s = state.stages[i]; s.stopped = reasonAr; s.queue = []; s.listDone = true; note("stage_stopped", i, reasonAr); };

  const nothingDeliveredYet = () => delivered.length === 0 && state.stages.every((s) => s.delivered === 0);
  const fail = (errorCode: string, errorMessageAr: string, httpStatus = 500): ProviderAdapterCallOutput =>
    ({ ok: false, httpStatus, rows: [], nextCursor: null, costUsd: Number((costMicro / 1_000_000).toFixed(6)), costMicro, providerCallCount: calls, tregCallId: lastCallId, errorCode, errorMessageAr, ...(usage.length ? { reviewModelUsage: usage } : {}) });

  const stepsStillWorking = () => stages.some((_, i) => !state.stages[i].stopped && !satisfied(i) && (state.stages[i].queue.length > 0 || (stages[i].parent === null && !state.stages[i].listDone)));

  // ------------------------------------------------------------------ the work of this chunk
  while (calls < MAX_CALLS_PER_CHUNK && delivered.length < wanted && budgetLeft() && !missionStopped) {
    // the deepest stage with a parent row waiting first (a person's contacts as soon as the person is listed), else the next page of a root stage
    let work: { stage: number; parent: QueueItem | null } | null = null;
    for (let i = n - 1; i >= 0 && !work; i -= 1) {
      const s = state.stages[i];
      if (s.stopped || satisfied(i)) continue;
      if (stages[i].parent !== null && s.queue.length > 0) work = { stage: i, parent: s.queue[0] };
    }
    for (let i = 0; i < n && !work; i += 1) {
      const s = state.stages[i];
      if (stages[i].parent === null && !s.stopped && !s.listDone && !satisfied(i)) work = { stage: i, parent: null };
    }
    if (!work) break;

    const i = work.stage;
    const s = state.stages[i];
    const stage = stages[i];
    const step = stepOf(i);
    const isRoot = work.parent === null;
    const left = Math.max(1, stage.effVolume - s.collected);
    const passRate = Math.max(0.2, plan.measured?.[i]?.passRate ?? 1);
    const pageRows = isRoot ? Math.min(100, Math.max(1, Math.ceil(left / passRate))) : Math.min(stage.perParent || left, step.facts.limitMax ?? (stage.perParent || left));
    const firstTry = s.alt === 0 && s.collected === 0 && s.calls < 3;
    const gate = i === 0 ? gate0 : undefined;

    const r = await callStage(plan, step, work.parent ? work.parent.p : null, s, pageRows, input, withPurpose, `_s${i}${isRoot ? "" : `_c${s.offset}`}`, gate, firstTry);
    calls += r.calls; costMicro += r.costMicro; lastCallId = r.lastCallId || lastCallId; lastHttp = r.out.result.httpStatus || lastHttp; s.calls += r.calls;
    if (work.parent) { s.queue.shift(); s.offset += 1; s.expanded += 1; }

    const refused = Boolean(r.out.result.budgetStopped || r.out.refusedAr || r.out.result.blocked);
    if (refused) {
      // a budget stop or a refusal ends the mission: what was delivered is settled, the rest of the reserve returns
      const why = r.out.refusedAr ?? failureAr(r.out.result);
      if (nothingDeliveredYet()) return fail(r.out.result.error || "stopped", why, r.out.result.httpStatus);
      note("mission_stopped", i, why);
      missionStopped = true;
      break;
    }
    if (!r.out.ok) {
      // a source error on one page: the first call of a stage may hand the decision to the manager; otherwise the parent is skipped, a root stage stops
      if (isRoot) {
        const decision = !s.checked ? await ask({ kind: "bad_page", request, stageNumber: i + 1, stageCount: n, stageTitlesAr: titles, reason: "failed", seen: 0, kept: 0, sampleRows: [], alternatives: alternativesLeft(i) }) : ({ action: "continue" } as const);
        s.checked = true;
        if (decision.action === "switch") { s.alt += 1; s.next = null; s.page = 1; s.offset = 0; note("source_replaced", i, safeArabicSentence(decision.reasonAr) ?? "بدّلنا لمصدر بديل."); continue; }
        stopStage(i, "تعذّر الحصول على بيانات هذه المرحلة من المصدر.");
        if (nothingDeliveredYet() && !stepsStillWorking()) return fail(r.out.result.error || `http_${r.out.result.httpStatus}`, failureAr(r.out.result), r.out.result.httpStatus);
      }
      continue;
    }

    // ---------------- the rows of the page
    const reading = r.reading;
    const records = r.applied.records;
    const raws = r.applied.rawKept;
    let keepIdx = records.map((_, k) => k);
    let offTopic = false;
    if (isRoot && plan.topic && records.length > 0) {
      const cursor = { next: null, page: 1, offset: 0, reviewUsd: state.reviewUsd };
      const reviewed = await reviewTopicRows(records, plan, input, cursor, withPurpose);
      state.reviewUsd = cursor.reviewUsd ?? state.reviewUsd;
      usage.push(...reviewed.usage);
      const keptSet = new Set(reviewed.kept);
      keepIdx = keepIdx.filter((k) => keptSet.has(records[k]));
      offTopic = keepIdx.length === 0;
    }
    s.excluded += Math.max(0, reading.rows.length - records.length) + Math.max(0, records.length - keepIdx.length);
    const pageReason: "ok_page" | "empty" | "off_topic" = reading.rows.length === 0 || records.length === 0 ? "empty" : offTopic ? "off_topic" : "ok_page";

    // a decision point: the first page of a stage, or a bad one
    if (!s.checked) {
      {
        s.checked = true;
        const sampleRows = keepIdx.slice(0, MANAGER_SAMPLE_ROWS).map((k) => records[k]);
        const decision = await ask({ kind: pageReason === "ok_page" ? "first_page" : "bad_page", request, stageNumber: i + 1, stageCount: n, stageTitlesAr: titles, reason: pageReason, seen: reading.rows.length, kept: keepIdx.length, sampleRows: sampleRows.length > 0 ? sampleRows : records.slice(0, MANAGER_SAMPLE_ROWS), alternatives: alternativesLeft(i) });
        if (decision.action === "switch") {
          s.alt += 1; s.next = null; s.page = 1; s.offset = 0; s.listDone = false;
          note("source_replaced", i, safeArabicSentence(decision.reasonAr) ?? "بدّلنا لمصدر بديل.");
          if (!isRoot && work.parent) s.queue.unshift(work.parent);
          continue; // this page is not used: its rows are neither delivered nor charged
        }
        if (decision.action === "stop") {
          const why = safeArabicSentence(decision.reasonAr) ?? "رأينا أن نتائج هذه المرحلة لا تطابق طلبك فأوقفناها.";
          stopStage(i, why);
          if (stages.every((_, j) => state.stages[j].stopped || satisfied(j))) { if (nothingDeliveredYet()) return fail("mission_stopped", `${why}؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد.`, 200); missionStopped = true; }
          continue;
        }
      }
    }

    // rows kept up to what the stage still needs, tagged with their ids, delivered when the stage delivers
    const take = keepIdx.slice(0, isRoot ? left : Math.min(left, Math.max(1, stage.perParent)));
    const tagged: Row[] = [];
    const idKey = ROLE_KEYS.id;
    const stageRows: Array<{ record: Row; raw: Row; id: string }> = [];
    for (const k of take) {
      s.seq += 1;
      const record = records[k];
      const own = String(record[idKey] ?? "").trim();
      const id = own !== "" ? own : `s${i + 1}-${s.seq}`;
      stageRows.push({ record, raw: raws[k] as Row, id });
      if (multi) tagged.push({ ...record, mission_stage: i + 1, mission_row_id: id, mission_parent_id: work.parent ? work.parent.k : "" });
      else tagged.push(record);
    }
    s.collected += stageRows.length;
    if (stage.deliver) {
      const room = Math.max(0, wanted - delivered.length);
      const out = tagged.slice(0, room);
      s.delivered += out.length;
      delivered.push(...out);
    }

    // the next stages run for these rows: the manager picks which are worth it (a stage transition), code builds each stage's inputs from the real rows
    for (const j of children(i)) {
      if (state.stages[j].stopped) continue;
      let rows = stageRows;
      if (rows.length > 1 && !state.stages[j].stopped) {
        const decision = await ask({ kind: "transition", request, fromStage: i + 1, toStage: j + 1, stageTitlesAr: titles, rows: rows.map((x, index) => ({ index, row: x.record })) });
        if (decision.action === "expand" && decision.keep.length > 0) rows = decision.keep.map((index) => rows[index]).filter(Boolean);
      }
      const child = stages[j];
      const childStep = plan.steps[j];
      const needed = Math.min(MAX_MISSION_QUEUE, Math.ceil((child.effVolume / Math.max(1, child.perParent)) * 1.5));
      for (const row of rows) {
        if (state.stages[j].expanded + state.stages[j].queue.length >= needed) break;
        const values: Record<string, string | number> = {};
        let complete = true;
        for (const p of childStep.params) {
          if (p.source !== "prior_step" || !p.fromStep) continue;
          const from = p.fromStep.step - 1;
          const v = from === i ? readField(row.raw, p.fromStep.field) : work.parent?.a?.[String(from)]?.[p.fromStep.field];
          if (typeof v === "string" || typeof v === "number") values[p.name] = v; else complete = false;
        }
        if (complete && Object.keys(values).length > 0) {
          const down: Record<string, string | number> = {};
          for (const f of handDown[i]) { const v = readField(row.raw, f); if (typeof v === "string" || typeof v === "number") down[f] = v; }
          const inherited = work.parent?.a ?? {};
          const a = Object.keys(down).length > 0 ? { ...inherited, [String(i)]: down } : inherited;
          state.stages[j].queue.push({ p: values, k: row.id, ...(Object.keys(a).length > 0 ? { a } : {}) });
        }
      }
    }

    // paging of a root stage
    if (isRoot) {
      const pg = step.fieldMap.pagination;
      if (s.alt > 0 || r.viaAlternate) s.listDone = true;
      else if (reading.rows.length > 0 && pg.kind === "token" && reading.nextCursor && reading.cursorKind !== "url" && String(reading.nextCursor) !== String(s.next ?? "")) { s.next = reading.nextCursor; s.page += 1; }
      else if (reading.rows.length > 0 && pg.kind === "page") s.page += 1;
      else if (reading.rows.length > 0 && pg.kind === "offset") { s.offset += reading.rows.length; s.page += 1; }
      else s.listDone = true;
      if (satisfied(i)) s.listDone = true;
    }
  }

  // a stage that has everything it needs gives up what is still waiting for it
  stages.forEach((_, i) => { if (satisfied(i)) state.stages[i].queue = []; });
  // a stage whose parent can give nothing more and has nothing waiting is finished
  const finished = missionStopped || delivered.length >= wanted || !stepsStillWorking();

  if (finished && manager && !state.finalDone && !missionStopped) {
    state.finalDone = true;
    const decision = await ask({
      kind: "final", request,
      stages: stages.map((st, i) => ({ titleAr: st.titleAr, collected: state.stages[i].collected, delivered: state.stages[i].delivered, ...(state.stages[i].stopped ? { stopped: state.stages[i].stopped } : {}) })),
      sampleRows: delivered.slice(0, 6),
    });
    if (decision.action === "final") { const safe = safeArabicSentence(decision.noteAr); if (safe) note(decision.ok ? "final_ok" : "final_gap", undefined, safe); }
  }

  // where each stage stands (a stage that cannot do more is done: it has what it needs, it was stopped, or it waits for nothing any more)
  const stageDone: boolean[] = [];
  stages.forEach((st, i) => {
    const s = state.stages[i];
    const parentFinished = st.parent === null ? true : stageDone[st.parent] === true;
    stageDone[i] = Boolean(s.stopped) || satisfied(i) || (st.parent === null ? s.listDone : s.queue.length === 0 && parentFinished) || missionStopped || (finished && s.queue.length === 0);
  });
  const missionProgress = { stages: stages.map((st, i) => ({ c: state.stages[i].collected, d: state.stages[i].delivered, x: state.stages[i].excluded, e: st.effVolume, q: state.stages[i].queue.length, done: stageDone[i], ...(state.stages[i].stopped ? { stopped: state.stages[i].stopped } : {}) })) };
  const totalDelivered = state.stages.reduce((sum, s) => sum + s.delivered, 0);
  if (finished && totalDelivered === 0 && delivered.length === 0 && state.stages.some((s) => s.stopped)) {
    return fail("mission_stopped", `${state.stages.find((s) => s.stopped)?.stopped ?? "تعذّر استكمال المهمة"}؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد.`, 200);
  }
  return {
    ok: true, httpStatus: lastHttp, rows: delivered, nextCursor: finished ? null : JSON.stringify(state),
    costUsd: Number((costMicro / 1_000_000).toFixed(6)), costMicro, providerCallCount: calls, tregCallId: lastCallId,
    ...(usage.length ? { reviewModelUsage: usage } : {}), ...(notes.length ? { missionNotes: notes } : {}), missionProgress,
  };
}
