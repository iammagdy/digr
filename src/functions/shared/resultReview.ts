import { z } from "zod";
import type { ExecutionOptions, PlanItem, PlanState } from "./planManager";

export const ReviewSeveritySchema = z.enum(["info", "warning", "critical"]);
export const ReviewSuggestionTypeSchema = z.enum([
  "refine_window",
  "include_replies",
  "narrow_query",
  "language_filter",
  "anonymize",
  "change_columns",
  "dedupe",
  "write_methodology",
  "export_variant",
  "new_collection",
]);

const DateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const SuggestionParamsSchemas = {
  refine_window: z.object({ from: DateStringSchema, to: DateStringSchema }).strict(),
  include_replies: z.object({ enabled: z.boolean() }).strict(),
  narrow_query: z.object({ query: z.string().trim().min(1).max(120) }).strict(),
  language_filter: z.object({ language: z.string().trim().min(2).max(24) }).strict(),
  anonymize: z.object({ enabled: z.boolean() }).strict(),
  change_columns: z.object({ columns: z.array(z.string().trim().min(1).max(64)).min(1).max(20) }).strict(),
  dedupe: z.object({ keys: z.array(z.string().trim().min(1).max(64)).min(1).max(10) }).strict(),
  write_methodology: z.object({ style: z.enum(["brief", "formal"]) }).strict(),
  export_variant: z.object({ formats: z.array(z.enum(["xlsx", "pdf", "csv"])).min(1).max(3) }).strict(),
  new_collection: z.object({ query: z.string().trim().min(1).max(200), maxRows: z.number().int().min(1).max(5000) }).strict(),
} as const;

export const ReviewSuggestionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("refine_window"), labelAr: z.string().trim().min(1).max(80), params: SuggestionParamsSchemas.refine_window }).strict(),
  z.object({ type: z.literal("include_replies"), labelAr: z.string().trim().min(1).max(80), params: SuggestionParamsSchemas.include_replies }).strict(),
  z.object({ type: z.literal("narrow_query"), labelAr: z.string().trim().min(1).max(80), params: SuggestionParamsSchemas.narrow_query }).strict(),
  z.object({ type: z.literal("language_filter"), labelAr: z.string().trim().min(1).max(80), params: SuggestionParamsSchemas.language_filter }).strict(),
  z.object({ type: z.literal("anonymize"), labelAr: z.string().trim().min(1).max(80), params: SuggestionParamsSchemas.anonymize }).strict(),
  z.object({ type: z.literal("change_columns"), labelAr: z.string().trim().min(1).max(80), params: SuggestionParamsSchemas.change_columns }).strict(),
  z.object({ type: z.literal("dedupe"), labelAr: z.string().trim().min(1).max(80), params: SuggestionParamsSchemas.dedupe }).strict(),
  z.object({ type: z.literal("write_methodology"), labelAr: z.string().trim().min(1).max(80), params: SuggestionParamsSchemas.write_methodology }).strict(),
  z.object({ type: z.literal("export_variant"), labelAr: z.string().trim().min(1).max(80), params: SuggestionParamsSchemas.export_variant }).strict(),
  z.object({ type: z.literal("new_collection"), labelAr: z.string().trim().min(1).max(80), params: SuggestionParamsSchemas.new_collection }).strict(),
]);

export const ResultReviewSchema = z.object({
  comparisonAr: z.string().trim().min(1).max(320),
  suggestions: z.array(ReviewSuggestionSchema).max(3),
}).strict();

export type ReviewSeverity = z.infer<typeof ReviewSeveritySchema>;
export type ReviewSuggestion = z.infer<typeof ReviewSuggestionSchema>;
export type ResultReview = z.infer<typeof ResultReviewSchema>;

export interface NormalizedRequestSpec {
  version: 1;
  sources: Array<{ capabilitySlug: string; params: Record<string, unknown>; volumeMin: number; volumeMax: number }>;
  windows: { mode: "none" | "per_day" | "per_week" | "per_month"; from: string | null; to: string | null };
  includeReplies: boolean;
  volumeRange: { min: number; max: number };
  formats: Array<"xlsx" | "pdf" | "csv">;
  languageFilter: string | null;
  anonymize: boolean;
}

export const NormalizedRequestSpecSchema = z.object({
  version: z.literal(1),
  sources: z.array(z.object({
    capabilitySlug: z.string().min(1).max(64),
    params: z.record(z.string(), z.unknown()),
    volumeMin: z.number().int().min(0).max(5000),
    volumeMax: z.number().int().min(0).max(5000),
  }).strict()).max(20),
  windows: z.object({ mode: z.enum(["none", "per_day", "per_week", "per_month"]), from: DateStringSchema.nullable(), to: DateStringSchema.nullable() }).strict(),
  includeReplies: z.boolean(),
  volumeRange: z.object({ min: z.number().int().min(0).max(100000), max: z.number().int().min(0).max(100000) }).strict(),
  formats: z.array(z.enum(["xlsx", "pdf", "csv"])).min(1).max(3),
  languageFilter: z.string().max(24).nullable(),
  anonymize: z.boolean(),
}).strict();

export function parseNormalizedRequestSpec(value: unknown): NormalizedRequestSpec | null {
  const parsed = NormalizedRequestSpecSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export interface RunFacts {
  requested: NormalizedRequestSpec["volumeRange"];
  delivered: number;
  rowsPerSource: Array<{ source: string; count: number; inferred: boolean }>;
  rowsPerWindow: Array<{ window: string; count: number }>;
  dayByDayCoverage: Array<{ date: string; count: number }>;
  duplicateCount: number;
  replyCount: number;
  replyShare: number;
  conversationsWithMultipleItems: number;
  languageShares: Array<{ language: string; count: number; share: number }>;
  emptyWindows: string[];
  failedWindows: string[];
  observedDateRange: { from: string | null; to: string | null };
  unrelatedShare: number | null;
  findings: Array<{ code: string; severity: ReviewSeverity; textAr: string; evidence: Record<string, string | number | boolean | null> }>;
  samples: Array<Record<string, string | number | boolean | null>>;
  severity: ReviewSeverity;
}

function safeString(value: unknown, max = 120): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function safeParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
    const safeKey = safeString(key, 64);
    if (!safeKey || safeKey === "__proto__" || safeKey === "constructor" || safeKey === "prototype") continue;
    if (typeof item === "string") result[safeKey] = safeString(item, 500);
    else if (typeof item === "number" && Number.isFinite(item)) result[safeKey] = item;
    else if (typeof item === "boolean" || item === null) result[safeKey] = item;
    else if (Array.isArray(item)) result[safeKey] = item.slice(0, 20).filter((entry) => typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean");
  }
  return result;
}

function validWindowMode(value: unknown): NormalizedRequestSpec["windows"]["mode"] {
  return value === "per_day" || value === "per_week" || value === "per_month" ? value : "none";
}

export function buildNormalizedRequestSpec(plan: Pick<PlanState, "items" | "outputFormats" | "executionOptions">): NormalizedRequestSpec {
  const options: ExecutionOptions = plan.executionOptions || {};
  const items = Array.isArray(plan.items) ? plan.items : [];
  const sources = items.slice(0, 20).map((item: PlanItem) => ({
    capabilitySlug: safeString(item.capabilitySlug, 64) || "unknown",
    params: safeParams(item.params),
    volumeMin: Math.max(0, Math.floor(Number(item.targetVolumeMin) || 0)),
    volumeMax: Math.max(0, Math.floor(Number(item.targetVolumeMax) || 0)),
  }));
  const min = sources.reduce((sum, item) => sum + item.volumeMin, 0);
  const max = sources.reduce((sum, item) => sum + item.volumeMax, 0);
  const requestedFormats = Array.isArray(plan.outputFormats) ? plan.outputFormats : [];
  const formats = requestedFormats.filter((format): format is "xlsx" | "pdf" | "csv" => format === "xlsx" || format === "pdf" || format === "csv");

  return {
    version: 1,
    sources,
    windows: {
      mode: validWindowMode(options.windowing),
      from: DateStringSchema.safeParse(options.windowFrom).success ? options.windowFrom! : null,
      to: DateStringSchema.safeParse(options.windowTo).success ? options.windowTo! : null,
    },
    includeReplies: options.includeReplies === true,
    volumeRange: { min, max },
    formats: formats.length ? Array.from(new Set(formats)) : ["xlsx", "pdf", "csv"],
    languageFilter: safeString(options.languageFilter, 24) || null,
    anonymize: options.anonymize === true,
  };
}

function dateFromRow(row: Record<string, unknown>): string | null {
  const candidate = row.publishedAt ?? row.createdAt ?? row.timestamp ?? row.date ?? row.collectedDate ?? row.extractedAt;
  if (typeof candidate !== "string" && typeof candidate !== "number") return null;
  const parsed = new Date(candidate);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function stableValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`).join(",")}}`;
}

function rowFingerprint(row: Record<string, unknown>): string {
  for (const key of ["id", "url", "profileUrl", "username", "handle"]) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return `${key}:${value.trim().toLowerCase()}`;
  }
  return stableValue(row);
}

function windowKey(date: string, mode: NormalizedRequestSpec["windows"]["mode"]): string {
  if (mode === "per_month") return date.slice(0, 7);
  if (mode === "per_week") {
    const d = new Date(`${date}T00:00:00.000Z`);
    const day = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - day + 3);
    const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    const firstDay = (firstThursday.getUTCDay() + 6) % 7;
    firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
    const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / 604800000);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
  }
  if (mode === "per_day") return date;
  return "all";
}

function expectedWindowKeys(spec: NormalizedRequestSpec, observedDates: string[]): string[] {
  const { from, to, mode } = spec.windows;
  if (!from || !to || from > to || mode === "none") return mode === "none" ? ["all"] : Array.from(new Set(observedDates.map((date) => windowKey(date, mode)))).sort();
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  const spanDays = Math.floor((end.getTime() - start.getTime()) / 86400000);
  if (spanDays > 366) return [from, to];
  const values = new Set<string>();
  for (let cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    values.add(windowKey(cursor.toISOString().slice(0, 10), mode));
  }
  return Array.from(values).sort();
}

function getSearchTerms(spec: NormalizedRequestSpec): string[] {
  const terms = new Set<string>();
  for (const source of spec.sources) {
    for (const [key, value] of Object.entries(source.params)) {
      if (!/(query|keyword|topic|search)/i.test(key) || typeof value !== "string") continue;
      value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3).forEach((t) => terms.add(t));
    }
  }
  return Array.from(terms).slice(0, 12);
}

function maxSeverity(findings: RunFacts["findings"]): ReviewSeverity {
  if (findings.some((finding) => finding.severity === "critical")) return "critical";
  if (findings.some((finding) => finding.severity === "warning")) return "warning";
  return "info";
}

export function computeRunFacts(
  spec: NormalizedRequestSpec,
  inputRows: unknown[],
  options: { failedWindows?: string[]; sampleLimit?: number } = {},
): RunFacts {
  const rows = (Array.isArray(inputRows) ? inputRows : []).filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row));
  const rowCounts = new Map<string, { count: number; inferred: boolean }>();
  const dates = rows.map(dateFromRow).filter((value): value is string => Boolean(value));
  const dayCounts = new Map<string, number>();
  const windowCounts = new Map<string, number>();
  const fingerprints = new Set<string>();
  let duplicateCount = 0;
  let replyCount = 0;
  const conversations = new Map<string, number>();
  const languages = new Map<string, number>();

  for (const row of rows) {
    const sourceValue = safeString(row.source ?? row.sourceSlug ?? row.capabilitySlug, 64);
    const source = spec.sources.find((item) => item.capabilitySlug === sourceValue)?.capabilitySlug ?? (spec.sources[0]?.capabilitySlug || "unknown");
    const inferred = !sourceValue;
    const sourceCount = rowCounts.get(source) || { count: 0, inferred: true };
    sourceCount.count += 1;
    sourceCount.inferred = sourceCount.inferred && inferred;
    rowCounts.set(source, sourceCount);

    const date = dateFromRow(row);
    if (date) {
      dayCounts.set(date, (dayCounts.get(date) || 0) + 1);
      const key = windowKey(date, spec.windows.mode);
      windowCounts.set(key, (windowCounts.get(key) || 0) + 1);
    }

    const fingerprint = rowFingerprint(row);
    if (fingerprints.has(fingerprint)) duplicateCount += 1;
    fingerprints.add(fingerprint);

    const isReply = row.isReply === true || Boolean(row.replyTo || row.inReplyTo || row.parentId || row.parent_id);
    if (isReply) replyCount += 1;

    const conversation = safeString(row.conversationId ?? row.threadId ?? row.conversation_id, 100);
    if (conversation) conversations.set(conversation, (conversations.get(conversation) || 0) + 1);

    const language = safeString(row.language ?? row.lang, 24).toLowerCase();
    if (language) languages.set(language, (languages.get(language) || 0) + 1);
  }

  const rowsPerSource = spec.sources.map((source) => ({
    source: source.capabilitySlug,
    count: rowCounts.get(source.capabilitySlug)?.count || 0,
    inferred: rowCounts.get(source.capabilitySlug)?.inferred ?? true,
  }));
  const rowsPerWindow = Array.from(windowCounts.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([window, count]) => ({ window, count }));
  const dayByDayCoverage = Array.from(dayCounts.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count }));
  const expectedWindows = expectedWindowKeys(spec, dates);
  const windowsCounts = new Map(rowsPerWindow.map((item) => [item.window, item.count]));
  const emptyWindows = expectedWindows.filter((window) => !windowsCounts.get(window));
  const failedWindows = (options.failedWindows || []).filter((window): window is string => typeof window === "string").slice(0, 100);
  const languageShares = Array.from(languages.entries()).sort(([, a], [, b]) => b - a).slice(0, 20).map(([language, count]) => ({ language, count, share: rows.length ? count / rows.length : 0 }));
  const multiItemConversations = Array.from(conversations.values()).filter((count) => count > 1).length;

  const searchTerms = getSearchTerms(spec);
  let unrelatedShare: number | null = null;
  if (searchTerms.length && rows.length) {
    const checkedRows = rows.slice(0, 100);
    let unrelated = 0;
    for (const row of checkedRows) {
      const text = [row.title, row.text, row.description, row.name, row.query].filter((v) => typeof v === "string").join(" ").toLowerCase();
      if (!text || !searchTerms.some((term) => text.includes(term))) unrelated += 1;
    }
    unrelatedShare = unrelated / checkedRows.length;
  }

  const findings: RunFacts["findings"] = [];
  const delivered = rows.length;
  if (!delivered) {
    findings.push({ code: "empty_result", severity: "critical", textAr: "لم يتم جمع أي سجل للطلب.", evidence: { delivered: 0 } });
  }
  if (delivered < spec.volumeRange.min) {
    const shortfall = spec.volumeRange.min - delivered;
    const severity: ReviewSeverity = delivered < spec.volumeRange.min * 0.5 ? "critical" : "warning";
    findings.push({ code: "below_requested_minimum", severity, textAr: `النتيجة أقل من الحد الأدنى المطلوب بمقدار ${shortfall} سجل.`, evidence: { requestedMin: spec.volumeRange.min, delivered, shortfall } });
  }
  if (spec.includeReplies && delivered && replyCount / delivered < 0.05) {
    const replyShare = replyCount / delivered;
    findings.push({ code: "replies_sparse", severity: replyShare < 0.01 ? "critical" : "warning", textAr: "كانت الردود مطلوبة، لكن حصتها من السجلات قليلة.", evidence: { replies: replyCount, delivered, share: replyShare } });
  }
  const from = spec.windows.from ? new Date(`${spec.windows.from}T00:00:00.000Z`) : null;
  const to = spec.windows.to ? new Date(`${spec.windows.to}T00:00:00.000Z`) : null;
  const requestedDays = from && to && to >= from ? Math.floor((to.getTime() - from.getTime()) / 86400000) + 1 : 0;
  if (requestedDays >= 90 && spec.windows.mode === "none" && dates.length) {
    const earliest = dates.slice().sort()[0];
    const latest = dates.slice().sort().at(-1)!;
    const coveredDays = Math.floor((new Date(`${latest}T00:00:00.000Z`).getTime() - new Date(`${earliest}T00:00:00.000Z`).getTime()) / 86400000) + 1;
    if (coveredDays <= Math.max(7, requestedDays * 0.15)) {
      findings.push({ code: "latest_first_skew", severity: "warning", textAr: "النطاق المطلوب طويل، لكن السجلات المرصودة تتركز في أيام قليلة وحديثة.", evidence: { requestedDays, coveredDays, earliest, latest } });
    }
    if (coveredDays <= Math.max(3, requestedDays * 0.05)) {
      findings.push({ code: "critical_period_coverage", severity: "critical", textAr: "التغطية الزمنية المرصودة أقل من ٥٪ تقريبًا من الفترة المطلوبة.", evidence: { requestedDays, coveredDays, coverageShare: coveredDays / requestedDays, earliest, latest } });
    }
  }
  if (duplicateCount > 0 && duplicateCount / Math.max(delivered, 1) >= 0.1) {
    findings.push({ code: "many_duplicates", severity: "warning", textAr: "تحتوي النتيجة على نسبة ملحوظة من السجلات المتكررة.", evidence: { duplicates: duplicateCount, delivered } });
  }
  if (unrelatedShare !== null && unrelatedShare >= 0.6) {
    findings.push({ code: "many_unrelated_items", severity: "warning", textAr: "عينة الفحص تحتوي على عناصر كثيرة لا يظهر فيها مصطلح البحث.", evidence: { unrelatedShare, checked: Math.min(rows.length, 100) } });
  }
  if (emptyWindows.length && spec.windows.mode !== "none") {
    findings.push({ code: "empty_windows", severity: "warning", textAr: `لم تظهر سجلات في ${emptyWindows.length} فترة مطلوبة.`, evidence: { count: emptyWindows.length, windows: emptyWindows.slice(0, 20).join(", ") } });
  }
  if (failedWindows.length) {
    findings.push({ code: "failed_windows", severity: "warning", textAr: `تعذّر استكمال ${failedWindows.length} فترة من النطاق المطلوب.`, evidence: { count: failedWindows.length } });
  }
  if (!findings.length) {
    findings.push({ code: "within_requested_range", severity: "info", textAr: "عدد السجلات يقع داخل النطاق المحدد، ولم تظهر مؤشرات جودة أساسية في الفحص البرمجي.", evidence: { requestedMin: spec.volumeRange.min, requestedMax: spec.volumeRange.max, delivered } });
  }

  const sampleLimit = Math.max(0, Math.min(5, Number(options.sampleLimit ?? 3)));
  const samples = rows.slice(0, sampleLimit).map((row) => {
    const sample: Record<string, string | number | boolean | null> = {};
    for (const key of Object.keys(row).slice(0, 12)) {
      const value = row[key];
      if (typeof value === "string") sample[safeString(key, 40)] = safeString(value, 500);
      else if (typeof value === "number" && Number.isFinite(value)) sample[safeString(key, 40)] = value;
      else if (typeof value === "boolean") sample[safeString(key, 40)] = value;
      else if (value === null) sample[safeString(key, 40)] = null;
    }
    return sample;
  });

  return {
    requested: spec.volumeRange,
    delivered,
    rowsPerSource,
    rowsPerWindow,
    dayByDayCoverage,
    duplicateCount,
    replyCount,
    replyShare: delivered ? replyCount / delivered : 0,
    conversationsWithMultipleItems: multiItemConversations,
    languageShares,
    emptyWindows,
    failedWindows,
    observedDateRange: dates.length ? { from: dates.slice().sort()[0], to: dates.slice().sort().at(-1)! } : { from: null, to: null },
    unrelatedShare,
    findings,
    samples,
    severity: maxSeverity(findings),
  };
}

function suggestionForFinding(code: string, facts: RunFacts, spec?: NormalizedRequestSpec): ReviewSuggestion | null {
  if (code === "replies_sparse") return { type: "include_replies", labelAr: "راجع إعداد جمع الردود", params: { enabled: true } };
  if ((code === "latest_first_skew" || code === "critical_period_coverage" || code === "empty_windows") && facts.observedDateRange.from && facts.observedDateRange.to) {
    return { type: "refine_window", labelAr: "حدّد الفترة على دفعات", params: { from: facts.observedDateRange.from, to: facts.observedDateRange.to } };
  }
  if (code === "many_duplicates") return { type: "dedupe", labelAr: "احذف السجلات المتكررة", params: { keys: ["id"] } };
  if (code === "many_unrelated_items" && spec) {
    const query = spec.sources.flatMap((source) => Object.entries(source.params)
      .filter(([key, value]) => /(query|keyword|topic|search)/i.test(key) && typeof value === "string")
      .map(([, value]) => safeString(value, 120)))[0];
    if (query) return { type: "narrow_query", labelAr: "ضيّق عبارة البحث", params: { query } };
  }
  if (code === "below_requested_minimum" && spec) {
    const query = spec.sources.map((source) => Object.values(source.params).find((value) => typeof value === "string"))
      .map((value) => safeString(value, 200)).find(Boolean) || "استكمال الطلب السابق";
    return { type: "new_collection", labelAr: "اطلب مجموعة بيانات جديدة", params: { query, maxRows: Math.max(1, Math.min(5000, spec.volumeRange.max)) } };
  }
  return null;
}

export function buildFallbackReview(facts: RunFacts, spec?: NormalizedRequestSpec): ResultReview {
  const requestedMax = facts.requested.max;
  const comparisonAr = `طلبت حتى ${requestedMax.toLocaleString("ar-EG")} سجل، واللي اتجمع فعليًا ${facts.delivered.toLocaleString("ar-EG")} سجل.`;
  const suggestions: ReviewSuggestion[] = [];
  for (const finding of facts.findings) {
    const suggestion = suggestionForFinding(finding.code, facts, spec);
    if (suggestion && !suggestions.some((item) => item.type === suggestion.type)) {
      suggestions.push(suggestion);
    }
    if (suggestions.length === 3) break;
  }
  const validated = ResultReviewSchema.safeParse({ comparisonAr, suggestions });
  if (validated.success) return validated.data;
  return { comparisonAr, suggestions: [] };
}

export function parseResultReview(value: unknown): ResultReview | null {
  const parsed = ResultReviewSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function buildBoundedReviewInput(facts: RunFacts): Pick<RunFacts, "requested" | "delivered" | "findings" | "samples" | "severity"> {
  return {
    requested: facts.requested,
    delivered: facts.delivered,
    findings: facts.findings.slice(0, 30),
    samples: facts.samples.slice(0, 3),
    severity: facts.severity,
  };
}
