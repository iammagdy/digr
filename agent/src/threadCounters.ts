import { formatAr } from "../../src/lib/arabicDigits";
import { countAr, GENERIC_ITEM_NOUN, knownItemNoun } from "../../src/lib/agentMission/itemNoun";
import { childCountOf } from "../../src/lib/agentMission/childCount";
import { AGENT_REPLIES_PER_COMMENT_MAX } from "../../src/lib/agentMission/constants";
import { readsAllReplies } from "../../src/lib/agentMission/repliesCard";
import type { PricedPlan } from "../../src/lib/agentMission/plan";
import { alternativesGapBodyAr, expectedCommentsOf } from "../../src/lib/agentMission/foundation/deliveryContract";

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
  /** Round 14 (delivery contract R2): per parent, the reply counters of its DELIVERED comments (each up to the replies read per comment). When given, a parent whose replies delivered are fewer than that has the two numbers in its line. */
  replyCountersByParent?: ReadonlyMap<string, number>;
  /** Round 14: the line names the parent by its place in the file («المنشور رقم ١: ...»), as every other gap line does. Only a compiled plan sets it (the old path's lines are what they were). */
  ordinal?: boolean;
  /** ROUND 19: false when the source's counter counts the top-level comments ONLY (Instagram, Facebook, YouTube): the replies delivered then never make up a comment that is missing. True (the default, TikTok's video counter) when it counts the comments AND their replies. */
  counterIncludesReplies?: boolean;
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
  for (const [index, p] of f.parents.entries()) {
    if (p.counter === null || !Number.isFinite(p.counter)) continue;
    const c = comments.get(String(p.id)) ?? 0;
    const r = replies.get(String(p.id)) ?? 0;
    const said = [c > 0 ? countAr(c, comment, { subject: true }) : "", r > 0 ? countAr(r, reply, { subject: true }) : ""].filter(Boolean);
    const counterLine = `${f.ordinal === true ? `${the} رقم ${formatAr(index + 1)}: ` : ""}عداد ${the} ${formatAr(p.counter)}، ${said.length > 0 ? `سُلّم ${said.join(" و")}` : "ولم يُسلَّم منه شيء"}`;
    const replyCounters = f.ordinal === true ? f.replyCountersByParent?.get(String(p.id)) : undefined;
    const repliesGap = replyCounters !== undefined && r < replyCounters;
    const repliesPart = repliesGap ? `؛ ردود التعليقات المسلّمة بحسب عدّاداتها ${countAr(replyCounters!, reply, { subject: true })} وسُلّم منها ${countAr(r, reply, { subject: true })}` : "";
    const short = (f.counterIncludesReplies === false ? c : c + r) < p.counter || repliesGap;
    const limitLine = short ? `${counterLine}${repliesPart}؛ ${f.cappedParents?.has(String(p.id)) ? "وبعض التعليقات لها ردود أكثر من الحد الأقصى المقروء لكل تعليق، والباقي لم يعطِه المصدر" : "والفرق لم يعطِه المصدر"}` : null;
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
  /** ROUND 19: each parent's own counter (id -> counter, null when it has none): the comments a parent can give are at most min(asked, counter), and the line says the counter when it is the smaller. */
  counters?: ReadonlyMap<string, number | null>;
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
    // ROUND 19: asked or counter, whichever is smaller: a parent whose counter is below the number asked is told against its counter («المتوقع ٩ بحسب عدّاد المنصة»)
    const counter = f.counters?.get(String(p.id)) ?? null;
    const expected = counter !== null && Number.isFinite(counter) ? Math.min(f.asked, Math.max(0, counter)) : f.asked;
    const askedPart = expected < f.asked ? `المتوقع ${countAr(expected, comment, { subject: true })} بحسب عدّاد المنصة وسُلّم ${countAr(delivered, comment, { subject: true })}` : `طلبت ${countAr(f.asked, comment, { subject: true })} وسُلّم ${countAr(delivered, comment, { subject: true })}`;
    const parts: string[] = [];
    if (delivered < expected) parts.push(askedPart);
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
 * EVERY GAP OF A COMPILED PLAN'S COMMENTS, PER PARENT, EVEN WITH NO COUNTER (live round 10, msn_67cafa6747d70356d9cb: video 1 gave 40 comments, video 2 none, no reply was read, and «حدود هذا التسليم» said «لا قيود سُجّلت»: the videos carried no counter, so no line was written). For each delivered parent:
 the comments delivered (against the source's counter when the row has one, else it says the source shows none), the reply counters of the DELIVERED comments against the replies delivered, and a limit line whenever the parent gave no comment, reached the per-parent reading limit, fell short of its counter or its comments'
 reply counters. The reason of a parent that gave nothing is the recorded stop of the stage, never a guess. Pure: counts in, Arabic out.
 */
export function openThreadGapLinesAr(f: { parentNoun: string; parents: ReadonlyArray<{ id: string; counter: number | null }>; comments: ReadonlyArray<{ id: string; parentId: string; replies: number | null }>; replyParentCommentIds: ReadonlyArray<string> | null; repliesCap: number; commentsCap: number | null; commentsStop: string | null | undefined; repliesStop: string | null | undefined }): { counterLines: string[]; limitLines: string[] } {
  const parentNoun = knownItemNoun(f.parentNoun) ?? GENERIC_ITEM_NOUN;
  const comment = knownItemNoun("تعليق")!;
  const reply = knownItemNoun("رد")!;
  const counterLines: string[] = [];
  const limitLines: string[] = [];
  const repliesOfComment = new Map<string, number>();
  for (const c of f.replyParentCommentIds ?? []) repliesOfComment.set(String(c), (repliesOfComment.get(String(c)) ?? 0) + 1);
  const stopWhy = (stop: string | null | undefined): string => (stop === "page_limit" ? "بلغت القراءة الحد الأقصى لعدد الصفحات المسموح لهذه المهمة" : stop === "budget" ? "بلغت القراءة حدّ الميزانية المسموح لهذه المهمة" : stop === "time_limit" ? "انتهى الوقت المسموح للقراءة" : stop === "failed" ? "تعذّرت القراءة من المصدر" : "لم يعطِ المصدر تعليقات لهذا" + parentNoun.singular);
  f.parents.forEach((p, i) => {
    const mine = f.comments.filter((c) => c.parentId === String(p.id));
    const got = mine.length;
    const head = `ال${parentNoun.singular} رقم ${formatAr(i + 1)}`;
    const hasCounter = p.counter !== null && Number.isFinite(p.counter);
    let line = `${head}: ${hasCounter ? `عدّاد المنصة ${formatAr(p.counter!)}، وسُلّم ${countAr(got, comment, { subject: true })}` : `لا يعرض المصدر عدّاد تعليقاته، وسُلّم ${countAr(got, comment, { subject: true })}`}`;
    const parts: string[] = [];
    if (got === 0) parts.push(`لم يُسلَّم منه أي تعليق، ${stopWhy(f.commentsStop)}`);
    else if (f.commentsCap !== null && got >= f.commentsCap) parts.push(`بلغت قراءة تعليقاته الحد الأقصى المحسوب لكل ${parentNoun.singular} وهو ${formatAr(f.commentsCap)}، وقد يكون في المصدر المزيد`);
    else if (hasCounter && got < p.counter!) parts.push(`سُلّم ${countAr(got, comment, { subject: true })} من عدّاد ${formatAr(p.counter!)}، والفرق لم يعطِه المصدر`);
    if (f.replyParentCommentIds !== null) {
      const counters = mine.reduce((n, c) => n + Math.min(f.repliesCap, Math.max(0, c.replies ?? 0)), 0);
      const gotReplies = mine.reduce((n, c) => n + (repliesOfComment.get(c.id) ?? 0), 0);
      const repliesPart = `ردود التعليقات المسلّمة بحسب عدّاداتها ${countAr(counters, reply, { subject: true })} وسُلّم منها ${countAr(gotReplies, reply, { subject: true })}`;
      line += `؛ ${repliesPart}`;
      if (gotReplies < counters) parts.push(`${repliesPart}${f.repliesStop === "page_limit" ? "؛ وتوقفت قراءة الردود عند الحد الأقصى لعدد الصفحات المسموح لهذه المهمة" : f.repliesStop === "budget" || f.repliesStop === "time_limit" || f.repliesStop === "failed" ? `؛ ${stopWhy(f.repliesStop)}` : "؛ والفرق لم يعطِه المصدر"}`);
    }
    counterLines.push(line);
    if (parts.length > 0) limitLines.push(`${head}: ${parts.join("؛ ")}`);
  });
  return { counterLines, limitLines };
}

/**
 * THE REPLIES GAP OF A PARENT THAT HAS NO COMMENTS STAGE (live round 7, msn_9fa5ba384c05a25247e1: 20 tweets, replies by the platform's counters 33, delivered 25; the file said nothing about the replies). For each delivered parent (a tweet), the reply counter its own row carries
 * against the replies delivered under it, and only that: never the whole of the parent's other numbers. A parent with no counter and no reply is not listed (no noise). A gap is a line only when fewer were delivered than the counter says (the cap, when there is one, counts first); more than the counter
 * is told in the counter line and is not called a gap. Pure: counts in, Arabic out.
 */
export function tweetRepliesGapLinesAr(f: { parentNoun: string; parents: ReadonlyArray<{ id: string; counter: number | null }>; replyParentIds: ReadonlyArray<string>; repliesCap: number; /** The replies stage stopped because it reached the most pages this mission may read (round 8: the pageable route is followed to its end or to this cap). */ stoppedAtPageLimit?: boolean }): { counterLines: string[]; limitLines: string[] } {
  const parentNoun = knownItemNoun(f.parentNoun) ?? GENERIC_ITEM_NOUN;
  const reply = knownItemNoun("رد")!;
  const got = new Map<string, number>();
  for (const p of f.replyParentIds) got.set(p, (got.get(p) ?? 0) + 1);
  const counterLines: string[] = [];
  const limitLines: string[] = [];
  f.parents.forEach((p, i) => {
    const counter = Math.min(f.repliesCap, Math.max(0, p.counter ?? 0));
    const delivered = got.get(p.id) ?? 0;
    if (counter === 0 && delivered === 0) return;
    const head = `ال${parentNoun.singular} رقم ${formatAr(i + 1)}`;
    const line = `${head}: ردودها بحسب عدّاد المنصة ${countAr(counter, reply, { subject: true })} وسُلّم منها ${countAr(delivered, reply, { subject: true })}`;
    counterLines.push(line);
    if (delivered < counter) limitLines.push(`${line}؛ ${f.stoppedAtPageLimit === true ? "وتوقفت قراءة الردود عند الحد الأقصى لعدد الصفحات المسموح لهذه المهمة، فلم نقرأ الباقي" : "والفرق لم يعطِه المصدر"}`);
  });
  return { counterLines, limitLines };
}

/**
 * THE COUNTER LINES OF A DELIVERY, from the plan and the delivered rows: for every delivered comments stage that has a parent whose rows carry the source's own counter (a video's comments count), one line per parent. Empty for a plan with no such stage. `parentNoun` is the noun the plan's own
 * title says («فيديو»), found by the caller (methodology.ts knownNounOf).
 */
export function threadCounterLinesOfPlan(plan: Pick<PricedPlan, "stages"> & { compiled?: PricedPlan["compiled"] }, rowsByStage: Record<string, Array<Record<string, unknown>>>, nounOf: (title: string | undefined) => string | null | undefined, stops: Readonly<Record<string, string | null | undefined>> = {}, routes: Readonly<Record<string, Readonly<Record<string, number>>>> = {}): { counterLines: string[]; limitLines: string[] } {
  const counterLines: string[] = [];
  const limitLines: string[] = [];
  // THE REPLIES OF A TOP-LEVEL PARENT (X: a tweet has no comments stage, its replies are the child stage; live round 7, msn_9fa5ba384c05a25247e1): the gap per tweet, the way TikTok says it per video
  for (const stage of plan.stages) {
    if (plan.compiled?.by !== "compiler" || !stage.deliver || stage.replies_of === undefined) continue;
    const parentStage = plan.stages.find((p) => p.key === stage.replies_of);
    if (!parentStage || parentStage.parent_key !== null) continue;
    const lines = tweetRepliesGapLinesAr({
      parentNoun: nounOf(parentStage.title_ar) ?? "عنصر",
      parents: (rowsByStage[parentStage.key] ?? []).map((r) => ({ id: String(r.id), counter: childCountOf(r) })),
      replyParentIds: (rowsByStage[stage.key] ?? []).map((r) => String(r.parent_id ?? "")),
      repliesCap: readsAllReplies(plan, stage) ? Number.POSITIVE_INFINITY : Math.max(1, stage.per_parent_rows ?? AGENT_REPLIES_PER_COMMENT_MAX),
      ...(stops[stage.key] === "page_limit" ? { stoppedAtPageLimit: true } : {}),
    });
    counterLines.push(...lines.counterLines);
    limitLines.push(...lines.limitLines);
  }
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
    // a compiled plan whose comments are OPEN (no counter before reading: a per-parent reading limit that is ours, not the customer's number) or whose parents carry no counter: every gap per parent, counter or not (live round 10)
    if (plan.compiled?.by === "compiler" && (stage.children_cap_per_parent !== undefined || (!(Number.isFinite(asked) && asked > 0) && parents.every((p) => p.counter === null)))) {
      const lines = openThreadGapLinesAr({ parentNoun: nounOf(parentStage.title_ar) ?? "عنصر", parents, comments: comments.map((c) => ({ id: String(c.id), parentId: String(c.parent_id ?? ""), replies: childCountOf(c) })), replyParentCommentIds: replyStage ? replies.map((r) => String(r.parent_id ?? "")) : null, repliesCap: replyStage && readsAllReplies(plan, replyStage) ? Number.POSITIVE_INFINITY : Math.max(1, replyStage?.per_parent_rows ?? AGENT_REPLIES_PER_COMMENT_MAX), commentsCap: stage.children_cap_per_parent ?? null, commentsStop: stops[stage.key], repliesStop: replyStage ? stops[replyStage.key] : null });
      counterLines.push(...lines.counterLines);
      limitLines.push(...lines.limitLines);
      continue;
    }
    if (plan.compiled?.by === "compiler" && Number.isFinite(asked) && asked > 0) {
      const lines = askedGapLinesAr({ parentNoun: nounOf(parentStage.title_ar) ?? "عنصر", asked, counters: new Map(parents.map((p) => [p.id, p.counter] as const)), parents: parents.map((p) => ({ id: p.id })), comments: comments.map((c) => ({ id: String(c.id), parentId: String(c.parent_id ?? ""), replies: childCountOf(c) })), replyParentCommentIds: replyStage ? replies.map((r) => String(r.parent_id ?? "")) : null, repliesCap: replyStage && readsAllReplies(plan, replyStage) ? Number.POSITIVE_INFINITY : Math.max(1, replyStage?.per_parent_rows ?? AGENT_REPLIES_PER_COMMENT_MAX) });
      counterLines.push(...lines.counterLines);
      limitLines.push(...lines.limitLines);
      continue;
    }
    if (parents.every((p) => p.counter === null)) continue;
    const commentToParent = new Map<string, string>(comments.map((c) => [String(c.id), String(c.parent_id ?? "")] as const));
    // a compiled plan that read every reply of each comment capped none of them (the cap of 50 sized the hold only)
    const capped = new Set<string>(replyStage && readsAllReplies(plan, replyStage) ? [] : comments.filter((c) => (childCountOf(c) ?? 0) > (replyStage?.per_parent_rows ?? AGENT_REPLIES_PER_COMMENT_MAX)).map((c) => String(c.parent_id ?? "")));
    const replyCap = replyStage && readsAllReplies(plan, replyStage) ? Number.POSITIVE_INFINITY : Math.max(1, replyStage?.per_parent_rows ?? AGENT_REPLIES_PER_COMMENT_MAX);
    const replyCountersByParent = new Map<string, number>();
    if (replyStage) for (const c of comments) { const p = String(c.parent_id ?? ""); replyCountersByParent.set(p, (replyCountersByParent.get(p) ?? 0) + Math.min(replyCap, Math.max(0, childCountOf(c) ?? 0))); }
    const lines = parentCounterLinesAr({ parentNoun: nounOf(parentStage.title_ar) ?? "عنصر", parents, commentParentIds: comments.map((c) => String(c.parent_id ?? "")), replyParentCommentIds: replies.map((r) => String(r.parent_id ?? "")), commentToParent, cappedParents: capped, ...(plan.compiled?.by === "compiler" ? { ordinal: true, counterIncludesReplies: plan.compiled.platform === "tiktok" } : {}), ...(replyStage ? { replyCountersByParent } : {}) });
    for (const l of lines) { counterLines.push(l.counterLine); if (l.limitLine) limitLines.push(l.limitLine); }
  }
  // ROUND 16: a parent whose comments fell short AFTER an alternative route answered for it says so, per parent: the expected count, the unique comments delivered, the gap, and that the main route and N alternative routes were tried (from the persisted streams only)
  for (const stage of plan.stages) {
    if (plan.compiled?.by !== "compiler" || !stage.deliver || stage.parent_key === null || stage.replies_of !== undefined || nounOf(stage.title_ar) !== "تعليق") continue;
    const tried = routes[stage.key];
    if (!tried) continue;
    const parentStage = plan.stages.find((p) => p.key === stage.parent_key);
    if (!parentStage) continue;
    const comments = rowsByStage[stage.key] ?? [];
    (rowsByStage[parentStage.key] ?? []).forEach((p, i) => {
      const n = tried[String(p.id)] ?? 0;
      const expected = expectedCommentsOf(stage, p);
      const got = comments.filter((c) => String(c.parent_id ?? "") === String(p.id)).length;
      if (n > 0 && expected !== null && got < expected) {
        // ROUND 19: ONE line per parent. The line the stage's own rule already wrote for this parent (asked or counter against delivered, and the replies' part) is replaced by the sentence that also says the routes tried; the replies' part, if any, stays in it.
        const head = `ال${nounOf(parentStage.title_ar) ?? "عنصر"} رقم ${formatAr(i + 1)}`;
        const at = limitLines.findIndex((l) => l.startsWith(`${head}:`));
        const repliesPart = at >= 0 ? /ردود التعليقات المسلّمة بحسب عدّاداتها[^؛]*/.exec(limitLines[at])?.[0] ?? "" : "";
        const merged = `${head}: ${alternativesGapBodyAr({ expected, delivered: got, alternatives: n })}${repliesPart ? `؛ ${repliesPart}` : ""}.`;
        if (at >= 0) limitLines[at] = merged; else limitLines.push(merged);
      }
    });
  }
  return { counterLines, limitLines };
}
