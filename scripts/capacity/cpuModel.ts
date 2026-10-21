/**
 * CPU model for the hosting plan's Active CPU allowance (Hobby: 4 hours a month, about 3 h 25 min left, binding for Saturday).
 *
 * What is measured and what is assumed (nothing here is a live number):
 *  - MEASURED, in the offline harness (tests/cpu-measure-*.test.ts, docs/capacity/cpu-measurements.json): the CPU a handler needs, in
 *    milliseconds on the build machine, for each route and for a whole mission through the real worker (chunks, Excel, PDF).
 *  - ANCHOR, from the owner's usage page: the average invocation costs about 0.108 s of Active CPU. A handler needs 0.05 to 25 ms, so
 *    almost all of that is per-invocation overhead (the framework, the sign-in check, the database client, cold starts). The model
 *    therefore charges  cost(route) = overhead + raw_ms x speed / 1000,  with the overhead FITTED so that the pre-change mix of one
 *    visitor session averages exactly 0.108 s per invocation.
 *  - ASSUMED: how many invocations a visitor and a mission make (counted from the code's own polling constants and the routes the page
 *    calls), how many instances start cold, and `speed` (how much slower the hosting CPU runs handler code than the build machine).
 * Two parameter sets are reported: BASE (speed 2, the fitted overhead) and STRESS (speed 6, overhead 0.15 s, twice the cold starts).
 * The decision rule of the brief is applied to STRESS: under 2 CPU-hours stay on the plan; 2 to 3 stay with reduced invocations and
 * hourly monitoring; above 3 recommend a higher plan before Saturday.
 */
export const OWNER_AVG_INVOCATION_S = 0.108;
export const CPU_REMAINING_H = 3 + 25 / 60;
export const CPU_ALLOWANCE_H = 4;

export type RouteName =
  | "chat_greeting" | "chat_question" | "chat_plan" | "busy_status" | "llm_enabled" | "driver_status" | "wallet_balance"
  | "accept_quote" | "nudge" | "results_view" | "artifacts" | "download";

export interface Measurements {
  samples: Record<string, { medianMs: number }>;
  extra: Record<string, { calls: number; totalMs: number; lastCallMs: number; firstCallMs: number }>;
}

/** Raw handler CPU (ms on the build machine) for every route. Routes without their own measurement use the stated proxy. */
export function rawMsByRoute(m: Measurements): Record<RouteName, number> {
  const s = (name: string) => m.samples[name]?.medianMs ?? 0;
  return {
    chat_greeting: s("chat_greeting"),
    chat_question: s("chat_question"),
    chat_plan: s("chat_plan"),
    busy_status: s("busy_status"),
    llm_enabled: s("llm_enabled"),
    driver_status: s("driver_status"),
    wallet_balance: s("wallet_balance"),
    // proxies, said out loud: approval and the stall nudge do a few reads and one write like a greeting turn; the results view parses
    // and normalises a stored file like a question turn; artifacts and download hand out a signed link
    accept_quote: s("chat_greeting"),
    nudge: s("chat_greeting"),
    results_view: s("chat_question"),
    artifacts: s("wallet_balance"),
    download: s("wallet_balance"),
  };
}

export interface SessionAssumptions {
  sessionMinutes: number;
  pageLoads: number;
  balanceReadsBefore: number;
  balanceReadsAfter: number;
  turns: { chat_greeting: number; chat_question: number; chat_plan: number };
  /** Average gap between two status polls of one page before the edge cache (60 s plus up to 8 s of jitter). */
  busyPollAvgMs: number;
  /** How long the event keeps visitors arriving (hours): the edge-cached routes run once per ttl per region over this time. */
  eventHours: number;
  cdnRegions: number;
}

export const DEFAULT_SESSION: SessionAssumptions = {
  sessionMinutes: 90,
  pageLoads: 2,
  balanceReadsBefore: 8,
  balanceReadsAfter: 5,
  turns: { chat_greeting: 1, chat_question: 2, chat_plan: 3 },
  busyPollAvgMs: 64_000,
  eventHours: 6,
  cdnRegions: 2,
};

export type Variant = "before" | "after";
export type Counts = Partial<Record<RouteName, number>>;

/** Invocations one visitor causes in a session of chat only (no mission). */
export function visitorInvocations(variant: Variant, a: SessionAssumptions = DEFAULT_SESSION): Counts {
  const turns = a.turns;
  const base: Counts = { chat_greeting: turns.chat_greeting, chat_question: turns.chat_question, chat_plan: turns.chat_plan };
  if (variant === "before") {
    return { ...base, busy_status: (a.sessionMinutes * 60_000) / a.busyPollAvgMs, llm_enabled: a.pageLoads, driver_status: a.pageLoads, wallet_balance: a.balanceReadsBefore };
  }
  return { ...base, wallet_balance: a.balanceReadsAfter };
}

/** Invocations of the three public status routes for the whole room once the edge keeps their answer (after only). */
export function roomCachedInvocations(a: SessionAssumptions = DEFAULT_SESSION): Counts {
  const per = (ttlS: number) => Math.ceil((a.eventHours * 3600) / ttlS) * a.cdnRegions;
  return { busy_status: per(15), llm_enabled: per(30), driver_status: per(300) };
}

export interface MissionShape { id: string; titleAr: string; rows: number; formats: "csv" | "xlsx" | "xlsx_pdf" }

/** The showcase missions at the largest size one 600-point request allows. */
export const SHOWCASE_MISSIONS: MissionShape[] = [
  { id: "tiktok_channels_comments", titleAr: "أعلى فيديوهات قنوات تيك توك مع التعليقات", rows: 86, formats: "xlsx_pdf" },
  { id: "x_event_window", titleAr: "منشورات إكس عن حدث بنافذة تاريخ", rows: 104, formats: "xlsx_pdf" },
  { id: "facebook_page_posts", titleAr: "منشورات صفحة فيسبوك", rows: 47, formats: "xlsx_pdf" },
  { id: "companies_decision_makers", titleAr: "شركات ثم صناع القرار", rows: 173, formats: "xlsx_pdf" },
];

const ROWS_PER_CHUNK = 50;

/** Worker calls of a mission: one per chunk of rows (the measured 100-row mission took 2). */
export function missionChunks(rows: number): number {
  return Math.max(1, Math.ceil(rows / ROWS_PER_CHUNK));
}

/** Raw CPU (ms) of the worker side of a mission: the measured total for 100 rows, scaled by rows, with the file work of its format. */
export function missionWorkerRawMs(m: Measurements, shape: MissionShape): number {
  const key = shape.formats === "csv" ? "mission_csv" : shape.formats === "xlsx" ? "mission_xlsx" : "mission_xlsx_pdf";
  const measured = m.extra[key];
  if (!measured) return 0;
  // the last call carries the files and the settlement (about constant in rows for the sizes a job can have); the others scale by chunk
  const chunkMs = (measured.totalMs - measured.lastCallMs) / Math.max(1, measured.calls - 1);
  return measured.lastCallMs + chunkMs * (missionChunks(shape.rows) - 1);
}

/** Other invocations of a mission: the approval, the stall nudge, the results view, the artifact list and one download per format. */
export function missionOtherInvocations(shape: MissionShape): Counts {
  return { accept_quote: 1, nudge: 1, results_view: 1, artifacts: 2, download: shape.formats === "csv" ? 1 : 2 };
}

export interface ModelParams { id: "base" | "stress"; speed: number; overheadS: number | "fit"; coldStarts: number; coldStartS: number }
export const BASE_PARAMS: ModelParams = { id: "base", speed: 2, overheadS: "fit", coldStarts: 150, coldStartS: 0.8 };
export const STRESS_PARAMS: ModelParams = { id: "stress", speed: 6, overheadS: 0.15, coldStarts: 300, coldStartS: 1 };

const sum = (counts: Counts) => Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);

/** The per-invocation overhead (s) that makes the pre-change mix of a visitor session average OWNER_AVG_INVOCATION_S. */
export function fittedOverheadS(m: Measurements, speed: number, a: SessionAssumptions = DEFAULT_SESSION): number {
  const raw = rawMsByRoute(m);
  const mix = visitorInvocations("before", a);
  const invocations = sum(mix);
  const meanRawMs = Object.entries(mix).reduce((acc, [route, n]) => acc + (n ?? 0) * raw[route as RouteName], 0) / invocations;
  return Math.max(0, OWNER_AVG_INVOCATION_S - (meanRawMs * speed) / 1000);
}

export function overheadOf(params: ModelParams, m: Measurements, a: SessionAssumptions = DEFAULT_SESSION): number {
  return params.overheadS === "fit" ? fittedOverheadS(m, params.speed, a) : params.overheadS;
}

/** CPU seconds of a set of invocations plus extra raw milliseconds of heavy work (files, chunks). */
export function cpuSeconds(counts: Counts, extraRawMs: number, m: Measurements, params: ModelParams, a: SessionAssumptions = DEFAULT_SESSION): number {
  const raw = rawMsByRoute(m);
  const overhead = overheadOf(params, m, a);
  let seconds = 0;
  for (const [route, n] of Object.entries(counts)) seconds += (n ?? 0) * (overhead + (raw[route as RouteName] * params.speed) / 1000);
  return seconds + (extraRawMs * params.speed) / 1000;
}

/** One mission: the worker calls (their own overhead each) and the other invocations. */
export function missionCpuSeconds(shape: MissionShape, m: Measurements, params: ModelParams, a: SessionAssumptions = DEFAULT_SESSION): number {
  const workerCalls = missionChunks(shape.rows);
  const overhead = overheadOf(params, m, a);
  return workerCalls * overhead + cpuSeconds(missionOtherInvocations(shape), missionWorkerRawMs(m, shape), m, params, a);
}

export interface ScenarioSpec { id: "chat_only" | "quarter_missions" | "all_missions"; titleAr: string; missionShare: number }
export const SCENARIOS: ScenarioSpec[] = [
  { id: "chat_only", titleAr: "محادثة فقط", missionShare: 0 },
  { id: "quarter_missions", titleAr: "٢٥٪ يبدؤون مهمة", missionShare: 0.25 },
  { id: "all_missions", titleAr: "الجميع يبدأ مهمة", missionShare: 1 },
];

export const VISITORS = 500;

/** CPU hours of the whole event for 500 visitors. A mission is the average of the four showcase shapes. */
export function eventCpuHours(variant: Variant, scenario: ScenarioSpec, m: Measurements, params: ModelParams, a: SessionAssumptions = DEFAULT_SESSION): number {
  const perVisitor = cpuSeconds(visitorInvocations(variant, a), 0, m, params, a) * VISITORS;
  const room = variant === "after" ? cpuSeconds(roomCachedInvocations(a), 0, m, params, a) : 0;
  const missionAvg = SHOWCASE_MISSIONS.reduce((acc, shape) => acc + missionCpuSeconds(shape, m, params, a), 0) / SHOWCASE_MISSIONS.length;
  const missions = missionAvg * VISITORS * scenario.missionShare;
  const cold = params.coldStarts * params.coldStartS;
  return (perVisitor + room + missions + cold) / 3600;
}

export type Hosting = "stay" | "reduce" | "upgrade";

/** The rule of the brief: under 2 CPU-hours stay; 2 to 3 stay with reduced invocations and hourly monitoring; above 3 recommend a higher plan. */
export function recommendHosting(cpuHours: number): { level: Hosting; textAr: string } {
  if (cpuHours < 2) return { level: "stay", textAr: "نبقى على الخطة الحالية." };
  if (cpuHours <= 3) return { level: "reduce", textAr: "نبقى على الخطة الحالية مع تقليل الطلبات ومراقبة كل ساعة." };
  return { level: "upgrade", textAr: "نوصي بخطة أعلى قبل السبت." };
}

export function sessionSeconds(variant: Variant, m: Measurements, params: ModelParams, a: SessionAssumptions = DEFAULT_SESSION): number {
  return cpuSeconds(visitorInvocations(variant, a), 0, m, params, a);
}
