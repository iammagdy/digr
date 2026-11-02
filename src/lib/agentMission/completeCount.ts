import { toArabicDigits } from "../arabicDigits";
import { AGENT_REPLIES_PER_COMMENT_DEFAULT, AGENT_REPLIES_PER_COMMENT_MAX, AGENT_REPLIES_UNKNOWN_SHARE } from "./constants";
import { wantsAllChildren } from "./allChildren";
import { isPeopleStage } from "./people";
import { textColumnKeyOf } from "./languageLabel";
import { topicDiscussionClass, type TopicMeaning } from "./topicMeaning";
import { priceMissionByCode } from "./price";
import { repliesEstimateFor } from "./replies";
import { stagePriceInputs, type PricedPlan, type PricedStage } from "./plan";

/**
 * THE COMPLETE COUNT (S1 live findings, the owner's top rule; docs/S1-LIVE-FINDINGS.md sections 3 and 4): the count on the approved plan is the count delivered. Redesigned mode only ([PRICE-INPUT]: the estimate that prices the plan is computed here
 * through the one pricing function; the charge formula in price.ts is not touched, and what is charged is still what is delivered).
 *
 *  1. The promised number of children (comments) is computed by CODE from the REAL counters of the parents (posts, videos) that will be read, sampled before the plan is shown: never the model's guess.
 *  2. When the parents first chosen cannot supply the number the customer asked for, other candidates of the same listing (they all match the customer's conditions: the same account or the same search) take their place, the ones with the larger
 *     counters first. Nothing is chosen by engagement otherwise: with no shortfall the parents stay in the source's order.
 *  3. When the best parents still cannot supply it, the plan says so BEFORE approval with the real number.
 *  4. The chosen parents are PINNED on the stage (`parent_pins`): the engine reads exactly these parents, so a post published between planning and execution cannot change the promise.
 *  5. A source with no next page gives at most what one call gives (`pageCap`): the promise never counts rows the source cannot return, and the card says so.
 *
 * Pure apart from what the caller reads (the candidates).
 */
export interface Candidate { id: string; counter: number | null; /** The listing's own mapped row of this candidate (S2 item 6): stored on the parent stage when the candidate is pinned. */ row?: Record<string, unknown> }

export interface CompleteCountDeps {
  request: string;
  /** The parent stage's own listing: every row of its measured page, in the source's order, with its id and its comment counter (null: the row has none). */
  candidatesOf: (parent: PricedStage) => Promise<Candidate[] | null>;
  /** The most rows ONE call of the child source can give for a parent (a source with no next page); null when the source pages. */
  pageCapOf?: (child: PricedStage) => Promise<number | null>;
  /**
   * WHAT THE PARENT'S COUNTER COUNTS (S1 complete count, item 2): on TikTok, Instagram, Facebook and YouTube a video's counter is its comments AND its replies. `share` is the part of the counter that is top-level comments, measured on the child source's own sampled
   * page (comments / (comments + their replies counters)) when that page shows the counter includes replies; null when there is no such evidence (the counter is then used as it is).
   */
  basisOf?: (child: PricedStage) => Promise<{ share: number | null } | null>;
  /** The size input of the child source and the most one call gives, from the source's own catalog schema (pageLimit.ts); null when the source states no maximum. A source with no next page is asked for what the promise needs, up to this maximum (S2 item 3). */
  /** The stage's next tool that pages, from the catalog (pageableComments.ts), when the stage's recipe has no next page and the planner sampled no pageable one; null when the catalog has none the stage can feed (S2 item 4). */
  pageableAlternativeOf?: (child: PricedStage) => Promise<NonNullable<NonNullable<PricedStage["engine"]>["alternatives"]>[number] | null>;
  /** S5 (owner decision): the parents are chosen by their counters, the highest first (an order, never a filter); false: the source's own order stands (the customer asked for the newest or gave a date). */
  mostEngaged?: boolean;
  /** S8: what the request means by its topic (about / made with / ambiguous / none): among the results the videos whose own text discusses the topic come before those where it is only a made-with hashtag (an order, never a filter). */
  topicOf?: () => TopicMeaning | null;
  /** S7: whether a row of the parent's listing matches the customer's country and language (null: the customer asked for neither). The most engaged are chosen among the matching results; the matching come first, then the others (an order, never a filter). */
  matchesOf?: (parent: PricedStage) => Promise<((row: Record<string, unknown>) => boolean) | null>;
  pageSizeOf?: (child: PricedStage) => Promise<{ param: string; max: number } | null>;
}

export interface CompleteCountEstimate {
  /** The parents to read, in order, pinned. */
  chosen: Candidate[];
  /** The rows the chosen parents can really supply, each capped by the request per parent and by what one call gives. */
  total: number;
  /** What the customer asked for (numbered request), or null for «all». */
  requested: number | null;
  /** The largest supply of one parent. */
  perParent: number;
  /** Chosen parents whose counter is 0: never read. */
  skipped: number;
  /** The platform's own counters of the chosen parents exceed what a call gives (`pageCap`). */
  capped: boolean;
  /** Parents of the listing that took the place of a first-chosen parent that could not supply the request. */
  replaced: number;
}

/** What one parent can supply: its counter (a parent with no counter is estimated at `fallback`), the request per parent, and what one call gives. */
export const supplyOf = (counter: number | null, perParent: number, pageCap: number | null, fallback: number): number => {
  const own = counter === null ? fallback : Math.max(0, Math.floor(counter));
  return Math.max(0, Math.min(own, perParent, pageCap ?? Number.POSITIVE_INFINITY));
};

/**
 * The parents and the promised count. `parents` is how many parents the customer asked for, `perParent` the number asked for each (Infinity for «all»), `requested` the total asked for (null for «all»). The first `parents` candidates that can supply anything
 * are chosen in the source's order; only when their total is short of `requested` is a chosen parent replaced by an unchosen candidate that supplies more.
 */
export function completeCountEstimate(candidates: ReadonlyArray<Candidate>, input: { parents: number; perParent: number; requested: number | null; pageCap: number | null; fallback: number }): CompleteCountEstimate {
  const supply = (c: Candidate): number => supplyOf(c.counter, input.perParent, input.pageCap, input.fallback);
  const K = Math.max(1, input.parents);
  // the first K that can give anything, in the source's order; zero-supply parents only fill up when too few can give
  const giving = candidates.filter((c) => supply(c) > 0);
  const empty = candidates.filter((c) => supply(c) === 0);
  let chosen = [...giving.slice(0, K)];
  if (chosen.length < K) chosen = [...chosen, ...empty.slice(0, K - chosen.length)];
  let replaced = 0;
  if (input.requested !== null) {
    const total = (xs: ReadonlyArray<Candidate>): number => xs.reduce((n, c) => n + supply(c), 0);
    const rest = giving.slice(K).sort((a, b) => supply(b) - supply(a));
    // replace the smallest chosen parent by the largest unchosen one while that brings the total closer to the request
    while (total(chosen) < input.requested && rest.length > 0) {
      const smallest = chosen.reduce((s, c, i) => (supply(c) < supply(chosen[s]) ? i : s), 0);
      if (supply(rest[0]) <= supply(chosen[smallest])) break;
      const [taken] = rest.splice(0, 1);
      chosen = chosen.map((c, i) => (i === smallest ? taken : c));
      replaced += 1;
    }
  }
  const supplies = chosen.map(supply);
  const sum = supplies.reduce((n, v) => n + v, 0);
  const total = input.requested === null ? sum : Math.min(sum, input.requested);
  const capped = input.pageCap !== null && chosen.some((c) => c.counter !== null && c.counter > input.pageCap!);
  return { chosen, total, requested: input.requested, perParent: Math.max(0, ...supplies), skipped: chosen.filter((c) => supply(c) === 0).length, capped, replaced };
}

const n = (v: number): string => toArabicDigits(v);

/** The split of a total promised for comments AND replies (a video's counter counts both): the replies are the sample's measured share of it (a silent sample: a stated quarter), at least 1 and never the whole total; the comments are the rest (S5, S7). */
export function splitPromise(total: number, sampleCounts: ReadonlyArray<number> | undefined): { comments: number; replies: number } {
  const counts = (sampleCounts ?? []).filter((v) => Number.isFinite(v) && v >= 0);
  const mean = counts.length > 0 ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;
  const share = mean > 0 ? mean / (1 + mean) : AGENT_REPLIES_UNKNOWN_SHARE;
  const t = Math.max(0, Math.floor(total));
  const replies = t >= 2 ? Math.min(t - 1, Math.max(1, Math.round(t * share))) : 0;
  return { comments: t - replies, replies };
}
export const completeCountNotesAr = (e: CompleteCountEstimate, parentTitle: string): string[] => {
  const out: string[] = [];
  const read = e.chosen.length - e.skipped;
  if (e.requested === null) out.push(`ستحصل على كل التعليقات على ${n(read)} من ${parentTitle}، وهي ${n(e.total)} تعليقًا بحسب العدّاد الفعلي لكل واحد منها، ويدخل هذا العدد في السعر.`);
  else if (e.total < e.requested) out.push(`المتاح فعليًا ${n(e.total)} تعليقًا فقط من ${n(e.requested)} المطلوبة، بحسب العدّاد الفعلي لكل واحد من ${parentTitle}؛ وهذا العدد هو الذي نسلّمه ويدخل في السعر.`);
  else out.push(`العدد الذي نسلّمه ${n(e.total)} تعليقًا، وهو محسوب من العدّاد الفعلي لكل واحد من ${parentTitle}.`);
  if (e.capped) out.push("المصدر يعطي في كل قراءة عددًا محدودًا من التعليقات لكل عنصر، فالعدد المذكور هو ما يعطيه المصدر فعلًا وقد يقلّ عن عدّاد المنصة.");
  return out;
};

/** The stage with its first pageable alternative (one that reads the same parents) as the recipe, and the source it replaces kept as the next tool. Null when no alternative pages. */
export function promotePageable(stage: PricedStage): PricedStage | null {
  const engine = stage.engine;
  if (!engine || !engine.parent_binding) return null;
  const alternatives = engine.alternatives ?? [];
  const at = alternatives.findIndex((a) => a.cursor_param !== null && Boolean(a.parent_binding));
  if (at < 0) return null;
  const { alternatives: _a, ...current } = engine;
  const alt = alternatives[at];
  const replaced = { endpoint_id: current.endpoint_id, params: current.params, cursor_param: current.cursor_param, map_code: current.map_code, map_file_id: current.map_file_id, ...(current.id_field !== undefined ? { id_field: current.id_field } : {}), parent_binding: engine.parent_binding };
  const { endpoint_id, params, cursor_param, map_code, map_file_id, id_field, parent_binding } = alt;
  const next = { ...current, endpoint_id, params, cursor_param, map_code, map_file_id, parent_binding: parent_binding!, alternatives: [replaced, ...alternatives.filter((_x, i) => i !== at)] } as typeof engine;
  if (id_field !== undefined) next.id_field = id_field; else delete next.id_field;
  return { ...stage, endpoint_id, ...(alt.cost_per_row_usd !== undefined ? { measured_cost_per_row_usd: alt.cost_per_row_usd } : {}), engine: { ...next, alternatives: next.alternatives!.map((a, i) => (i === 0 ? { ...a, cost_per_row_usd: stage.measured_cost_per_row_usd } : a)) } };
}

/** The card's words when the counter includes replies: with the replies stage, the total of comments and replies in two parts; without it, the top-level comments only. */
export const repliesBasisNotesAr = (e: CompleteCountEstimate, parentTitle: string, replies: number | null): string[] => {
  const out: string[] = [];
  if (replies !== null && replies > 0) out.push(`العدد الكلي الذي نسلّمه ${n(e.total + replies)} من التعليقات وردودها (${n(e.total)} تعليقًا أساسيًا و${n(replies)} ردًا)، محسوب من العدّاد الفعلي لكل واحد من ${parentTitle}، ويدخل في السعر.`);
  else out.push(`عدّاد المنصة يشمل الردود، فالتعليقات الأساسية المتوقعة ${n(e.total)} تعليقًا بحسب العدّاد الفعلي لكل واحد من ${parentTitle}، وهي ما نسلّمه ويدخل في السعر.`);
  if (e.capped) out.push("المصدر يعطي في كل قراءة عددًا محدودًا من التعليقات لكل عنصر، فالعدد المذكور هو ما يعطيه المصدر فعلًا وقد يقلّ عن عدّاد المنصة.");
  return out;
};

const NOTE_CAP_AR = "هذا العدد أكبر من الحد الأقصى للمهمة الواحدة، فسنسلّم عددًا محدودًا منه ضمن هذا الحد.";

/**
 * The plan with its comments stage promising what the chosen parents can really supply, the parents pinned, the plan priced again by the one pricing function and the card's note stating the real number. Returns the plan as given when the stage is not a
 * comments stage (a people or replies stage, a stage without a recipe) or when no counter is known for any candidate (then nothing real can be promised and the plan keeps its sampled number, which the card already states).
 */
export async function withCompleteCount(plan: PricedPlan, deps: CompleteCountDeps): Promise<PricedPlan> {
  const all = wantsAllChildren(deps.request);
  let out = plan;
  for (const stage of plan.stages) {
    if (stage.parent_key === null || !stage.deliver || stage.replies_of !== undefined || isPeopleStage(stage) || stage.engine === undefined) continue;
    const parent = out.stages.find((s) => s.key === stage.parent_key);
    if (!parent) continue;
    const listed = await deps.candidatesOf(parent);
    if (!listed || listed.length === 0 || listed.every((c) => c.counter === null)) continue;
    // THE MOST ENGAGED FIRST (S5): the highest counters in front; equal counters keep the source's order, a parent with no counter goes last. An order, never a filter.
    const match = deps.matchesOf ? await deps.matchesOf(parent) : null;
    const fits = (c: Candidate): boolean => match === null || (c.row !== undefined && match(c.row));
    const meaning = deps.topicOf ? deps.topicOf() : null;
    const textKey = textColumnKeyOf(parent.columns) ?? "text";
    const discussion = (c: Candidate): number => (meaning && meaning.kind !== "none" && meaning.kind !== "ambiguous" && c.row !== undefined ? topicDiscussionClass(c.row[textKey], meaning) : 1);
    const candidates = deps.mostEngaged ? listed.map((c, i) => ({ c, i })).sort((a, b) => Number(fits(b.c)) - Number(fits(a.c)) || discussion(b.c) - discussion(a.c) || (b.c.counter ?? -1) - (a.c.counter ?? -1) || a.i - b.i).map((x) => x.c) : listed;
    // THE CARD SAYS HOW THE VIDEOS WERE CHOSEN (S7): the most commented among the results that match the customer's country and language, and how many matched when fewer than needed
    const matching = match === null ? listed.length : listed.filter(fits).length;
    const needed = Math.max(1, parent.planned_rows);
    // THE CARD SAYS WHAT THE TOPIC WAS UNDERSTOOD TO MEAN (S8): videos that talk about it, not stories where it is only a made-with hashtag
    const about = meaning?.kind === "about" && deps.mostEngaged;
    const talking = about ? listed.filter((c) => c.row !== undefined && topicDiscussionClass(c.row[textKey], meaning!) === 2).length : 0;
    const topicNote = about ? [talking >= Math.max(1, parent.planned_rows) ? "اخترنا الفيديوهات التي تتحدث عن الموضوع نفسه، لا التي يظهر فيها وسم لأنها معمولة به." : talking > 0 ? `وجدنا ${n(talking)} فقط من النتائج تتحدث عن الموضوع؛ قدّمناها، ثم الأعلى تعليقًا لإكمال العدد.` : "لم نجد بين النتائج التي قرأناها فيديو يتحدث نصه عن الموضوع؛ سنسلّم الأعلى تعليقًا منها، ويمكنك تعديل الطلب أو الإلغاء قبل الاعتماد."] : [];
    const chosenNote = [...topicNote, ...(deps.mostEngaged && match !== null ? [matching >= needed ? `اخترنا الأعلى تعليقًا من بين النتائج المطابقة لبلدك ولغتك.` : `وجدنا ${n(matching)} من ${n(listed.length)} نتيجة مطابقة لبلدك ولغتك؛ قدّمنا المطابقة، ثم الأعلى تعليقًا لإكمال العدد.`] : [])];
    const perAsked = Number(stage.per_parent_rows);
    const perParent = all || !Number.isFinite(perAsked) || perAsked < 1 ? Number.POSITIVE_INFINITY : Math.floor(perAsked);
    let pageCap = deps.pageCapOf ? await deps.pageCapOf(stage) : null;
    const requested = all ? null : Math.max(1, Math.floor(Number(stage.planned_rows) || 1));
    const input = { parents: Math.max(1, parent.planned_rows), perParent, requested, fallback: Number.isFinite(perParent) ? perParent : Math.max(1, Number(stage.per_parent_rows) || 1) };
    let e = completeCountEstimate(candidates, { ...input, pageCap });
    // A PAGEABLE SOURCE FIRST: when the source of the recipe cannot page far enough to reach the promise, the stage's next tool that pages (and reads the same parents) takes its place BEFORE a shortfall is stated; the source it replaces stays as the next tool
    // S2 item 4: a PAGEABLE source is preferred even when the first source reaches the promise: the catalog's comments tool with a cursor reads a video page after page to its end (the one sampled, else the cheapest the catalog offers that the stage can feed)
    let chosen: PricedStage = stage;
    if (stage.engine.cursor_param === null) {
      let candidate = stage;
      if (!(stage.engine.alternatives ?? []).some((a) => a.cursor_param !== null && Boolean(a.parent_binding)) && deps.pageableAlternativeOf) {
        const found = await deps.pageableAlternativeOf(stage);
        if (found) candidate = { ...stage, engine: { ...stage.engine, alternatives: [found, ...(stage.engine.alternatives ?? [])] } };
      }
      const promoted = promotePageable(candidate);
      if (promoted) { chosen = promoted; pageCap = null; e = completeCountEstimate(candidates, { ...input, pageCap }); }
    }
    // THE BASIS OF THE COUNTER: when it includes replies, the top-level comments are the share of it that the sample measured, and a replies stage under these comments (comments AND replies asked) is promised the rest, so that comments and replies are one total
    const basis = deps.basisOf ? await deps.basisOf(stage) : null;
    const share = basis && basis.share !== null && basis.share > 0 && basis.share < 1 ? basis.share : null;
    let repliesPlanned: number | null = null;
    const repliesStage = out.stages.find((x) => x.replies_of === stage.key);
    if (share !== null) {
      const top = candidates.map((c) => ({ ...c, counter: c.counter === null ? null : Math.floor(c.counter * share) }));
      e = completeCountEstimate(top, { ...input, pageCap });
      const ids = new Set(e.chosen.map((c) => c.id));
      const counted = candidates.filter((c) => ids.has(c.id)).reduce((n, c) => n + supplyOf(c.counter, input.perParent === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : input.perParent / share, null, input.fallback), 0);
      if (repliesStage && requested === null) repliesPlanned = Math.max(0, counted - e.total);
    }
    if (e.total < 1) continue;
    const chosenRows = e.chosen.length > 0 && e.chosen.length === parent.planned_rows && e.chosen.every((c) => c.row !== undefined) ? e.chosen.map((c) => c.row!) : null;
    // THE PROMISE FOR COMMENTS AND REPLIES IS THE COUNTER, NEVER MORE (S5, owner decision): a video's comment counter counts the comments AND the replies together, so with a replies stage the two stages share the counters of the chosen videos: no reply estimate is added on top of them.
    // The split is the sample's measured share (replies per comment m: replies are m/(1+m) of the counter; a silent sample: a stated share), the total is fixed by the counters; each stage may be read up to the total (`promise_total`), because the source gives no more than the counter in all.
    let repliesFromSample: { rows: number } | null = null;
    let promiseTotal: number | null = null;
    let repliesOpen = false;
    if (repliesStage && repliesPlanned === null) {
      const counts = (repliesStage.replies_sample_counts ?? []).filter((n) => Number.isFinite(n) && n >= 0);
      const mean = counts.length > 0 ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;
      const share = mean > 0 ? mean / (1 + mean) : AGENT_REPLIES_UNKNOWN_SHARE;
      if (requested === null) {
        // «all»: comments + replies = the counters of the chosen parents
        const total = e.total;
        const replies = splitPromise(total, repliesStage.replies_sample_counts).replies;
        if (replies >= 1) { repliesFromSample = { rows: replies }; promiseTotal = total; e = { ...e, total: total - replies }; }
      } else {
        // a number was asked for the comments: the replies are what the sample says for them, and never above what is left of the counters
        const counters = e.chosen.reduce((n, c) => n + (c.counter === null ? 0 : Math.floor(c.counter)), 0);
        const room = Math.max(0, counters - e.total);
        const replies = Math.min(room, Math.max(1, Math.round(e.total * (mean > 0 ? mean : share / (1 - share)))));
        // S9: the comments are fewer than the counters: the replies are «all the replies of the chosen comments», never a number promised from an estimate (the estimate only prices them, as a maximum)
        if (replies >= 1) { repliesFromSample = { rows: replies }; repliesOpen = true; }
      }
    }
    const stages = out.stages.map((s) => {
      if (repliesFromSample && s.key === repliesStage!.key) {
        const est = repliesEstimateFor(s, Math.max(1, e.total), s.per_parent_rows ?? AGENT_REPLIES_PER_COMMENT_DEFAULT, 0);
        return { ...s, planned_rows: repliesFromSample.rows, expected_rows: repliesFromSample.rows, ...(promiseTotal !== null ? { promise_total: promiseTotal } : {}), ...(repliesOpen ? { replies_open: true } : {}), measured_cost_per_row_usd: est.costPerRowUsd * (est.rows / repliesFromSample.rows) };
      }
      if (repliesPlanned !== null && repliesPlanned > 0 && s.key === repliesStage!.key) return { ...s, planned_rows: repliesPlanned, expected_rows: repliesPlanned, per_parent_rows: AGENT_REPLIES_PER_COMMENT_MAX, promise_total: e.total + repliesPlanned };
      // THE PINNED PARENTS' ROWS (S2 item 6): the rows the plan measured for the chosen parents, so execution reads THESE parents without a new search (kept only when every chosen parent has its row and they are the parents the stage promises)
      if (s.key === parent.key) return chosenRows ? { ...s, pinned_rows: chosenRows } : s;
      if (s.key === stage.key) return { ...chosen, planned_rows: e.total, expected_rows: e.total, per_parent_rows: Number.isFinite(perParent) ? Math.min(perParent, Math.max(1, e.perParent)) : Math.max(1, e.perParent), all_children: true, ...(promiseTotal !== null ? { promise_total: promiseTotal } : repliesPlanned !== null && repliesPlanned > 0 ? { promise_total: e.total + repliesPlanned } : {}), parent_pins: e.chosen.map((c) => c.id) };
      return s;
    });
    // THE CALL ASKS FOR WHAT THE PROMISE NEEDS (S2 item 3): the recipe froze the planner's sample size (`limit: 20`); a source with no next page is asked for the largest share of any parent, up to the maximum its schema states. The same holds for a next tool with no
    // next page (the tool a pageable one replaced keeps its place as the fallback, and is read to the same size).
    if (chosen.engine && deps.pageSizeOf) {
      const at = stages.findIndex((x) => x.key === stage.key);
      const target = stages[at];
      const want = Math.max(1, Math.floor(e.perParent));
      const lifted = async (endpoint_id: string, cursor: string | null, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
        if (cursor !== null) return params;
        const size = await deps.pageSizeOf!({ ...target, endpoint_id, engine: { ...target.engine!, endpoint_id, cursor_param: cursor } });
        return size ? { ...params, [size.param]: Math.min(size.max, want) } : params;
      };
      const engine = target.engine!;
      stages[at] = { ...target, engine: { ...engine, params: await lifted(engine.endpoint_id, engine.cursor_param, engine.params), ...(engine.alternatives ? { alternatives: await Promise.all(engine.alternatives.map(async (a) => ({ ...a, params: await lifted(a.endpoint_id, a.cursor_param, a.params) }))) } : {}) } };
    }
    const price = priceMissionByCode(stagePriceInputs(stages, out.contact_steps), { settings: out.price.settings });
    if (price.overCap) { if (!(out.notes_ar ?? []).includes(NOTE_CAP_AR)) out = { ...out, notes_ar: [...(out.notes_ar ?? []), NOTE_CAP_AR] }; continue; }
    const notes = share === null ? completeCountNotesAr(e, parent.title_ar) : repliesBasisNotesAr(e, parent.title_ar, repliesPlanned);
    out = { ...out, stages, price, notes_ar: [...(out.notes_ar ?? []).filter((x) => !notes.includes(x) && !chosenNote.includes(x)), ...chosenNote, ...notes] };
  }
  return out;
}
