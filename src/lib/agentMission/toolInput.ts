import { cairoDayEndExclusiveMs, cairoDayStartMs, operatorStampUtc, utcDayOf } from "./cairoTime";
import type { CatalogEndpoint } from "../treg/catalog";
import { isEnabled, type StageFilter } from "./filters";
import { placeEntry } from "./places";
import { toolProfile, type ConditionClass, type ToolProfile } from "./toolProfile";

/**
 * THE CODE-BUILT PROVIDER REQUEST (docs/REDESIGN.md section 3, S1 item 1.6). The model chooses a tool and measures it; CODE writes the customer's conditions into that tool's OWN input fields from the structured record of what was asked:
 * the period (a preset, a date range, or `since:`/`until:` inside the query of a search that takes operators), the language, the country, the account, the page size, the sort and the replies. Three rules:
 *   - a condition the tool has no field for is a reported GAP (`no_field`, or `not_enforced` for a region that only places the request); no field is ever invented;
 *   - an input the endpoint does not have, or an enumeration value outside its list, is REFUSED (`refused`): the old path let the gateway delete such a field silently, so the request that was recorded was not the request that ran;
 *   - the base inputs are never mutated; the result is a new object.
 * Pure: no I/O, no model.
 */
export interface Understood {
  period?: { days?: number; from?: string; to?: string };
  language?: string;
  /** ISO country codes. */
  country?: string[];
  /** Account handles without «@». */
  account?: string[];
  count?: number;
  replies?: "exclude" | "include";
  sort?: "latest" | "top";
  /** «Now», for a period counted in days (tests pass a fixed moment). */
  nowMs?: number;
}
export type GapReason = "no_field" | "not_enforced" | "not_in_enum" | "unknown_format";
export interface Gap { cls: ConditionClass; reason: GapReason }
export interface RefusedField { field: string; reason: "unknown_field" | "not_in_enum" }
export interface BuiltInput {
  /** True when every base field is a real input of the endpoint with an allowed value: only then is the recipe «built by code». */
  ok: boolean;
  params: Record<string, unknown>;
  gaps: Gap[];
  refused: RefusedField[];
  /** The condition classes written into the request. */
  written: ConditionClass[];
}

const DAY = 86_400_000;
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The span in days a preset value stands for (Infinity for «all time»), read from its words; null when it names none. */
export function presetDays(value: string): number | null {
  const v = value.toLowerCase();
  if (/all[-_ ]?time|any/.test(v)) return Number.POSITIVE_INFINITY;
  const n = v.match(/(\d+)[-_ ]?(day|week|month|year)s?/);
  if (n) return Number(n[1]) * ({ day: 1, week: 7, month: 30, year: 365 } as const)[n[2] as "day"];
  if (/yesterday|24[-_ ]?h|today|past[-_ ]?day|^day$/.test(v)) return 1;
  if (/week/.test(v)) return 7;
  if (/month/.test(v)) return 30;
  if (/year/.test(v)) return 365;
  return null;
}

/** The days the period covers, counted back from now. */
function daysOf(period: NonNullable<Understood["period"]>, now: number): number | null {
  if (period.days !== undefined) return period.days;
  if (period.from) { const from = Date.parse(`${period.from}T00:00:00Z`); return Number.isFinite(from) ? Math.max(1, Math.ceil((now - from) / DAY)) : null; }
  return null;
}

const stripQuery = (q: string): string => q.trim();
const hasOperator = (q: string, op: RegExp): boolean => op.test(q);

export function buildToolInput(endpoint: CatalogEndpoint, understood: Understood, base: Record<string, unknown>): BuiltInput {
  const profile: ToolProfile = toolProfile(endpoint);
  const now = understood.nowMs ?? Date.now();
  const params: Record<string, unknown> = { ...base };
  const gaps: Gap[] = [];
  const written: ConditionClass[] = [];
  const refused: RefusedField[] = [];

  // 1. THE BASE MUST BE REAL: every key an input of the endpoint, every enumeration value allowed
  const inputs = new Map(endpoint.inputs.map((i) => [i.name, i] as const));
  for (const [k, v] of Object.entries(base)) {
    const i = inputs.get(k);
    if (!i) { refused.push({ field: k, reason: "unknown_field" }); continue; }
    if (Array.isArray(i.enum) && i.enum.length > 0 && !i.enum.map(String).includes(String(v))) refused.push({ field: k, reason: "not_in_enum" });
  }
  if (refused.length > 0) return { ok: false, params: { ...base }, gaps, refused, written };

  const queryField = profile.query?.field ?? null;
  let query = queryField && typeof base[queryField] === "string" ? String(base[queryField]) : null;
  const addOperator = (text: string, present: RegExp): void => { if (query !== null && !hasOperator(query, present)) query = `${stripQuery(query)} ${text}`; };

  // 2. THE PERIOD
  if (understood.period) {
    const p = understood.period;
    const d = profile.date;
    if (d && (d.from || d.to) && d.format !== "unknown") {
      // THE DAYS THE CUSTOMER GAVE ARE CAIRO DAYS (S1 live findings fix 5): converted to the moments they start and end, then written in the tool's own format (a source that takes only days gets the UTC days that COVER the range)
      const stamp = (ms: number): string => new Date(ms).toISOString().replace(".000Z", "Z");
      const startMs = p.from ? cairoDayStartMs(p.from) : null;
      const endMs = p.to ? cairoDayEndExclusiveMs(p.to) - 1000 : null;
      const fromDay = p.from ?? (p.days !== undefined ? isoDay(now - p.days * DAY) : null);
      const toDay = p.to ?? (p.days !== undefined && d.to ? isoDay(now) : null);
      const fmt = (day: string, end: boolean): string | number => {
        const ms = end ? endMs : startMs;
        if (ms !== null && Number.isFinite(ms) && (end ? p.to === day : p.from === day)) return d.format === "iso" ? stamp(ms) : d.format === "unix" ? Math.floor(ms / 1000) : utcDayOf(ms);
        return d.format === "iso" ? `${day}T${end ? "23:59:59" : "00:00:00"}Z` : d.format === "unix" ? Math.floor(Date.parse(`${day}T${end ? "23:59:59" : "00:00:00"}Z`) / 1000) : day;
      };
      if (d.from && fromDay) params[d.from] = fmt(fromDay, false);
      if (d.to && toDay) params[d.to] = fmt(toDay, true);
      written.push("date");
    } else if (d?.preset && d.preset.values.length > 0) {
      const need = daysOf(p, now);
      const options = d.preset.values.map((v) => ({ v, span: presetDays(v) })).filter((o): o is { v: string; span: number } => o.span !== null).sort((a, b) => a.span - b.span);
      const pick = need === null ? undefined : options.find((o) => o.span >= need);
      if (pick) { params[d.preset.field] = pick.v; written.push("date"); } else gaps.push({ cls: "date", reason: "unknown_format" });
    } else if (profile.queryOperators && query !== null) {
      // the range the customer gave is Cairo time (S1 live findings fix 5): `since:` is the moment the first day starts in Cairo, `until:` (exclusive) the moment the day after the last day starts, both written in UTC with the time of day
      const sinceStamp = p.from ? operatorStampUtc(cairoDayStartMs(p.from)) : p.days !== undefined ? isoDay(now - p.days * DAY) : null;
      if (sinceStamp) addOperator(`since:${sinceStamp}`, /\bsince:/i);
      const untilStamp = p.to ? operatorStampUtc(cairoDayEndExclusiveMs(p.to)) : null;
      if (untilStamp) addOperator(`until:${untilStamp}`, /\buntil:/i);
      written.push("date");
    } else gaps.push({ cls: "date", reason: "no_field" });
  }

  // 3. THE LANGUAGE
  if (understood.language) {
    const lang = understood.language.toLowerCase();
    if (profile.language) {
      const allowed = profile.language.values;
      const value = allowed ? allowed.find((a) => a.toLowerCase() === lang) : lang;
      if (value !== undefined) { params[profile.language.field] = value; written.push("language"); } else gaps.push({ cls: "language", reason: "not_in_enum" });
    } else if (profile.queryOperators && query !== null) { addOperator(`lang:${lang}`, /\blang:/i); written.push("language"); }
    else gaps.push({ cls: "language", reason: "no_field" });
  }

  // 4. THE COUNTRY (never written into a query)
  if (understood.country && understood.country.length > 0) {
    if (profile.country) {
      const allowed = profile.country.values;
      const code = understood.country[0];
      const value = allowed ? allowed.find((a) => a.toLowerCase() === code.toLowerCase()) : code;
      if (value !== undefined) { params[profile.country.field] = value; written.push("country"); }
      if (value === undefined) gaps.push({ cls: "country", reason: "not_in_enum" });
      else if (!profile.country.enforces) gaps.push({ cls: "country", reason: "not_enforced" });
    } else gaps.push({ cls: "country", reason: "no_field" });
  }

  // 5. THE ACCOUNT: an input the model already filled is kept
  if (understood.account && understood.account.length > 0) {
    const handle = understood.account[0];
    if (profile.account) { if (params[profile.account.field] === undefined) params[profile.account.field] = handle; written.push("account"); }
    else if (profile.queryOperators && query !== null) { addOperator(`from:${handle}`, /\bfrom:/i); written.push("account"); }
    else gaps.push({ cls: "account", reason: "no_field" });
  }

  // 6. THE REPLIES
  if (understood.replies) {
    if (profile.replies) {
      const f = profile.replies.field;
      params[f] = /^exclude/i.test(f) ? understood.replies === "exclude" : understood.replies === "include";
      written.push("replies");
    } else if (profile.queryOperators && query !== null) {
      if (understood.replies === "exclude") addOperator("-filter:replies", /-filter:replies/i);
      written.push("replies");
    } else gaps.push({ cls: "replies", reason: "no_field" });
  }

  // 7. THE SORT (only when the record asks for one)
  if (understood.sort && profile.sort) {
    const wantedWord = understood.sort === "latest" ? /^(latest|recent|newest|date-posted|time|date)$/i : /^(top|relevance|most-liked|popular|best)$/i;
    const value = profile.sort.values?.find((v) => wantedWord.test(v));
    if (value !== undefined) { params[profile.sort.field] = value; written.push("sort"); }
  }

  // 8. THE PAGE SIZE: the count, up to the endpoint's own maximum
  if (understood.count !== undefined && profile.count) {
    const max = profile.count.maximum;
    params[profile.count.field] = max !== undefined ? Math.min(understood.count, max) : understood.count;
    written.push("count");
  }

  if (queryField && query !== null) params[queryField] = query;
  return { ok: true, params, gaps, refused, written };
}

/**
 * THE UNDERSTOOD RECORD OF A STAGE, read from its typed filters (the plan's own, checked by code: the period, the language, the places, the named accounts, the replies) and its volume. Stage 1 has no separate understanding step (Stage 2 adds
 * it): the record is what the plan already declares. A disabled filter is not asked for. A CHILD stage (comments, replies) is delivered as the source gives it, so it asks for nothing: its inputs are the parent's identity.
 */
export function understoodOfStage(stage: { planned_rows: number; filters?: ReadonlyArray<StageFilter>; parent_key: string | null }, nowMs: number): Understood {
  const out: Understood = { nowMs };
  if (stage.parent_key !== null) return out;
  const filters = (stage.filters ?? []).filter(isEnabled);
  const period = filters.find((f) => f.kind === "period");
  if (period) out.period = period.days !== undefined ? { days: period.days } : { ...(period.from ? { from: period.from } : {}), ...(period.to ? { to: period.to } : {}) };
  const language = filters.find((f) => f.kind === "language");
  if (language?.lang) out.language = language.lang;
  const place = filters.find((f) => f.kind === "place");
  const countries = [...new Set((place?.places ?? []).map((k) => placeEntry(k)?.country).filter((c): c is string => Boolean(c)))];
  if (countries.length > 0) out.country = countries;
  const account = filters.find((f) => f.kind === "account");
  if (account && (account.values ?? []).length > 0) out.account = account.values!.map((v) => v.replace(/^@/, ""));
  if (filters.some((f) => f.kind === "exclude_replies")) out.replies = "exclude";
  if (Number.isFinite(stage.planned_rows) && stage.planned_rows > 0) out.count = Math.floor(stage.planned_rows);
  return out;
}
