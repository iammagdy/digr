import { formatAr } from "../../src/lib/arabicDigits";
import { countAr, GENERIC_ITEM_NOUN, knownItemNoun } from "../../src/lib/agentMission/itemNoun";
import { childCountOf } from "../../src/lib/agentMission/childCount";
import { AGENT_REPLIES_PER_COMMENT_MAX } from "../../src/lib/agentMission/constants";
import type { PricedPlan } from "../../src/lib/agentMission/plan";

/**
 * THE SOURCE'S OWN COUNTER NEXT TO WHAT WAS DELIVERED (the replies PR; live G4: a video whose own counter showed 25 delivered one comment, and nothing in the file said why). For every parent (video, post) that has its own counter: «عداد الفيديو ٢٥، سُلّم تعليق واحد و٢٣ ردًا», from the recorded counts and the
 * task's nouns. When what was delivered is below the counter, the limit line says so: the difference is what the source did not give (or, for a thread cut at the cap, what the cap left out). Pure: counts in, Arabic out; Arabic-Indic digits, no provider, no money.
 */
export interface ThreadCounterFacts {
  /** The noun of the parent as the task says it («فيديو»); unknown nouns read «عنصر». */
  parentNoun: string;
  /** Every parent delivered, with the source's own counter of its comments and replies (null when its row carries none). */
  parents: ReadonlyArray<{ id: string; counter: number | null }>;
  /** The parent id of each delivered comment. */
  commentParentIds: ReadonlyArray<string>;
  /** The id of the comment each delivered reply answers. */
  replyParentCommentIds: ReadonlyArray<string>;
  /** Which parent each comment belongs to (to place a reply under its video). */
  commentToParent: ReadonlyMap<string, string>;
  /** Parents with a thread the reply cap cut. */
  cappedParents?: ReadonlySet<string>;
}

export interface ThreadCounterLine { parentId: string; delivered: { comments: number; replies: number }; counterLine: string; limitLine: string | null }

export function parentCounterLinesAr(f: ThreadCounterFacts): ThreadCounterLine[] {
  const parentNoun = knownItemNoun(f.parentNoun) ?? GENERIC_ITEM_NOUN;
  const comment = knownItemNoun("تعليق")!;
  const reply = knownItemNoun("رد")!;
  const the = `ال${parentNoun.singular}`;
  const comments = new Map<string, number>();
  const replies = new Map<string, number>();
  for (const p of f.commentParentIds) comments.set(String(p), (comments.get(String(p)) ?? 0) + 1);
  for (const c of f.replyParentCommentIds) { const p = f.commentToParent.get(String(c)); if (p !== undefined) replies.set(p, (replies.get(p) ?? 0) + 1); }
  const out: ThreadCounterLine[] = [];
  for (const p of f.parents) {
    if (p.counter === null || !Number.isFinite(p.counter)) continue;
    const c = comments.get(String(p.id)) ?? 0;
    const r = replies.get(String(p.id)) ?? 0;
    const said = [c > 0 ? countAr(c, comment, { subject: true }) : "", r > 0 ? countAr(r, reply, { subject: true }) : ""].filter(Boolean);
    const counterLine = `عداد ${the} ${formatAr(p.counter)}، ${said.length > 0 ? `سُلّم ${said.join(" و")}` : "ولم يُسلَّم منه شيء"}`;
    const short = c + r < p.counter;
    const limitLine = short ? `${counterLine}؛ ${f.cappedParents?.has(String(p.id)) ? "وبعض التعليقات لها ردود أكثر من الحد الأقصى المقروء لكل تعليق، والباقي لم يعطِه المصدر" : "والفرق لم يعطِه المصدر"}` : null;
    out.push({ parentId: String(p.id), delivered: { comments: c, replies: r }, counterLine, limitLine });
  }
  return out;
}

/**
 * THE COUNTER LINES OF A DELIVERY, from the plan and the delivered rows: for every delivered comments stage that has a parent whose rows carry the source's own counter (a video's comments count), one line per parent. Empty for a plan with no such stage. `parentNoun` is the noun the plan's own
 * title says («فيديو»), found by the caller (methodology.ts knownNounOf).
 */
export function threadCounterLinesOfPlan(plan: Pick<PricedPlan, "stages">, rowsByStage: Record<string, Array<Record<string, unknown>>>, nounOf: (title: string | undefined) => string | null | undefined): { counterLines: string[]; limitLines: string[] } {
  const counterLines: string[] = [];
  const limitLines: string[] = [];
  for (const stage of plan.stages) {
    if (!stage.deliver || stage.parent_key === null || stage.replies_of !== undefined) continue;
    // only a stage of COMMENTS has a thread (a place's reviews or a company's people are not read against a counter in these words)
    if (nounOf(stage.title_ar) !== "تعليق") continue;
    const parentStage = plan.stages.find((p) => p.key === stage.parent_key);
    if (!parentStage) continue;
    const parents = (rowsByStage[parentStage.key] ?? []).map((r) => ({ id: String(r.id), counter: childCountOf(r) }));
    if (parents.every((p) => p.counter === null)) continue;
    const comments = rowsByStage[stage.key] ?? [];
    const replyStage = plan.stages.find((x) => x.replies_of === stage.key);
    const replies = replyStage ? rowsByStage[replyStage.key] ?? [] : [];
    const commentToParent = new Map<string, string>(comments.map((c) => [String(c.id), String(c.parent_id ?? "")] as const));
    const capped = new Set<string>(comments.filter((c) => (childCountOf(c) ?? 0) > AGENT_REPLIES_PER_COMMENT_MAX).map((c) => String(c.parent_id ?? "")));
    const lines = parentCounterLinesAr({ parentNoun: nounOf(parentStage.title_ar) ?? "عنصر", parents, commentParentIds: comments.map((c) => String(c.parent_id ?? "")), replyParentCommentIds: replies.map((r) => String(r.parent_id ?? "")), commentToParent, cappedParents: capped });
    for (const l of lines) { counterLines.push(l.counterLine); if (l.limitLine) limitLines.push(l.limitLine); }
  }
  return { counterLines, limitLines };
}
