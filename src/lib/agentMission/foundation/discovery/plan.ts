import { toArabicDigits } from "../../../arabicDigits";
import type { Ask } from "../ask";
import type { CardRole, ToolCard } from "../toolCards/types";

/**
 * ROUND 33, CATALOG DISCOVERY: what a plan says about a source that was DISCOVERED (a card derived from the catalog): the audit mark stored with the plan, the choice among candidates, and the customer's sentences. Pure; Arabic only for the customer.
 */
export type Completeness = "complete_within_source" | "partial" | "unknown";

/** The three states a source's pages can leave: the last page read had no next page (complete within what the source gives), the source says it has more (partial: the file covers what was read), or the source's paging is not described or its last page says nothing (unknown). Never «all of the platform». */
export function completenessOf(paging: "declared" | "unknown", hasMore: boolean | null): Completeness {
  if (paging === "unknown" || hasMore === null) return "unknown";
  return hasMore ? "partial" : "complete_within_source";
}

export interface DiscoveryMark {
  endpoint_id: string;
  role: CardRole;
  derived: true;
  paging: "declared" | "unknown";
  pages_read: number;
  /** The rows the stage will deliver at most (the approved count of parents). */
  rows_planned: number;
  completeness: Completeness;
  /** How the card was chosen: by the model among the validated candidates, or by the compiler's own ranking. `candidates` are the ids that passed validation (the model never saw another). */
  selection?: { by: "model" | "rank"; candidates: string[]; reason?: string };
}

export function discoveryMarkOf(card: ToolCard, read: { pages: number; rows: number; hasMore: boolean | null; selection?: DiscoveryMark["selection"] }): DiscoveryMark {
  const paging = card.derived?.paging ?? "unknown";
  return { endpoint_id: card.endpointId, role: card.role, derived: true, paging, pages_read: read.pages, rows_planned: read.rows, completeness: completenessOf(paging, read.hasMore), ...(read.selection ? { selection: read.selection } : {}) };
}

export const DISCOVERED_SOURCE_NOTE_AR = "اخترنا مصدر هذه الخطوة من دليل المصادر، ولم يُجرَّب من قبل على صفحات حقيقية في هذا النظام، فراجع العينة قبل الاعتماد.";
export const COMPLETENESS_AR: Record<Completeness, string> = {
  complete_within_source: "انتهت نتائج المصدر عند آخر صفحة قرأناها، فالقراءة مكتملة ضمن ما يتيحه هذا المصدر؛ وهذا لا يعني أنها كل ما نُشر على المنصة.",
  partial: "في المصدر نتائج أخرى لم نقرأها قبل الاعتماد، فالملف يغطي ما قرأناه فقط وليس كل ما في المنصة.",
  unknown: "لا نعرف إن كانت نتائج هذا المصدر كاملة، لأنه لا يصف ترقيم صفحاته بما يكفي؛ ما نسلّمه هو ما قرأناه فقط.",
};

/** The sentences of the plan card for a discovered source (nothing about providers, prices or tools' names; Arabic-Indic digits). */
export function discoveryNotesAr(card: ToolCard, ask: Pick<Ask, "topic" | "period">, mark: DiscoveryMark): string[] {
  const notes = [DISCOVERED_SOURCE_NOTE_AR];
  if (card.inputs.query?.format === "hashtag" && ask.topic.text) notes.push(`البحث هنا بالوسم «#${ask.topic.text.trim().replace(/^#+/, "").replace(/\s+/g, "_")}»، فيشمل المنشورات التي وُسمت به فقط، وقد لا يشمل ما كُتب عن الموضوع دون وسم.`);
  notes.push(`قرأنا ${toArabicDigits(mark.pages_read)} ${mark.pages_read === 1 ? "صفحة" : mark.pages_read === 2 ? "صفحتين" : "صفحات"} من المصدر. ${COMPLETENESS_AR[mark.completeness]}`);
  return notes;
}

/** The candidates a model may choose among (only what code validated: never a free endpoint id). */
export interface CandidateView {
  endpointId: string;
  /** The catalog's own name of what the tool does («instagram.search.reels», «instagram.hashtag.posts»): what lets a model tell a reels search from a hashtag search. */
  capability: string | null;
  role: CardRole;
  /** `verified` on stored real pages, or `catalog_only` (derived from the catalog or not yet captured). */
  status: ToolCard["status"];
  derived: boolean;
  carries: string[];
  cannot: string[];
  costUsdPerPage: number;
  paging: "declared" | "unknown" | "verified";
}
export type SelectCapability = (input: { request: string; topic: string | null; candidates: CandidateView[] }) => Promise<{ endpointId: string; reason: string; costUsd: number } | null>;

export function candidateViewOf(card: ToolCard, carries: string[], capability: string | null = null): CandidateView {
  return { endpointId: card.endpointId, capability, role: card.role, status: card.status, derived: card.derived !== undefined, carries, cannot: [...(card.cannot ?? [])], costUsdPerPage: card.costUsdPerPage, paging: card.derived ? card.derived.paging : card.inputs.cursor ? "verified" : "unknown" };
}

export const SELECT_SYSTEM = `You choose WHICH data tool reads the items (videos, posts, tweets) of a customer's research request. You are shown only tools that code already validated against the catalog; you cannot name any other. Prefer the tool that carries the most of what the request asks (keyword, period, country) and whose paging is declared; prefer a verified tool to a catalog_only one when they carry the same. Never decide prices. Answer with JSON only: {"endpointId": "<one of the listed ids>", "reason": "<one short English sentence>"}.`;

export function selectPrompt(request: string, topic: string | null, candidates: ReadonlyArray<CandidateView>): string {
  return `Request: ${JSON.stringify(request.slice(0, 600))}\nTopic: ${JSON.stringify(topic)}\nCandidates:\n${candidates.map((c) => JSON.stringify(c)).join("\n")}`;
}

/** The model's answer, accepted ONLY if it names one of the candidates it was shown (anything else, or unreadable text, is no answer and the compiler's own ranking decides). */
export function parseSelection(text: string, candidates: ReadonlyArray<CandidateView>): { endpointId: string; reason: string } | null {
  const m = /\{[\s\S]*\}/.exec(String(text ?? ""));
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as { endpointId?: unknown; reason?: unknown };
    const id = typeof o.endpointId === "string" ? o.endpointId : "";
    if (!candidates.some((c) => c.endpointId === id)) return null;
    return { endpointId: id, reason: typeof o.reason === "string" ? o.reason.slice(0, 200) : "" };
  } catch { return null; }
}

/**
 * WHAT THE DELIVERED FILE SAYS about a source that was discovered, from the plan's mark and how the read ENDED (the engine's recorded stop): complete within what the source's pages gave, partial because of a known limit or a failure, or unknown. Never «all of the platform»:
 * a provider's search index is not the platform. Arabic only, no provider name, no price.
 */
export function deliveryCompletenessLineAr(mark: DiscoveryMark, stageTitle: string, stop: string | null | undefined, delivered: number): string {
  const head = `«${stageTitle}»: مصدر هذه المرحلة اختير من دليل المصادر.`;
  const tail = "وهذا الملف من نتائج هذا المصدر فقط، ولا يمثل كل ما نُشر على المنصة.";
  const n = toArabicDigits(delivered);
  if (stop === "source_exhausted") return `${head} انتهت نتائج المصدر قبل بلوغ الحد المعتمد، فالقراءة مكتملة ضمن ما يتيحه المصدر (${n} ${delivered === 1 ? "عنصر" : "عنصرًا"}). ${tail}`;
  if (stop === "target_reached") return mark.completeness === "complete_within_source"
    ? `${head} بلغت القراءة الحد المعتمد (${n})، وكان المصدر قد انتهى عند آخر صفحة قرأناها. ${tail}`
    : `${head} توقفت القراءة عند الحد المعتمد (${n})، وقد يكون في المصدر نتائج أخرى لم تُقرأ، فالتسليم جزئي بحكم الحد المعتمد. ${tail}`;
  const reason: Record<string, string> = { budget: "بلوغ ميزانية القراءة المعتمدة", daily_cap: "بلوغ الحد اليومي للمصدر", refused: "رفض قراءة صفحة", failed: "تعذّر قراءة صفحة", page_limit: "بلوغ حد الصفحات المعتمد", time_limit: "انتهاء المهلة", no_new_items: "أن الصفحات الأخيرة لم تأتِ بجديد", internal_error: "خلل داخلي في حفظ النتائج" };
  if (stop && reason[stop]) return `${head} توقفت القراءة بسبب ${reason[stop]}، فالتسليم جزئي (${n}). ${tail}`;
  return `${head} لا نعرف إن كانت القراءة قد استوفت نتائج المصدر، فالاكتمال غير معروف (${n}). ${tail}`;
}
