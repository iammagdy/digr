import { linkOf, stagesOfNeed, type ResearchNeed, type StageNeed } from "./need";
import type { Capability, CapabilityProvider, CapabilityRegistry, InputClass, Operation, OutputClass } from "./registry";

/**
 * CAPABILITY DISCOVERY (docs/UNIFIED-CAPABILITY-DISCOVERY.md): for each stage the request needs, which registry capabilities CAN do it, ranked by code:
 *
 *   1. hard eligibility: public data only; available to this account now (sellable, permitted, the provider's key and a daily cap above 0); the right platform; an input the stage can be fed with (the customer's topic for the
 *      first stage, a field of the parent's rows for a child stage); and, when the provider documents its output fields, every field the stage requires (a capability without them is NEVER treated as able to give them);
 *   2. then the ability to meet the request: documented outputs before unknown ones (unknown outputs must be proven on a sampled page), a parent that can feed the next stage, the requested volume (paging), the conditions it
 *      can enforce itself (period, country, language), the useful optional fields;
 *   3. then price per row, then the id (a stable order).
 * A cheap capability that cannot satisfy the request never outranks a capable one because it is cheaper.
 *
 * A stage with no eligible capability makes the request UNSUPPORTED (first stage) or PARTIAL (a later stage): the result says what is unavailable, in Arabic, and the feasible reduced scope, so the customer can be asked before any plan.
 * A condition no eligible capability can enforce is a LIMITATION said before approval, never claimed as applied. Pure; never throws; no network; no paid call.
 */
export const DISCOVERY_VERSION = 1 as const;

export type RejectReason = "private_data" | "provider_key_missing" | "provider_daily_cap_zero" | "not_sellable" | "not_permitted" | "platform_mismatch" | "no_usable_input" | "missing_outputs" | "cannot_take_parent_output";

export interface RankedCandidate {
  id: string;
  provider: CapabilityProvider;
  rank: number;
  outputsVerified: boolean;
  feedsChild: boolean;
  reachesVolume: boolean;
  filtersCovered: Array<"period" | "country" | "language">;
  preferredOutputs: number;
  usdPerRow: number | null;
  pagination: boolean;
  maxRowsPerCall: number;
  outputs: OutputClass[];
  takes: InputClass[];
  summary: string;
  limits: string | null;
}

export interface Limitation {
  code: "filter_not_enforceable" | "volume_not_reachable" | "outputs_unproven";
  stageKey: string;
  filter?: "period" | "country" | "language";
  /** The sentence the customer reads before approval (null for an internal limitation). */
  textAr: string | null;
}

export interface StageDiscovery {
  stage: StageNeed;
  eligible: RankedCandidate[];
  rejected: Array<{ id: string; reason: RejectReason }>;
  /** The best eligible capability (code's choice; a model may choose another one of `eligible` only). */
  selected: string | null;
  /** How the selected capability is fed from the parent's selected capability. */
  link: { from: OutputClass; to: InputClass } | null;
}

export type UnsupportedReason = "no_capability" | "provider_unavailable" | "not_permitted" | "unsupported_platform";

export interface CapabilityDiscovery {
  v: typeof DISCOVERY_VERSION;
  status: "supported" | "partial" | "unsupported" | "blocked" | "needs_clarification";
  need: ResearchNeed;
  stages: StageDiscovery[];
  unsupported: Array<{ stageKey: string; operation: Operation; reason: UnsupportedReason }>;
  limitations: Limitation[];
  /** What is unavailable, for the customer (null when everything is supported). */
  messageAr: string | null;
  /** The feasible reduced scope, offered as a question (null when there is none or nothing is missing). */
  alternativeAr: string | null;
}

export const PLATFORM_AR: Record<string, string> = { tiktok: "تيك توك", x: "إكس", instagram: "إنستجرام", facebook: "فيسبوك", youtube: "يوتيوب" };
export function operationLabelAr(operation: Operation, platform: string | null): string {
  const p = platform ? PLATFORM_AR[platform] ?? null : null;
  switch (operation) {
    case "social.parents": return p ? `منشورات وفيديوهات ${p}` : "المنشورات والفيديوهات";
    case "social.comments": return p ? `تعليقات ${p}` : "التعليقات";
    case "social.replies": return p ? `الردود على تعليقات ${p}` : "الردود على التعليقات";
    case "companies.discover": return "الشركات ومواقعها من مصادر الشركات العامة";
    case "company.contacts": return "إيميلات وأرقام العمل الرسمية المنشورة على صفحات الشركات العامة";
    case "places.discover": return "الأماكن من الخرائط";
    case "places.reviews": return "تقييمات الأماكن ونصوصها";
    case "web.search": return "صفحات الويب العامة";
    case "web.read": return "نصوص صفحات الويب العامة";
    case "people.discover": return "المهنيين وأدوارهم من الملفات المهنية العامة";
  }
}
const FILTER_AR = { period: "الفترة", country: "الدولة", language: "اللغة" } as const;
const UNSUPPORTED_PLATFORM_AR: Record<string, string> = { snapchat: "سناب شات", clubhouse: "كلوب هاوس", discord: "ديسكورد" };

function hardReject(c: Capability, stage: StageNeed): RejectReason | null {
  if (c.privacy !== "public") return "private_data";
  if (c.unavailable) return c.unavailable === "blocked" ? "not_permitted" : c.unavailable;
  if (stage.platform && c.platform !== stage.platform) return "platform_mismatch";
  const accepts = stage.parentKey === null ? (["query"] as InputClass[]) : stage.accepts;
  if (!c.takes.some((t) => accepts.includes(t))) return "no_usable_input";
  if (c.outputsKnown && !stage.requires.every((r) => c.outputs.includes(r))) return "missing_outputs";
  return null;
}

function wantedFilters(need: ResearchNeed, stage: StageNeed): Array<"period" | "country" | "language"> {
  // the conditions bind the stage that FINDS the items (the first one); a language also binds the comments
  const out: Array<"period" | "country" | "language"> = [];
  if (stage.parentKey === null) {
    if (need.conditions.period) out.push("period");
    if (need.conditions.country) out.push("country");
    if (need.conditions.language) out.push("language");
  } else if (stage.operation === "social.comments" && need.conditions.language) out.push("language");
  return out;
}

const covers = (c: Capability, f: "period" | "country" | "language"): boolean => (f === "period" ? c.filters.date : f === "country" ? c.filters.country : c.filters.language);

function compare(a: RankedCandidate, b: RankedCandidate): number {
  const order: Array<[number, number]> = [
    [Number(b.outputsVerified), Number(a.outputsVerified)],
    [Number(b.feedsChild), Number(a.feedsChild)],
    [Number(b.reachesVolume), Number(a.reachesVolume)],
    [b.filtersCovered.length, a.filtersCovered.length],
    [b.preferredOutputs, a.preferredOutputs],
  ];
  for (const [x, y] of order) if (x !== y) return x - y;
  const pa = a.usdPerRow ?? Number.POSITIVE_INFINITY;
  const pb = b.usdPerRow ?? Number.POSITIVE_INFINITY;
  if (pa !== pb) return pa - pb;
  return a.id.localeCompare(b.id);
}

function candidateOf(c: Capability, stage: StageNeed, need: ResearchNeed, children: StageNeed[], registry: CapabilityRegistry): RankedCandidate {
  const filters = wantedFilters(need, stage).filter((f) => covers(c, f));
  // a parent feeds its child when some capability of the child's operation can take a field this one gives (unknown outputs: unproven, not counted)
  const feedsChild = children.length === 0 || (c.outputsKnown && children.every((ch) => registry.all.some((x) => x.operation === ch.operation && (!ch.platform || x.platform === ch.platform) && hardReject(x, ch) === null && linkOf(c.outputs, x.takes.filter((t) => ch.accepts.includes(t))) !== null)));
  return {
    id: c.id, provider: c.provider, rank: 0,
    outputsVerified: c.outputsKnown && stage.requires.every((r) => c.outputs.includes(r)),
    feedsChild,
    reachesVolume: stage.volume === null || c.pagination || c.maxRowsPerCall >= stage.volume,
    filtersCovered: filters,
    preferredOutputs: stage.prefers.filter((p) => c.outputs.includes(p)).length,
    usdPerRow: c.usdPerRow, pagination: c.pagination, maxRowsPerCall: c.maxRowsPerCall, outputs: c.outputs, takes: c.takes, summary: c.summary, limits: c.limits,
  };
}

/** Every eligible capability of a stage is kept (the validated set a plan may use); the planner is shown the first ones in rank order (prompt.ts). */
export function discoverCapabilities(need: ResearchNeed, registry: CapabilityRegistry): CapabilityDiscovery {
  const base = { v: DISCOVERY_VERSION, need, stages: [] as StageDiscovery[], unsupported: [] as CapabilityDiscovery["unsupported"], limitations: [] as Limitation[], messageAr: null as string | null, alternativeAr: null as string | null };
  if (need.privacy === "blocked") return { ...base, status: "blocked", messageAr: "هذا الطلب يتضمن بيانات خاصة لأفراد، ولا نجمعها بأي مصدر." };
  if (need.unsupportedPlatform && need.platforms.length === 0) {
    const name = UNSUPPORTED_PLATFORM_AR[need.unsupportedPlatform] ?? need.unsupportedPlatform;
    return {
      ...base, status: "unsupported", unsupported: [{ stageKey: "source", operation: "social.parents", reason: "unsupported_platform" }],
      messageAr: `منصة ${name} ليست من المصادر التي نجمع منها حاليًا.`,
      alternativeAr: "نقدر نجمع نفس النوع من البيانات العامة من تيك توك أو إكس أو إنستجرام أو فيسبوك أو يوتيوب، أو من صفحات الويب العامة. أي مصدر منها يناسبك؟",
    };
  }
  const stages = stagesOfNeed(need);
  const unresolved = need.unresolved ?? [];
  // the model understood a goal that no operation serves (or nothing executable at all): the customer is ASKED, with what can be collected now; never «unsupported» because a word was not recognised
  if (stages.length === 0) return unresolved.length > 0 ? { ...base, status: "needs_clarification", messageAr: UNRESOLVED_AR, alternativeAr: availableAlternativeAr(registry) } : { ...base, status: "needs_clarification" };

  const out: StageDiscovery[] = [];
  const unsupported: CapabilityDiscovery["unsupported"] = [];
  const limitations: Limitation[] = [];
  const failedKeys = new Set<string>();
  for (const stage of stages) {
    const parent = stage.parentKey ? out.find((s) => s.stage.key === stage.parentKey) ?? null : null;
    if (stage.parentKey && (failedKeys.has(stage.parentKey) || !parent?.selected)) {
      failedKeys.add(stage.key);
      unsupported.push({ stageKey: stage.key, operation: stage.operation, reason: "no_capability" });
      out.push({ stage, eligible: [], rejected: [], selected: null, link: null });
      continue;
    }
    const parentCandidate = parent?.eligible.find((e) => e.id === parent.selected) ?? null;
    const children = stages.filter((s) => s.parentKey === stage.key);
    const pool = registry.all.filter((c) => c.operation === stage.operation);
    const rejected: StageDiscovery["rejected"] = [];
    const eligible: RankedCandidate[] = [];
    for (const c of pool) {
      let reason = hardReject(c, stage);
      // a child must be fed by its parent's rows: a field the parent's chosen capability documents (unknown parent outputs: proven on the sample, so any accepted input is kept)
      if (!reason && parentCandidate && parentCandidate.outputs.length > 0 && parentCandidate.outputsVerified && linkOf(parentCandidate.outputs, c.takes.filter((t) => stage.accepts.includes(t))) === null) reason = "cannot_take_parent_output";
      if (reason) { rejected.push({ id: c.id, reason }); continue; }
      if (!eligible.some((e) => e.id === c.id)) eligible.push(candidateOf(c, stage, need, children, registry));
    }
    eligible.sort(compare);
    eligible.forEach((e, i) => { e.rank = i + 1; });
    const selected = eligible[0] ?? null;
    if (!selected) {
      failedKeys.add(stage.key);
      const reasons = new Set(rejected.filter((r) => r.reason !== "platform_mismatch").map((r) => r.reason));
      const reason: UnsupportedReason = reasons.size === 0 ? "no_capability" : [...reasons].every((r) => r === "provider_key_missing" || r === "provider_daily_cap_zero") ? "provider_unavailable" : [...reasons].every((r) => r === "not_permitted" || r === "not_sellable" || r === "provider_key_missing" || r === "provider_daily_cap_zero") ? "not_permitted" : "no_capability";
      unsupported.push({ stageKey: stage.key, operation: stage.operation, reason });
      out.push({ stage, eligible: [], rejected, selected: null, link: null });
      continue;
    }
    const link = parentCandidate ? linkOf(parentCandidate.outputs.length > 0 ? parentCandidate.outputs : (["id", "url", "website", "place_ref"] as OutputClass[]), selected.takes.filter((t) => stage.accepts.includes(t))) : null;
    out.push({ stage, eligible, rejected, selected: selected.id, link });
    const label = operationLabelAr(stage.operation, stage.platform);
    for (const f of wantedFilters(need, stage)) {
      // honest: a condition the CHOSEN capability cannot enforce is said before approval (never claimed as applied)
      if (!selected.filtersCovered.includes(f)) limitations.push({ code: "filter_not_enforceable", stageKey: stage.key, filter: f, textAr: `لا يستطيع مصدر ${label} تطبيق شرط ${FILTER_AR[f]} بنفسه؛ لن نَعِد بأن كل النتائج تطابقه، وسنذكره في كل صف حين يتوفر في المصدر.` });
    }
    if (!selected.reachesVolume) limitations.push({ code: "volume_not_reachable", stageKey: stage.key, textAr: `مصدر ${label} لا يعطي إلا دفعة واحدة محدودة، فقد يكون المسلَّم أقل من العدد المطلوب، ولا تدفع إلا عن المسلَّم فعلًا.` });
    if (!selected.outputsVerified) limitations.push({ code: "outputs_unproven", stageKey: stage.key, textAr: null });
  }

  const missing = unsupported.filter((u) => u.reason !== "unsupported_platform");
  const rootsFailed = stages.filter((s) => s.parentKey === null).every((s) => failedKeys.has(s.key));
  const status: CapabilityDiscovery["status"] = missing.length === 0 ? (unresolved.length > 0 ? "partial" : "supported") : rootsFailed ? "unsupported" : "partial";
  if (status === "supported") return { ...base, status, stages: out, limitations };
  if (missing.length === 0) {
    // every executable objective is served, but the model also understood a part nothing serves: that part is asked about with the feasible scope, never dropped silently
    const kept = [...new Set(out.map((s) => operationLabelAr(s.stage.operation, s.stage.platform)))];
    const platforms = [...new Set(unresolved.map((u) => u.platform).filter((p): p is string => p !== null && !(p in PLATFORM_AR)))];
    const messageAr = platforms.length > 0 ? `${platforms.map((p) => `منصة ${UNSUPPORTED_PLATFORM_AR[p] ?? p}`).join(" و")} ليست من المصادر التي نجمع منها حاليًا، وجزء من طلبك يعتمد عليها.` : UNRESOLVED_AR;
    return { ...base, status, stages: out, unsupported, limitations, messageAr, alternativeAr: `نقدر نجمع لك ${kept.join(" و")} بدون هذا الجزء. هل يناسبك هذا النطاق، أم تحب توضّح الجزء الآخر بطريقة تانية؟` };
  }
  const missingLabels = [...new Set(missing.map((u) => operationLabelAr(u.operation, stages.find((s) => s.key === u.stageKey)?.platform ?? null)))];
  const why = missing.every((u) => u.reason === "provider_unavailable") ? "المصدر الذي يقدّمها غير متاح الآن" : missing.every((u) => u.reason === "not_permitted") ? "المصادر التي تقدّمها غير مسموح بها لحسابك" : "لا يوجد مصدر متاح يقدّمها بالبيانات المطلوبة";
  const messageAr = `لا نقدر حاليًا على جمع: ${missingLabels.join("، ")}، لأن ${why}.`;
  const kept = out.filter((s) => s.selected).map((s) => operationLabelAr(s.stage.operation, s.stage.platform));
  const alternativeAr = status === "partial" && kept.length > 0 ? `نقدر نجمع لك ${[...new Set(kept)].join(" و")} بدون الجزء غير المتاح. هل يناسبك هذا النطاق؟` : need.kind === "social" ? "نقدر نجمع بيانات عامة مشابهة من صفحات الويب العامة أو من منصة أخرى من المنصات المتاحة. أي بديل يناسبك؟" : "نقدر نبحث في صفحات الويب العامة عن نفس الموضوع. هل يناسبك ذلك؟";
  return { ...base, status, stages: out, unsupported, limitations, messageAr, alternativeAr };
}

/** Said when the model understood a goal no data operation serves: honest, and followed by what can be collected now. */
export const UNRESOLVED_AR = "فهمت هدفك، لكن جزءًا منه لا يطابق أي نوع من البيانات العامة التي نقدر نجمعها حاليًا، ولن نستبدله بشيء آخر من غير ما نسألك.";

/** The kinds of public data some available capability serves now (one Arabic phrase per operation), offered when the customer's goal must be re-stated. */
export function availableAlternativeAr(registry: CapabilityRegistry): string {
  const usable = registry.all.filter((c) => c.privacy === "public" && c.unavailable === null);
  const ops = ["social.comments", "companies.discover", "company.contacts", "people.discover", "places.reviews", "web.search"] as const;
  const labels = ops.filter((op) => usable.some((c) => c.operation === op)).map((op) => operationLabelAr(op, null));
  return labels.length > 0 ? `المتاح الآن مثلًا: ${labels.join("، ")}. أي نوع منها يخدم هدفك؟ أو احكيلي هدفك بطريقة تانية.` : "احكيلي هدفك بطريقة تانية.";
}

/** Whether the request's objectives join social data with another kind of data (the chat asks which part first; the worker asks before the social compiler plans its part). */
export function mixesSocialAndOther(d: CapabilityDiscovery): boolean {
  const roots = (d.need.objectives ?? []).filter((o) => o.parent === null);
  return d.need.kind === "mixed" && roots.some((o) => o.operation.startsWith("social.")) && roots.some((o) => !o.operation.startsWith("social."));
}

/** The parts of a mixed request, said back to the customer with the choice (code's words; the labels are the operations', never a provider). */
export function mixedPartsAr(d: CapabilityDiscovery): string {
  const roots = d.stages.filter((s) => s.stage.parentKey === null);
  const chainLabel = (rootKey: string): string => {
    const chain = [rootKey];
    for (let i = 0; i < chain.length; i += 1) for (const s of d.stages) if (s.stage.parentKey === chain[i]) chain.push(s.stage.key);
    const deepest = d.stages.filter((s) => chain.includes(s.stage.key)).pop()!;
    return operationLabelAr(deepest.stage.operation, deepest.stage.platform);
  };
  const parts = [...new Set(roots.map((r) => chainLabel(r.stage.key)))];
  return `طلبك فيه أكتر من جزء: ${parts.join("، ")}. بيانات وسائل التواصل بتتجهز في خطة لوحدها، وكل جزء تاني في خطة لوحده بسعره، ومفيش حاجة هتتشال من طلبك من غير ما تقرر. نبدأ بأنهي جزء؟`;
}

/** The customer-facing limitation sentences of a discovery (deduplicated, in stage order). */
export function limitationLinesAr(d: CapabilityDiscovery): string[] {
  return [...new Set(d.limitations.map((l) => l.textAr).filter((t): t is string => typeof t === "string" && t !== ""))];
}

/** The validated candidate ids of a discovery, per stage (what a model may choose from). */
export function eligibleIdsOf(d: CapabilityDiscovery): Map<string, string[]> {
  return new Map(d.stages.map((s) => [s.stage.key, s.eligible.map((e) => e.id)]));
}
