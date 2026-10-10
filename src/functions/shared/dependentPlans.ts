import crypto from "node:crypto";
import { z } from "zod";
import { calculateUnitPricePoints, DEFAULT_PRICING_SETTINGS, type PricingSettings } from "./quotes";

export const MAX_DEPENDENT_PLAN_STEPS = 8;
export const MAX_DEPENDENT_FAN_OUT = 50;
export const MAX_DEPENDENT_STEP_VOLUME = 5000;
export const MAX_DEPENDENT_STEP_UPPER_UNITS = 50_000;
export const MAX_DEPENDENT_PLAN_UPPER_UNITS = 100_000;
export const MAX_DEPENDENT_TOTAL_PAGES = 1_000;
export const DEFAULT_DEPENDENT_MAX_PAGES_PER_INPUT = 20;

export const DependentInputFromSchema = z.object({
  stepId: z.string().min(1).max(32).regex(/^[a-zA-Z0-9_-]+$/),
  field: z.string().min(1).max(64).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  paramKey: z.string().min(1).max(64).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
}).strict();

export const DependentPlanStepSchema = z.object({
  stepId: z.string().min(1).max(32).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  capabilitySlug: z.string().min(1).max(96),
  params: z.record(z.string(), z.unknown()),
  targetVolumeMin: z.number().int().min(1).max(MAX_DEPENDENT_STEP_VOLUME),
  targetVolumeMax: z.number().int().min(1).max(MAX_DEPENDENT_STEP_VOLUME),
  dependsOn: z.array(z.string().min(1).max(32).regex(/^[a-zA-Z0-9_-]+$/)).max(4).optional(),
  inputFrom: DependentInputFromSchema.optional(),
  fanOutCap: z.number().int().min(1).max(MAX_DEPENDENT_FAN_OUT).optional(),
  volumeMode: z.enum(["bounded", "open_ended"]).optional(),
  windowed: z.boolean().optional(),
}).strict();

export interface DependentPlanStep {
  stepId?: string;
  capabilitySlug: string;
  params: Record<string, unknown>;
  targetVolumeMin: number;
  targetVolumeMax: number;
  dependsOn?: string[];
  inputFrom?: { stepId: string; field: string; paramKey: string };
  fanOutCap?: number;
  volumeMode?: "bounded" | "open_ended";
  windowed?: boolean;
}

export interface StepCostRange {
  stepId: string;
  capabilitySlug: string;
  labelAr?: string;
  minUnits: number;
  maxUnits: number;
  unitPricePoints: number;
  minPoints: number;
  maxPoints: number;
}

export interface DependentPlanQuote {
  isDependent: true;
  targetVolumeMax: number;
  quotedPoints: number;
  unitPricePoints: number;
  isAffordable: boolean;
  stepCostRanges: StepCostRange[];
}

export function hasDependentSteps(items: readonly DependentPlanStep[]): boolean {
  return items.some((item) => Boolean(item.inputFrom) || Boolean(item.dependsOn?.length));
}

export function resolveStepId(step: DependentPlanStep, index: number): string {
  return step.stepId || `${step.capabilitySlug}_${index + 1}`;
}

export function validateDependentPlanSteps(items: readonly DependentPlanStep[]): { valid: boolean; dependent: boolean; errors: string[] } {
  const dependent = hasDependentSteps(items);
  if (!dependent) return { valid: true, dependent: false, errors: [] };
  const errors: string[] = [];
  if (items.length > MAX_DEPENDENT_PLAN_STEPS) errors.push(`الحد الأقصى ${MAX_DEPENDENT_PLAN_STEPS} خطوات للخطة متعددة المراحل.`);
  const parsed = items.map((item) => DependentPlanStepSchema.safeParse(item));
  parsed.forEach((result, index) => {
    if (!result.success) errors.push(`بيانات الخطوة ${index + 1} غير صالحة.`);
  });
  if (parsed.some((result) => !result.success)) return { valid: false, dependent, errors };

  const ids = items.map((item, index) => resolveStepId(item, index));
  if (new Set(ids).size !== ids.length) errors.push("معرّفات خطوات الخطة يجب أن تكون فريدة.");
  if (items.some((item) => !item.stepId)) errors.push("كل خطوة في الخطة متعددة المراحل تحتاج معرّفاً ثابتاً.");

  const positions = new Map(ids.map((id, index) => [id, index]));
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const id = ids[index];
    if (item.targetVolumeMin > item.targetVolumeMax) errors.push(`الحد الأدنى في الخطوة ${id} أكبر من الحد الأقصى.`);
    if (item.volumeMode === "open_ended" && (!Number.isInteger(item.targetVolumeMax) || item.targetVolumeMax < 1)) {
      errors.push(`الخطة المفتوحة تحتاج سقفاً رقمياً صريحاً قبل عرض السعر (${id}).`);
    }
    const dependencies = item.dependsOn || [];
    if (new Set(dependencies).size !== dependencies.length) errors.push(`تكرار في روابط الاعتماد للخطوة ${id}.`);
    for (const dependency of dependencies) {
      const dependencyPosition = positions.get(dependency);
      if (dependencyPosition === undefined || dependencyPosition >= index) {
        errors.push(`الخطوة ${id} تعتمد على خطوة غير موجودة أو غير سابقة (${dependency}).`);
      }
    }
    if (item.inputFrom) {
      if (!dependencies.includes(item.inputFrom.stepId)) errors.push(`مصدر المدخلات يجب أن يكون ضمن dependsOn للخطوة ${id}.`);
      const sourcePosition = positions.get(item.inputFrom.stepId);
      if (sourcePosition === undefined || sourcePosition >= index) errors.push(`مصدر المدخلات غير صالح للخطوة ${id}.`);
      if (!Number.isInteger(item.fanOutCap) || !item.fanOutCap || item.fanOutCap < 1 || item.fanOutCap > MAX_DEPENDENT_FAN_OUT) {
        errors.push(`الخطوة ${id} تحتاج سقف تفريع من 1 إلى ${MAX_DEPENDENT_FAN_OUT}.`);
      }
    }
  }
  return { valid: errors.length === 0, dependent, errors };
}

export function calculateDependentPlanQuote(
  items: readonly DependentPlanStep[],
  capabilities: readonly { slug: string; unitCostUsd: number; nameAr?: string }[],
  userBalance: number,
  pricing: PricingSettings = DEFAULT_PRICING_SETTINGS,
): DependentPlanQuote {
  const validation = validateDependentPlanSteps(items);
  if (!validation.valid || !validation.dependent) throw new Error(validation.errors.join(" ") || "الخطة ليست متعددة المراحل.");
  let totalMaxUnits = 0;
  let totalRawMaxPoints = 0;
  const stepCostRanges: StepCostRange[] = items.map((step, index) => {
    const capability = capabilities.find((candidate) => candidate.slug === step.capabilitySlug);
    if (!capability || !Number.isFinite(capability.unitCostUsd) || capability.unitCostUsd < 0) {
      throw new Error(`تعذر احتساب الحد الأعلى لتكلفة الخطوة ${resolveStepId(step, index)}.`);
    }
    const fanOut = step.inputFrom ? (step.fanOutCap || 0) : 1;
    const maxUnits = step.targetVolumeMax * fanOut;
    if (!Number.isSafeInteger(maxUnits) || maxUnits > MAX_DEPENDENT_STEP_UPPER_UNITS) {
      throw new Error(`الحد الأعلى لحجم الخطوة ${resolveStepId(step, index)} يتجاوز السقف المسموح.`);
    }
    const minUnits = step.inputFrom ? 0 : step.targetVolumeMin;
    const unitPricePoints = calculateUnitPricePoints(capability.unitCostUsd, pricing);
    const minPoints = Math.ceil(minUnits * unitPricePoints);
    const maxPoints = Math.max(pricing.minPoints, Math.ceil(maxUnits * unitPricePoints * (1 + pricing.safetyBuffer)));
    totalMaxUnits += maxUnits;
    totalRawMaxPoints += maxUnits * unitPricePoints;
    return {
      stepId: resolveStepId(step, index),
      capabilitySlug: step.capabilitySlug,
      labelAr: capability.nameAr,
      minUnits,
      maxUnits,
      unitPricePoints,
      minPoints,
      maxPoints,
    };
  });
  if (totalMaxUnits > MAX_DEPENDENT_PLAN_UPPER_UNITS) throw new Error("الحد الأعلى للخطة يتجاوز السقف الإجمالي المسموح.");
  const quotedPoints = stepCostRanges.reduce((sum, step) => sum + step.maxPoints, 0);
  return {
    isDependent: true,
    targetVolumeMax: totalMaxUnits,
    quotedPoints,
    unitPricePoints: totalMaxUnits ? totalRawMaxPoints / totalMaxUnits : 0,
    isAffordable: userBalance >= quotedPoints,
    stepCostRanges,
  };
}

export interface DependentWindow {
  from: string;
  to: string;
}

export interface FakeTregPage {
  ok: boolean;
  rows: Array<Record<string, unknown>>;
  nextCursor?: string | null;
  errorCode?: string;
}

export interface FakeTregRequest {
  stepId: string;
  capabilitySlug: string;
  params: Record<string, unknown>;
  inputValue?: unknown;
  cursor: string | null;
  page: number;
  window: DependentWindow | null;
  limit: number;
}

export type FakeTregFetcher = (request: FakeTregRequest) => Promise<FakeTregPage>;

export interface DependentInputRun {
  key: string;
  inputValue?: unknown;
  params: Record<string, unknown>;
  rows: Array<Record<string, unknown>>;
  cursor: string | null;
  page: number;
  windowIndex: number;
  done: boolean;
  failed: boolean;
  paused: boolean;
  visitedCursors: string[];
  pagesFetched: number;
  errorCode?: string;
}

export interface DependentStepRun {
  status: "pending" | "running" | "partial" | "done" | "failed" | "blocked";
  inputRuns: DependentInputRun[];
  errorCodes: string[];
}

export interface DependentPlanRunState {
  version: 1;
  planHash: string;
  status: "pending" | "running" | "partial" | "done" | "failed" | "cancelled";
  steps: Record<string, DependentStepRun>;
  outputs: Record<string, Array<Record<string, unknown>>>;
  seenKeys: string[];
  windows: DependentWindow[];
}

export interface RunDependentPlanOptions {
  steps: readonly DependentPlanStep[];
  fetchPage: FakeTregFetcher;
  state?: DependentPlanRunState;
  windows?: DependentWindow[];
  shouldCancel?: () => boolean | Promise<boolean>;
  maxPagesPerInput?: number;
}

export function createDependentPlanState(windows: DependentWindow[] = [], planHash = ""): DependentPlanRunState {
  return { version: 1, planHash, status: "pending", steps: {}, outputs: {}, seenKeys: [], windows: windows.map((window) => ({ ...window })) };
}

function validateRunState(state: DependentPlanRunState): void {
  if (!state || state.version !== 1 || typeof state.planHash !== "string" || !state.steps || !state.outputs || !Array.isArray(state.seenKeys) || !Array.isArray(state.windows)) {
    throw new Error("حالة استئناف الخطة غير صالحة.");
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function dedupeKey(row: Record<string, unknown>): string {
  const entity = String(row.entityType || row.kind || row.type || "").toLocaleLowerCase();
  const value = row.videoId ?? row.id ?? row.username ?? row.uniqueId ?? row.profileUrl ?? row.url;
  const identity = value === undefined || value === null || value === ""
    ? crypto.createHash("sha256").update(stableJson(row)).digest("hex")
    : String(value).trim().toLocaleLowerCase();
  return `${entity}:${identity}`;
}

function primitiveInput(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function createInputRuns(step: DependentPlanStep, index: number, outputs: Record<string, Array<Record<string, unknown>>>): DependentInputRun[] {
  if (!step.inputFrom) {
    return [{ key: "root", params: { ...step.params }, rows: [], cursor: null, page: 1, windowIndex: 0, done: false, failed: false, paused: false, visitedCursors: [], pagesFetched: 0 }];
  }
  const sourceRows = outputs[step.inputFrom.stepId] || [];
  const unique = new Map<string, string | number | boolean>();
  for (const row of sourceRows) {
    const value = row[step.inputFrom.field];
    if (!primitiveInput(value)) continue;
    const normalized = String(value).trim();
    if (!normalized) continue;
    const key = normalized.toLocaleLowerCase();
    if (!unique.has(key)) unique.set(key, value);
  }
  return [...unique.entries()].slice(0, step.fanOutCap || 0).map(([key, value]) => ({
    key,
    inputValue: value,
    params: { ...step.params, [step.inputFrom!.paramKey]: value },
    rows: [],
    cursor: null,
    page: 1,
    windowIndex: 0,
    done: false,
    failed: false,
    paused: false,
    visitedCursors: [],
    pagesFetched: 0,
  }));
}

export async function runDependentPlanWithFakeTreg(options: RunDependentPlanOptions): Promise<DependentPlanRunState> {
  const { steps, fetchPage, shouldCancel = () => false } = options;
  const validation = validateDependentPlanSteps(steps);
  if (!validation.valid || !validation.dependent) throw new Error(validation.errors.join(" ") || "المحرك التجريبي يقبل الخطط متعددة المراحل فقط.");
  const maxPages = Math.max(1, Math.min(100, Math.floor(options.maxPagesPerInput || DEFAULT_DEPENDENT_MAX_PAGES_PER_INPUT)));
  const windows = options.windows || options.state?.windows || [];
  if (windows.length > 60 || windows.some((window) => !window.from || !window.to || window.from > window.to)) {
    throw new Error("نوافذ التاريخ غير صالحة أو تتجاوز الحد المسموح.");
  }
  const planHash = crypto.createHash("sha256").update(stableJson(steps)).digest("hex");
  const state: DependentPlanRunState = options.state ? JSON.parse(JSON.stringify(options.state)) : createDependentPlanState(windows, planHash);
  validateRunState(state);
  if (state.planHash !== planHash) throw new Error("الخطة تغيرت؛ لا يمكن استئناف حالة التنفيذ القديمة.");
  if (options.state && JSON.stringify(state.windows) !== JSON.stringify(windows)) throw new Error("لا يمكن تغيير نوافذ التاريخ أثناء استئناف الخطة.");
  const seen = new Set(state.seenKeys);
  state.status = "running";
  for (const stepRun of Object.values(state.steps)) {
    for (const inputRun of stepRun.inputRuns) {
      if (!Number.isSafeInteger(inputRun.pagesFetched) || inputRun.pagesFetched < 0) inputRun.pagesFetched = 0;
      if (inputRun.paused && !inputRun.errorCode) inputRun.paused = false;
    }
  }

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const stepId = resolveStepId(step, index);
    let stepRun = state.steps[stepId];
    if (stepRun?.status === "done") continue;
    if (!stepRun) {
      stepRun = { status: "pending", inputRuns: [], errorCodes: [] };
      state.steps[stepId] = stepRun;
    }
    const dependencies = step.dependsOn || [];
    if (dependencies.some((dependency) => !state.steps[dependency] || ["pending", "running", "blocked"].includes(state.steps[dependency].status))) {
      stepRun.status = "blocked";
      stepRun.errorCodes = [...new Set([...stepRun.errorCodes, "dependency_incomplete"])];
      continue;
    }
    if (!stepRun.inputRuns.length) stepRun.inputRuns = createInputRuns(step, index, state.outputs);
    if (!stepRun.inputRuns.length) {
      stepRun.status = "blocked";
      stepRun.errorCodes = [...new Set([...stepRun.errorCodes, "no_dependency_inputs"])];
      continue;
    }
    stepRun.status = "running";
    state.outputs[stepId] ||= [];
    let pausedAtPageLimit = false;

    for (const inputRun of stepRun.inputRuns) {
      if (inputRun.done || inputRun.failed) continue;
      let pagesThisInvocation = 0;
      const activeWindows: Array<DependentWindow | null> = step.windowed && windows.length ? windows : [null];
      while (!inputRun.done && !inputRun.failed && !inputRun.paused) {
        if (await shouldCancel()) {
          stepRun.status = "partial";
          state.status = "cancelled";
          state.seenKeys = [...seen];
          return state;
        }
        if (inputRun.windowIndex >= activeWindows.length) {
          inputRun.done = true;
          break;
        }
        if (pagesThisInvocation >= maxPages) {
          inputRun.paused = true;
          pausedAtPageLimit = true;
          break;
        }
        const totalPagesFetched = Object.values(state.steps).reduce(
          (total, currentStep) => total + currentStep.inputRuns.reduce((subtotal, run) => subtotal + run.pagesFetched, 0),
          0,
        );
        if (totalPagesFetched >= MAX_DEPENDENT_TOTAL_PAGES) {
          inputRun.paused = true;
          inputRun.errorCode = "plan_page_cap";
          stepRun.errorCodes = [...new Set([...stepRun.errorCodes, "plan_page_cap"])];
          break;
        }
        const page = await fetchPage({
          stepId,
          capabilitySlug: step.capabilitySlug,
          params: inputRun.params,
          ...(inputRun.inputValue === undefined ? {} : { inputValue: inputRun.inputValue }),
          cursor: inputRun.cursor,
          page: inputRun.page,
          window: activeWindows[inputRun.windowIndex],
          limit: Math.max(0, step.targetVolumeMax - inputRun.rows.length),
        });
        pagesThisInvocation += 1;
        inputRun.pagesFetched += 1;
        if (!page.ok) {
          inputRun.failed = true;
          const errorCode = /^[a-z0-9_]{1,64}$/i.test(page.errorCode || "") ? page.errorCode! : "source_error";
          inputRun.errorCode = errorCode;
          stepRun.errorCodes = [...new Set([...stepRun.errorCodes, errorCode])];
          break;
        }
        for (const rawRow of page.rows.slice(0, step.targetVolumeMax - inputRun.rows.length)) {
          const row = rawRow && typeof rawRow === "object" && !Array.isArray(rawRow) ? rawRow : { value: rawRow };
          const key = dedupeKey(row);
          if (seen.has(key)) continue;
          seen.add(key);
          inputRun.rows.push(row);
          state.outputs[stepId].push(row);
        }
        if (inputRun.rows.length >= step.targetVolumeMax) {
          inputRun.done = true;
          break;
        }
        if (!page.nextCursor) {
          inputRun.windowIndex += 1;
          inputRun.cursor = null;
          inputRun.page = 1;
          inputRun.visitedCursors = [];
          if (inputRun.windowIndex >= activeWindows.length) inputRun.done = true;
          continue;
        }
        if (inputRun.visitedCursors.includes(page.nextCursor)) {
          inputRun.paused = true;
          inputRun.errorCode = "cursor_loop";
          stepRun.errorCodes = [...new Set([...stepRun.errorCodes, "cursor_loop"])];
          break;
        }
        inputRun.visitedCursors.push(page.nextCursor);
        inputRun.cursor = page.nextCursor;
        inputRun.page += 1;
      }
    }

    const successfulRuns = stepRun.inputRuns.filter((run) => run.rows.length > 0 || run.done);
    const failedRuns = stepRun.inputRuns.some((run) => run.failed || run.paused);
    stepRun.status = failedRuns ? "partial" : successfulRuns.length ? "done" : "failed";
    if (!state.outputs[stepId].length && !stepRun.errorCodes.includes("no_dependency_inputs") && stepRun.status === "failed") {
      stepRun.errorCodes = [...new Set([...stepRun.errorCodes, "no_rows"] )];
    }
    if (pausedAtPageLimit) {
      state.status = "partial";
      state.seenKeys = [...seen];
      return state;
    }
  }

  state.seenKeys = [...seen];
  if (Object.values(state.steps).some((step) => step.status === "partial" || step.status === "failed" || step.status === "blocked")) {
    state.status = "partial";
  } else {
    state.status = "done";
  }
  return state;
}

export function calculateDependentSettlement(
  steps: readonly DependentPlanStep[],
  ranges: readonly StepCostRange[],
  state: DependentPlanRunState,
  reservedPoints: number,
): { deliveredUnits: number; chargePoints: number; refundPoints: number; stepDeliveredUnits: Record<string, number> } {
  const rangeById = new Map(ranges.map((range) => [range.stepId, range]));
  const stepDeliveredUnits: Record<string, number> = {};
  let rawCharge = 0;
  let deliveredUnits = 0;
  steps.forEach((step, index) => {
    const id = resolveStepId(step, index);
    const rows = state.outputs[id] || [];
    const range = rangeById.get(id);
    if (!range) return;
    const units = Math.min(rows.length, range.maxUnits);
    stepDeliveredUnits[id] = units;
    deliveredUnits += units;
    rawCharge += Math.ceil(units * range.unitPricePoints);
  });
  const safeReserve = Number.isFinite(reservedPoints) ? Math.max(0, Math.floor(reservedPoints)) : 0;
  const chargePoints = Math.min(safeReserve, Math.max(0, rawCharge));
  return { deliveredUnits, chargePoints, refundPoints: safeReserve - chargePoints, stepDeliveredUnits };
}
