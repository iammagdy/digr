import { formatAr } from "../../src/lib/arabicDigits";
import { countAr, GENERIC_ITEM_NOUN, knownItemNoun } from "../../src/lib/agentMission/itemNoun";
import { childCountOf } from "../../src/lib/agentMission/childCount";
import { AGENT_REPLIES_PER_COMMENT_MAX } from "../../src/lib/agentMission/constants";
import { readsAllReplies } from "../../src/lib/agentMission/repliesCard";
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
 * THE GAP, STATED AGAINST WHAT WAS ASKED (live D4, msn_2dfcf9cc113dff442711: «٢٠ تعليق من كل فيديو مع ردودهم»; the file said «عداد الفيديو ٢٨٦، سُلّم ٢٠ تعليقًا و٦ ردود؛ والفرق لم يعطِه المصدر»: the per-video limit set against the WHOLE video counter, which counts every comment and every reply). For a plan
 * that asked for a number of comments FOR EACH parent, each parent has two honest comparisons, and only these two:
 *   - the comments: asked (the customer's number) against delivered;
 *   - the replies: the reply counters of the comments that were DELIVERED against the replies delivered.
 * The parent's own counter is never set against either. Pure: counts in, Arabic out.
 */
export interface AskedThreadFacts {
  parentNoun: string;
  /** The customer's number of comments for each parent. */
  asked: number;
  /** Every delivered parent, in the file's order. */
  parents: ReadonlyArray<{ id: string }>;
  /** The delivered comments: their id, their parent, and their own reply counter (null when the row carries none). */
  comments: ReadonlyArray<{ id: string; parentId: string; replies: number | null }>;
  /** The delivered replies' parent comment ids; null when the plan has no replies stage. */
  replyParentCommentIds: ReadonlyArray<string> | null;
  /** The most replies read for one comment (Infinity when every reply of a comment is read). */
  repliesCap: number;
}

export function askedGapLinesAr(f: AskedThreadFacts): { counterLines: string[]; limitLines: string[] } {
  const parentNoun = knownItemNoun(f.parentNoun) ?? GENERIC_ITEM_NOUN;
  const comment = knownItemNoun("تعليق")!;
  const reply = knownItemNoun("رد")!;
  const counterLines: string[] = [];
  const limitLines: string[] = [];
  const repliesOfComment = new Map<string, number>();
  for (const c of f.replyParentCommentIds ?? []) repliesOfComment.set(String(c), (repliesOfComment.get(String(c)) ?? 0) + 1);
  f.parents.forEach((p, i) => {
    const mine = f.comments.filter((c) => c.parentId === String(p.id));
    const delivered = mine.length;
    const head = `ال${parentNoun.singular} رقم ${formatAr(i + 1)}`;
    const askedPart = `طلبت ${countAr(f.asked, comment, { subject: true })} وسُلّم ${countAr(delivered, comment, { subject: true })}`;
    const parts: string[] = [];
    if (delivered < f.asked) parts.push(askedPart);
    let line = `${head}: ${askedPart}`;
    if (f.replyParentCommentIds !== null) {
      const counters = mine.reduce((n, c) => n + Math.min(f.repliesCap, Math.max(0, c.replies ?? 0)), 0);
      const got = mine.reduce((n, c) => n + (repliesOfComment.get(c.id) ?? 0), 0);
      const repliesPart = `ردود التعليقات المسلّمة بحسب عدّاداتها ${countAr(counters, reply, { subject: true })} وسُلّم منها ${countAr(got, reply, { subject: true })}`;
      line += `؛ ${repliesPart}`;
      if (got < counters) parts.push(repliesPart);
    }
    counterLines.push(line);
    if (parts.length > 0) limitLines.push(`${head}: ${parts.join("؛ ")}؛ والفرق لم يعطِه المصدر`);
  });
  return { counterLines, limitLines };
}

/**
 * THE COUNTER LINES OF A DELIVERY, from the plan and the delivered rows: for every delivered comments stage that has a parent whose rows carry the source's own counter (a video's comments count), one line per parent. Empty for a plan with no such stage. `parentNoun` is the noun the plan's own
 * title says («فيديو»), found by the caller (methodology.ts knownNounOf).
 */
export function threadCounterLinesOfPlan(plan: Pick<PricedPlan, "stages"> & { compiled?: PricedPlan["compiled"] }, rowsByStage: Record<string, Array<Record<string, unknown>>>, nounOf: (title: string | undefined) => string | null | undefined): { counterLines: string[]; limitLines: string[] } {
  const counterLines: string[] = [];
  const limitLines: string[] = [];
  for (const stage of plan.stages) {
    if (!stage.deliver || stage.parent_key === null || stage.replies_of !== undefined) continue;
    // only a stage of COMMENTS has a thread (a place's reviews or a company's people are not read against a counter in these words)
    if (nounOf(stage.title_ar) !== "تعليق") continue;
    const parentStage = plan.stages.find((p) => p.key === stage.parent_key);
    if (!parentStage) continue;
    const parents = (rowsByStage[parentStage.key] ?? []).map((r) => ({ id: String(r.id), counter: childCountOf(r) }));
    const comments = rowsByStage[stage.key] ?? [];
    const replyStage = plan.stages.find((x) => x.replies_of === stage.key);
    const replies = replyStage ? rowsByStage[replyStage.key] ?? [] : [];
    // a COMPILED plan that asked for a number of comments for each parent: the gap is told against that number and against the reply counters of the delivered comments, never against the parent's whole counter (live D4)
    const asked = Number(stage.per_parent_rows);
    if (plan.compiled?.by === "compiler" && Number.isFinite(asked) && asked > 0) {
      const lines = askedGapLinesAr({ parentNoun: nounOf(parentStage.title_ar) ?? "عنصر", asked, parents: parents.map((p) => ({ id: p.id })), comments: comments.map((c) => ({ id: String(c.id), parentId: String(c.parent_id ?? ""), replies: childCountOf(c) })), replyParentCommentIds: replyStage ? replies.map((r) => String(r.parent_id ?? "")) : null, repliesCap: replyStage && readsAllReplies(plan, replyStage) ? Number.POSITIVE_INFINITY : Math.max(1, replyStage?.per_parent_rows ?? AGENT_REPLIES_PER_COMMENT_MAX) });
      counterLines.push(...lines.counterLines);
      limitLines.push(...lines.limitLines);
      continue;
    }
    if (parents.every((p) => p.counter === null)) continue;
    const commentToParent = new Map<string, string>(comments.map((c) => [String(c.id), String(c.parent_id ?? "")] as const));
    // a compiled plan that read every reply of each comment capped none of them (the cap of 50 sized the hold only)
    const capped = new Set<string>(replyStage && readsAllReplies(plan, replyStage) ? [] : comments.filter((c) => (childCountOf(c) ?? 0) > (replyStage?.per_parent_rows ?? AGENT_REPLIES_PER_COMMENT_MAX)).map((c) => String(c.parent_id ?? "")));
    const lines = parentCounterLinesAr({ parentNoun: nounOf(parentStage.title_ar) ?? "عنصر", parents, commentParentIds: comments.map((c) => String(c.parent_id ?? "")), replyParentCommentIds: replies.map((r) => String(r.parent_id ?? "")), commentToParent, cappedParents: capped });
    for (const l of lines) { counterLines.push(l.counterLine); if (l.limitLine) limitLines.push(l.limitLine); }
  }
  return { counterLines, limitLines };
}
