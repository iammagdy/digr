import type { PricedPlan, PricedStage } from "../../src/lib/agentMission/plan";
import type { ItemSnapshot, StopReason } from "./items/itemStore";
import { cairoText, dateOnlyText, isDateValues, parseDateOnly, parseMoment } from "../../src/lib/agentMission/dateCells";
import { arabicDateLabel } from "../../src/lib/agentMission/fileNames";
import { countAr, itemNounOf, itemNounOfPlan, knownItemNoun } from "../../src/lib/agentMission/itemNoun";
import { filterLineAr, isEnabled, type StageFilter } from "../../src/lib/agentMission/filters";
import { APPROX_DATES_NOTE_AR, approxColumnsOf } from "../../src/lib/agentMission/relativeDates";
import { unresolvedSourcesLineAr } from "../../src/lib/agentMission/namedSources";
import { formatAr, toArabicDigits } from "../../src/lib/arabicDigits";
import { plainSearchAr } from "../../src/lib/agentMission/plainSearchAr";
import { reasonTextAr, shortfallClauseAr, stageTruthBodyAr } from "./finalize";
import { isPeopleStage } from "../../src/lib/agentMission/people";
import { decisionMakersLeftOutAr } from "../../src/lib/agentMission/roles";
import { perParentShortfallAr } from "./perParentLimits";

/**
 * THE «المنهجية» SECTION OF THE FIRST SHEET, built by CODE from what the mission RECORDED (the approved plan, the item store's counts, the request's own words, the delivered rows): the model never writes it, and a fact that was not
 * recorded says «غير مسجّل» (never a guess, never an estimate). It sits BELOW the existing summary in the first sheet, never in a sheet of its own: the settlement reads the delivered file back by sheet position (finalize.ts counts the
 * items of every sheet after the first), so a new sheet would be counted as delivered items.
 * Arabic only, Arabic-Indic digits; never a provider's name, an endpoint id, an internal id, a price or a model's vendor; never «صف» or «سجل».
 */
export const METHODOLOGY_TITLE_AR = "المنهجية";
export const NOT_RECORDED_AR = "غير مسجّل";

type Row = Record<string, unknown>;

/** What the item store recorded about one stage (a copy of its counts: read, duplicates, accepted by whom, left out per reason, how the stage stopped). */
export interface StageRecord {
  found: number;
  duplicates: number;
  accepted: number;
  excluded: number;
  pending: number;
  unchecked: number;
  acceptedByRule: number;
  acceptedByModel: number;
  excludedByReason: Record<string, number>;
  stop: StopReason | null;
}

/** The mission's recorded facts that the plan does not hold. Every field is optional: a missing one is written «غير مسجّل». */
export interface MissionFacts {
  /** The customer's request, in their own words. */
  requestText?: string | null;
  /** The moment the file is built (the delivery). */
  deliveredAt?: Date;
  stages?: Record<string, StageRecord>;
  /** How the automatic review ended (it ran out of its budget, or the source of the review failed). */
  reviewStop?: "budget" | "failed" | null;
}

export function missionFactsOf(input: { requestText: string | null | undefined; plan: PricedPlan; snap: ItemSnapshot; reviewStop: "budget" | "failed" | null; deliveredAt?: Date }): MissionFacts {
  const stages: Record<string, StageRecord> = {};
  for (const s of input.plan.stages) {
    const c = input.snap.counts(s.key);
    stages[s.key] = { found: c.found, duplicates: c.duplicates, accepted: c.accepted, excluded: c.excluded, pending: c.pending, unchecked: c.unchecked, acceptedByRule: c.acceptedByRule, acceptedByModel: c.acceptedByModel, excludedByReason: { ...c.excludedByReason } as Record<string, number>, stop: input.snap.stage(s.key).stop };
  }
  return { requestText: input.requestText ?? null, deliveredAt: input.deliveredAt ?? new Date(), stages, reviewStop: input.reviewStop };
}

/** The sheets of the file as the workbook lays them out (only what the dates need). */
export interface MethodologyLayout { stage: PricedStage; rows: Row[]; columns: Array<{ title: string; key?: string; kind?: "context" | "own"; get: (row: Row, parent: Row | null) => unknown }> }

export interface MethodologyModel {
  title: string;
  /** One line of the section: its label and what it says (several lines are written one under the other). */
  items: Array<{ label: string; values: string[] }>;
  /** The counts of every stage. */
  table: { head: string[]; rows: string[][] };
  /** Why items were left out, one line per stage that left some out (shown under the table). */
  reasons: string[];
  /** The label of the line after which the counts table is written. */
  tableAfterLabel: string;
}

const PLATFORM_WORDS: ReadonlyArray<[string, string]> = [["tiktok", "تيك توك"], ["instagram", "إنستغرام"], ["youtube", "يوتيوب"], ["facebook", "فيسبوك"], ["linkedin", "لينكد إن"], ["reddit", "ريديت"], ["twitter", "إكس"], ["x", "إكس"], ["maps", "خرائط جوجل"]];
/** The platform a stage reads, in Arabic, from the words of its source's name (the source's own name is never shown). Null when the name says no platform. */
export function platformOfEndpoint(endpointId: string | null | undefined): string | null {
  const tokens = String(endpointId ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const [word, ar] of PLATFORM_WORDS) if (tokens.includes(word)) return ar;
  return null;
}

/**
 * WHAT KIND OF SOURCE A STAGE READ, in customer-safe Arabic: the platform when the source's name says one («إكس», «يوتيوب»); otherwise the KIND of data the source gives (live: A1 and A2 said «غير مسجّل» in «المنصات والمصادر المستخدمة» because their
 * sources are company, people and e-mail databases whose names say no platform). Read from the words of the source's name only (never from a table of providers) and never the name itself: a customer sees what was read, not who sold it.
 */
export function sourceLabelAr(endpointId: string | null | undefined): string | null {
  if (!endpointId) return null;
  const platform = platformOfEndpoint(endpointId);
  if (platform) return platform;
  const tokens = String(endpointId).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(1);
  // a name that says nothing (no provider prefix, no capability) is not guessed at: the row says «غير مسجّل»
  if (tokens.length === 0) return null;
  const has = (...words: string[]): boolean => words.some((w) => tokens.includes(w));
  if (has("phone", "phones", "mobile", "tel", "telephone")) return "مصدر أرقام الهواتف";
  if (has("email", "emails", "mail")) return "مصدر عناوين البريد الإلكتروني للعمل";
  if (has("employees", "employee", "people", "person", "colleagues", "founders", "decision", "makers", "contacts", "profile", "profiles")) return "مصدر بيانات الموظفين والمسؤولين";
  if (has("companies", "company", "businesses", "business", "organizations", "organization", "accounts", "firms")) return "قاعدة بيانات الشركات";
  if (has("web", "search", "scrape", "crawl", "page", "pages", "site", "sites", "serp")) return "البحث في صفحات الويب";
  return "مصدر بيانات متخصص";
}

const reasonText = reasonTextAr;

const quoted = (names: ReadonlyArray<string>): string => names.map((n) => `«${n}»`).join("، ");
const fmt = (n: number): string => formatAr(Math.max(0, Math.floor(Number(n) || 0)));
const uniq = <T,>(xs: T[]): T[] => [...new Set(xs)];
const oneLine = (t: string): string => t.replace(/\s+/g, " ").trim();

/** «٣٠ أكتوبر ٢٠٢٦» of the moment, by the Cairo calendar. */
function cairoDateLabel(d: Date): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(cairoText(d));
  return m ? arabicDateLabel(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))) : NOT_RECORDED_AR;
}

const QUERY_KEY = /^(query|q|keyword|keywords|search|search_query|searchquery|text|topic|term|hashtag|phrase)$/i;
const ACCOUNT_KEY = /^(user|username|user_name|handle|channel|channel_name|page|page_name|account|profile|author)$/i;
const LINK_KEY = /^(url|link|post_url|profile_url|channel_url|page_url)$/i;

/** The keywords, queries, accounts and links the stage was recorded to read, in the customer's words as recorded. Empty when the plan holds none (a stage the model carried out has no recorded first-page inputs). */
function searchedOf(stage: PricedStage, planStages: ReadonlyArray<PricedStage>): string[] {
  const out: string[] = [];
  const params = stage.engine?.params ?? {};
  const texts: string[] = [];
  const accounts: string[] = [];
  const links: string[] = [];
  const take = (p: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(p)) {
      if (k.startsWith("_")) continue;
      const list = Array.isArray(v) ? v : [v];
      for (const item of list) {
        if (typeof item !== "string") continue;
        const t = oneLine(item);
        if (t.length < 2 || t.length > 200) continue;
        if (QUERY_KEY.test(k)) texts.push(t);
        else if (ACCOUNT_KEY.test(k) && !/^https?:\/\//i.test(t)) accounts.push(t);
        else if (LINK_KEY.test(k) || (/^https?:\/\//i.test(t) && !QUERY_KEY.test(k))) links.push(t);
      }
    }
  };
  take(params);
  for (const src of stage.engine?.sources ?? []) { take(src.params); accounts.push(...src.names.map(oneLine)); }
  for (const f of (stage.filters ?? []) as StageFilter[]) if (isEnabled(f) && f.kind === "account") accounts.push(...(f.values ?? []).map(oneLine));
  // the search string as the source reads it («"محمد صلاح" lang:ar since:…») is told in plain Arabic; an operator we do not know is left out
  const plain = uniq(texts.map(plainSearchAr).filter((p) => p.text !== ""));
  if (plain.length) out.push(`كلمات أو عبارات البحث: ${plain.map((p) => p.text).join(plain.some((p) => p.operators) ? "؛ " : "، ")}`);
  if (uniq(accounts).length) out.push(`حسابات أو قنوات أو صفحات: ${quoted(uniq(accounts).filter(Boolean))}`);
  if (uniq(links).length) out.push(`روابط: ${uniq(links).join("، ")}`);
  const parent = stage.parent_key !== null ? planStages.find((p) => p.key === stage.parent_key) : undefined;
  if (parent) out.push(`تُقرأ لكل عنصر من مرحلة «${parent.title_ar}»`);
  return out;
}

/** The earliest and the latest date of the delivered items of a stage, from its first date column. Null when the sheet has no date column. */
interface Covered { from: string; to: string; approx: boolean; fromMs: number; toMs: number; /** every date of the column is a day with no time (so the span is counted in whole days) */ dayOnly: boolean }
function coveredOf(layout: MethodologyLayout): Covered | null {
  for (const c of layout.columns) {
    if (c.kind === "context") continue;
    const values = layout.rows.map((r) => c.get(r, null));
    if (!isDateValues(c.title, c.key, values)) continue;
    const points: Array<{ t: number; text: string; day: boolean }> = [];
    for (const v of values) {
      const day = parseDateOnly(v);
      if (day) { points.push({ t: Date.UTC(day.y, day.mo - 1, day.da), text: dateOnlyText(day), day: true }); continue; }
      const moment = parseMoment(v);
      if (moment) points.push({ t: moment.getTime(), text: cairoText(moment), day: false });
    }
    if (points.length === 0) continue;
    points.sort((a, b) => a.t - b.t);
    const approx = c.key !== undefined && layout.rows.some((r) => approxColumnsOf(r).includes(c.key as string));
    return { from: toArabicDigits(points[0].text), to: toArabicDigits(points[points.length - 1].text), approx, fromMs: points[0].t, toMs: points[points.length - 1].t, dayOnly: points.some((p) => p.day) };
  }
  return null;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** A whole number of days / hours as the object of «غطّت»: «يومًا واحدًا», «يومين», «٥ أيام», «١٢ يومًا». */
const daysObjectAr = (n: number): string => (n === 1 ? "يومًا واحدًا" : n === 2 ? "يومين" : n <= 10 ? `${toArabicDigits(n)} أيام` : `${toArabicDigits(n)} يومًا`);
const hoursObjectAr = (n: number): string => (n === 1 ? "ساعة واحدة" : n === 2 ? "ساعتين" : n <= 10 ? `${toArabicDigits(n)} ساعات` : `${toArabicDigits(n)} ساعة`);

/** The length of the period the plan's enabled period filter asked for, in milliseconds, and how the customer worded it. Null when it has no length that can be told (a range with no start). */
function requestedSpanOf(f: StageFilter, deliveredAt: Date): { ms: number; wording: string } | null {
  const wording = filterLineAr(f).replace(/\.$/, "");
  if (f.days !== undefined) return f.days >= 1 ? { ms: f.days * DAY_MS, wording } : null;
  const day = (s: string | undefined): number | null => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s ?? "")); return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null; };
  const from = day(f.from);
  if (from === null) return null;
  const toDay = day(f.to);
  const end = toDay !== null ? toDay + DAY_MS : deliveredAt.getTime();
  return end > from ? { ms: end - from, wording: wording.startsWith("من") ? `الفترة ${wording}` : wording } : null;
}

/**
 * INFORMATION ONLY: when the dates of the delivered items cover less than HALF of the period the customer asked for, say so plainly and, when the stage's recorded stop is «target_reached», why
 * («طلبت آخر ٧ أيام، وغطّت النتائج نحو ١٦ ساعة فقط لأن العدد المطلوب اكتمل من أحدث النتائج.»). It never changes, blocks or refuses a delivery. Null when the coverage is not that short, when the dates are
 * only approximate (a relative time such as «قبل ٤ أيام» has no exact span), or when the period or the dates are not recorded.
 */
export function periodLimitLineAr(input: { filter: StageFilter | undefined; covered: Covered | null; deliveredAt: Date; targetReached: boolean }): string | null {
  const { filter, covered } = input;
  if (!filter || !isEnabled(filter) || filter.kind !== "period" || !covered || covered.approx) return null;
  const asked = requestedSpanOf(filter, input.deliveredAt);
  if (!asked) return null;
  const got = covered.dayOnly ? (covered.toMs - covered.fromMs) + DAY_MS : covered.toMs - covered.fromMs;
  if (!(got * 2 < asked.ms)) return null;
  let said: string;
  if (covered.dayOnly) said = daysObjectAr(Math.max(1, Math.round(got / DAY_MS)));
  else if (got < HOUR_MS) said = "أقل من ساعة";
  else if (got < 48 * HOUR_MS) said = `نحو ${hoursObjectAr(Math.round(got / HOUR_MS))}`;
  else said = `نحو ${daysObjectAr(Math.round(got / DAY_MS))}`;
  return `طلبت ${asked.wording}، وغطّت النتائج ${said} فقط${input.targetReached ? " لأن العدد المطلوب اكتمل من أحدث النتائج" : ""}.`;
}

const periodLineOf = (filters: ReadonlyArray<StageFilter> | undefined): string | null => {
  const f = (filters ?? []).find((x) => isEnabled(x) && x.kind === "period");
  return f ? filterLineAr(f).replace(/\.$/, "") : null;
};

export function buildMethodology(input: { plan: PricedPlan; layouts: ReadonlyArray<MethodologyLayout>; rowsByStage: Record<string, Row[]>; facts?: MissionFacts }): MethodologyModel {
  const { plan, layouts, rowsByStage } = input;
  const facts = input.facts ?? {};
  const stages = plan.stages;
  const many = stages.length > 1;
  /** One line per stage, each led by the stage's title when the mission has several. */
  const perStage = (each: (s: PricedStage) => string | null, only: (s: PricedStage) => boolean = () => true): string[] => {
    const out: string[] = [];
    for (const s of stages) { if (!only(s)) continue; const line = each(s); if (line) out.push(many ? `«${s.title_ar}»: ${line}` : line); }
    return out;
  };
  const orNotRecorded = (xs: string[]): string[] => (xs.length ? xs : [NOT_RECORDED_AR]);
  const delivering = stages.filter((s) => s.deliver);
  const noun = itemNounOfPlan(plan);
  /** The stage title's own noun when the table knows it (فيديو, تعليق, شركة), else undefined (the callers' defaults). */
  const knownNounOf = (title: string | undefined): string | undefined => { const n = itemNounOf(title); return knownItemNoun(n.singular) ? n.singular : undefined; };
  const items: MethodologyModel["items"] = [];

  // 1. the request, in the customer's own words
  const request = oneLine(String(facts.requestText ?? "")).slice(0, 1500);
  items.push({ label: "طلبك (بكلماتك)", values: [request || NOT_RECORDED_AR] });

  // 2. the platforms (or kinds of source) the stages read
  items.push({ label: "المنصات والمصادر المستخدمة", values: orNotRecorded(perStage((s) => sourceLabelAr(s.engine?.endpoint_id ?? s.endpoint_id))) });

  // 3. what was searched for
  const searched = perStage((s) => { const l = searchedOf(s, stages); return l.length ? l.join("؛ ") : null; });
  items.push({ label: "ما بُحث عنه", values: orNotRecorded(searched) });

  // 4. the period asked for, and the period the delivered items really cover
  const requestedPeriod = perStage((s) => { const p = periodLineOf(s.filters); return p; });
  items.push({ label: "الفترة المطلوبة", values: requestedPeriod.length ? requestedPeriod : ["لا فترة محددة في خطتك المعتمدة"] });
  const coveredLines: string[] = [];
  for (const lay of layouts) {
    const c = coveredOf(lay);
    if (!c) continue;
    const span = c.from === c.to ? `في ${c.from}` : `من ${c.from} إلى ${c.to}`;
    const text = `${span} (بتوقيت القاهرة)${c.approx ? ` — ${APPROX_DATES_NOTE_AR}` : ""}`;
    coveredLines.push(delivering.length > 1 ? `«${lay.stage.title_ar}»: ${text}` : text);
  }
  items.push({ label: "الفترة التي غطّتها النتائج", values: orNotRecorded(coveredLines) });

  // 5. the filters, as the plan stated them, and the removal of repeats
  const filterLines = perStage((s) => { const on = (s.filters ?? []).filter(isEnabled).map((f) => filterLineAr(f).replace(/\.$/, "")); return on.length ? on.join("؛ ") : null; });
  const dedupe = perStage((s) => { const r = facts.stages?.[s.key]; return r ? (r.duplicates > 0 ? `أُزيل ${fmt(r.duplicates)} من النتائج المكررة` : "لم يظهر تكرار") : null; });
  items.push({ label: "المرشّحات المطبّقة", values: filterLines.length ? filterLines : ["لا مرشّحات في خطتك المعتمدة"] });
  items.push({ label: "إزالة المكرر", values: orNotRecorded(dedupe) });

  // 6. how relevance was checked
  const relevance = perStage((s) => {
    const r = facts.stages?.[s.key];
    const counts = r ? ` قُبل ${fmt(r.acceptedByRule)} بقاعدة البرنامج و${fmt(r.acceptedByModel)} بالمراجعة الآلية.` : ` تفاصيل القبول: ${NOT_RECORDED_AR}.`;
    if (s.relevance) {
      const spec = s.relevance;
      const terms = (spec.terms ?? []).filter(Boolean);
      const about = spec.subject_ar ? ` (المقصود: ${oneLine(spec.subject_ar)})` : "";
      const review = spec.review === false ? " وما لم تحسمه القاعدة لم يُسلَّم." : " وما لم تحسمه القاعدة عُرض على مراجعة آلية، ولم يُسلَّم ما لم يُراجَع.";
      const base = spec.entity
        ? `فُحصت كل جهة مقروءة قبل تسليمها: تُقبل إذا دلّ نصها على القطاع المطلوب${about}.`
        : `فُحصت كل نتيجة مقروءة قبل تسليمها: تُقبل إذا ذكر نصها ${terms.length ? quoted(terms) : "الموضوع المطلوب"}${about}.`;
      return `${base}${review}${counts}`;
    }
    return s.parent_key !== null ? "عناصر تابعة تُسلَّم كما أعطاها المصدر، بعد المرشّحات إن وُجدت." : "لم يُطبَّق فحص صلة بالنص على هذه المرحلة؛ تُسلَّم النتائج كما أعطاها المصدر بعد المرشّحات إن وُجدت.";
  });
  const RELEVANCE_LABEL = "كيف فُحصت الصلة بطلبك";
  items.push({ label: RELEVANCE_LABEL, values: orNotRecorded(relevance) });

  // 7. the counts, per stage
  const table = { head: ["المرحلة", "قُرئ", "استُبعد", "سُلّم", "ملاحظة"], rows: [] as string[][] };
  const reasons: string[] = [];
  for (const s of stages) {
    const r = facts.stages?.[s.key];
    const delivered = s.deliver ? fmt((rowsByStage[s.key] ?? []).length) : "مرحلة وسيطة";
    const notes: string[] = [];
    if (r && r.duplicates > 0) notes.push(`أُزيل ${fmt(r.duplicates)} مكررًا`);
    // items nobody reviewed because the approved count was already reached are surplus, not a review that ran out
    if (r && r.pending + r.unchecked > 0) notes.push(r.accepted >= s.planned_rows ? `بقي ${fmt(r.pending + r.unchecked)} دون مراجعة لأن العدد المطلوب اكتمل` : `بقي ${fmt(r.pending + r.unchecked)} دون مراجعة فلم يُسلَّم`);
    table.rows.push([s.title_ar, r ? fmt(r.found) : NOT_RECORDED_AR, r ? fmt(r.excluded) : NOT_RECORDED_AR, delivered, notes.length ? notes.join("؛ ") : r ? "" : NOT_RECORDED_AR]);
    const why = r ? Object.entries(r.excludedByReason).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${fmt(n)} ${reasonText(k)}`) : [];
    if (why.length) reasons.push(`${many ? `«${s.title_ar}»: ` : ""}استُبعد ${why.join("؛ ")}`);
  }

  // 8. the limits of this delivery, in the card's own honest words
  const limits: string[] = [];
  const q = plan.quantity;
  if (q && q.requested > q.target) limits.push(`العدد المعتمد في الخطة أقل مما طلبت${q.reason_ar ? ` لأن ${q.reason_ar.replace(/[.،\s]+$/, "")}` : ""}.`);
  for (const u of plan.unserved_steps ?? []) limits.push(`لم يُنفَّذ: ${u.what_ar}؛ ${u.reason_ar}`);
  for (const s of stages) if ((s.unresolved_sources ?? []).length) limits.push(unresolvedSourcesLineAr(s.unresolved_sources!));
  for (const s of delivering) {
    const r = facts.stages?.[s.key];
    const got = (rowsByStage[s.key] ?? []).length;
    if (!r || got >= s.planned_rows) continue;
    // WHAT THE STAGE FOUND AND LEFT OUT, from the recorded counts, when our own row rules left out what the source gave (live A1, A2: 31 and 32 people found, none delivered, «the source gave no more»)
    const truth = stageTruthBodyAr({ found: r.found, duplicates: r.duplicates, delivered: got, excludedByReason: r.excludedByReason, pending: r.pending, reviewStop: facts.reviewStop ?? null, stop: r.stop, people: isPeopleStage(s) });
    if (truth) { limits.push(`${many ? `«${s.title_ar}»: ` : ""}سُلّم ${fmt(got)} من ${fmt(s.planned_rows)}: ${truth}.`); continue; }
    // THE COUNTS PER PARENT (companies with no people, with fewer than asked, people beyond the approved number): the shortfall of a child stage is said from them when they explain it (never «the source gave no more» when the other companies had surplus)
    const perParent = s.parent_key !== null && r.pending === 0 && !s.parent_key.startsWith("__") ? perParentShortfallAr({ parentIds: (rowsByStage[s.parent_key] ?? []).map((x) => String(x.id)), childParentIds: (rowsByStage[s.key] ?? []).map((x) => String(x.parent_id ?? "")), perParent: s.per_parent_rows, surplus: r.excludedByReason.target_reached ?? 0, parentNoun: knownNounOf(stages.find((x) => x.key === s.parent_key)?.title_ar), childNoun: isPeopleStage(s) ? "شخص" : knownNounOf(s.title_ar) ?? "عنصر" }) : null;
    if (perParent) { limits.push(`${many ? `«${s.title_ar}»: ` : ""}سُلّم ${fmt(got)} من ${fmt(s.planned_rows)}: ${perParent}.`); continue; }
    const clause = shortfallClauseAr(r.stop, { pending: r.pending, stop: facts.reviewStop ?? null, languageLeftOut: r.excludedByReason.filter_language ?? 0 });
    limits.push(`${many ? `«${s.title_ar}»: ` : ""}سُلّم ${fmt(got)} من ${fmt(s.planned_rows)} ${clause}.`);
  }
  // DECISION MAKERS: a people stage that prefers the decision makers says when people who are not fill the count (the titles of the delivered rows; a title the source did not give is not judged)
  for (const s of delivering) {
    const role = (s as { role_preference?: { role?: string } }).role_preference?.role;
    if (role !== "manager" || !isPeopleStage(s)) continue;
    const line = decisionMakersLeftOutAr(rowsByStage[s.key] ?? [], "manager");
    if (line) limits.push(`${many ? `«${s.title_ar}»: ` : ""}${line}.`);
  }
  // the period the results really cover is much shorter than the one asked for (information only; the delivery is never changed by it)
  const deliveredAt = facts.deliveredAt ?? new Date();
  for (const s of delivering) {
    const lay = layouts.find((l) => l.stage.key === s.key);
    const line = periodLimitLineAr({ filter: (s.filters ?? []).find((f) => isEnabled(f) && f.kind === "period"), covered: lay ? coveredOf(lay) : null, deliveredAt, targetReached: facts.stages?.[s.key]?.stop === "target_reached" });
    if (line) limits.push(many ? `«${s.title_ar}»: ${line}` : line);
  }
  items.push({ label: "حدود هذا التسليم", values: limits.length ? limits : ["لا قيود سُجّلت على هذا التسليم"] });

  // 9. one sentence the researcher can paste, with the delivery date
  const total = delivering.reduce((n, s) => n + (rowsByStage[s.key] ?? []).length, 0);
  const subject = delivering.map((s) => s.relevance?.subject_ar).find((x): x is string => typeof x === "string" && x.trim() !== "");
  const platforms = uniq(delivering.map((s) => sourceLabelAr(s.engine?.endpoint_id ?? s.endpoint_id)).filter((x): x is string => x !== null));
  const spans = layouts.map(coveredOf).filter((x): x is NonNullable<ReturnType<typeof coveredOf>> => x !== null);
  const from = spans.map((x) => x.from).sort()[0];
  const to = spans.map((x) => x.to).sort().slice(-1)[0];
  const when = cairoDateLabel(facts.deliveredAt ?? new Date());
  const what = subject ? `«${oneLine(subject)}»` : delivering.length ? quoted(delivering.map((s) => s.title_ar)) : NOT_RECORDED_AR;
  const citation = `ديجر. ${what}: ${countAr(total, noun)}، جُمعت من ${platforms.length ? platforms.join(" و") : NOT_RECORDED_AR}${from && to ? (from.slice(0, 10) === to.slice(0, 10) ? `، بتاريخ ${from.slice(0, 10)}` : `، في الفترة من ${from.slice(0, 10)} إلى ${to.slice(0, 10)}`) : ""}. تاريخ التسليم: ${when}.`;
  items.push({ label: "صيغة الاستشهاد المقترحة", values: [citation] });

  return { title: METHODOLOGY_TITLE_AR, items, table, reasons, tableAfterLabel: RELEVANCE_LABEL };
}
