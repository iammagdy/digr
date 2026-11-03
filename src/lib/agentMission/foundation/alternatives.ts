import type { EngineSpec } from "../plan";
import { CATALOG_ONLY_CAP_USD, CATALOG_ONLY_PRICE_MARGIN, TOOL_CARDS, cardMapCode, type ToolCard } from "./toolCards";
import type { SocialPlatform } from "../redesignFlagTypes";

/**
 * THE COMMENTS ALTERNATIVES OF A COMPILED STAGE (round 16). The engine already continues across tools (agent/src/engine/run.ts: a child stage's `spec.alternatives`, read after the main tool ended before the count by a failed read, an exhausted source or a source that only repeats itself);
 * the legacy builder sets them, the compiler never did, so a compiled comments stage ended where its one tool ended («سُلّم ٣٤ من ٥٤ لأن المصدر لم يعد يعطي»). This module chooses, BY CODE BEFORE APPROVAL, which other cards of the same platform may continue a comments stage. Pure: no I/O, no model, no call.
 *
 * AN ALTERNATIVE IS KEPT ONLY IF IT PASSES EVERY RULE, each one failing closed (a card the rule cannot prove is left out, and the reason is recorded as a code):
 *   - same platform, same exact role (the comments role), a different endpoint, at most two;
 *   - status `verified` with stored evidence; a `catalog_only` card only on a TEST account (owner decision 7.4, inside the 0.20 USD a mission), never for a customer;
 *   - its parent input binds to a value (an id or a link) that EVERY pinned parent row already carries, by the card's explicit `from` (never guessed); a card that needs `parent_binding.also` or a grandparent's field is left out (the engine forwards neither on an alternative);
 *   - its mapping is the comments mapping (the same columns, a stable id, the parent link the engine adds);
 *   - its own cursor: the engine reads each alternative as a stream of its own, never with another provider's token;
 *   - when a replies stage is planned, it carries every identity or token the replies card needs (Facebook's `feedback_id` and `expansion_token`, YouTube's reply token), otherwise it is left out;
 *   - the rows it gives carry the same KIND of date as the main card's (an exact date, or a relative text turned into a marked approximate day), otherwise a file would mix dates the limits line does not explain;
 *   - its comment ids are PROVEN equal to the main card's on stored pages (`COMMENT_ID_PROOFS`): the only de-duplication is the exact identity, never the text, the author or the time. A `catalog_only` card on a test account has no stored pages by definition; its first real pages are what the owner's live round is for (the plan marks it as a capture).
 */
export type AltEntry = NonNullable<EngineSpec["alternatives"]>[number];
export const MAX_COMMENT_ALTERNATIVES = 2;
/** Decision A (owner): the quote is computed on the dearest compatible alternative only when it costs more than this many times the main tool per expected row. */
export const ALTERNATIVE_QUOTE_FACTOR = 2;

export type AltExclusion = "status" | "no_evidence" | "no_parent_input" | "needs_also" | "parent_value_missing" | "mapping" | "replies_identity" | "date_semantics" | "ids_unproven";

export interface CommentAlternative {
  card: ToolCard;
  entry: AltEntry;
  /** A `catalog_only` card on a test account: its pages are being captured for the first time (its ids are not yet proven equal to the main card's). */
  capture: boolean;
}
export interface AlternativesResult { alternatives: CommentAlternative[]; excluded: Array<{ endpointId: string; reason: AltExclusion }> }

/**
 * THE PROOF THAT TWO COMMENTS CARDS GIVE THE SAME COMMENT THE SAME ID, taken from stored real pages (tests/round16-comment-id-proofs.test.ts recomputes each from the fixtures): the calls of the two cards on the same parent, and the comments both of them gave (equal ids for the same text and instant).
 *  - Instagram: msn_afe9bb0b436670e35a3c, planning calls 3 (anyapi) and 4 (scrapecreators) read the SAME post: the one comment is `18116498825601057` in both, with the same text and the same instant. One comment is thin evidence; the live round of round 16 is asked for more.
 *  - YouTube: video GIWkArP7RJE was read by crawl4ai (msn_ee599cdbbde993073b15, call 11) and by tikhub (msn_41a73a6b2c0b4a76ef0a, call 7): the native comment ids («UgwoGai9...») are the same. (The pair is left out of a stage by `date_semantics`; the proof is kept because it is true.)
 */
export interface IdProof { a: string; b: string; mission: { a: string; b: string }; calls: { a: string[]; b: string[] } }
export const COMMENT_ID_PROOFS: ReadonlyArray<IdProof> = [
  { a: "anyapi.instagram.post.comments", b: "scrapecreators.instagram.post.comments", mission: { a: "msn_afe9bb0b436670e35a3c", b: "msn_afe9bb0b436670e35a3c" }, calls: { a: ["call_0003"], b: ["call_0004"] } },
  { a: "crawl4ai.youtube.video.comments", b: "tikhub.youtube.video.comments", mission: { a: "msn_ee599cdbbde993073b15", b: "msn_41a73a6b2c0b4a76ef0a" }, calls: { a: ["call_0011"], b: ["call_0007"] } },
];
export const idsProvenEqual = (x: string, y: string, proofs: ReadonlyArray<IdProof> = COMMENT_ID_PROOFS): boolean => proofs.some((p) => (p.a === x && p.b === y) || (p.a === y && p.b === x));

/** The price of one row read through a card: one call over the rows a call gives (the same figure the compiler prices a stage by). */
export const costPerRowOf = (card: ToolCard): number => card.costUsdPerPage / Math.max(1, card.page.observedRowsPerPage);

const present = (v: unknown): boolean => (typeof v === "string" && v.trim() !== "") || (typeof v === "number" && Number.isFinite(v));

export function commentsAlternativesOf(input: {
  platform: SocialPlatform;
  /** The card the stage is built on. */
  primary: ToolCard;
  /** The pinned parents' rows (the rows the stage will read, each already mapped by its parent card). */
  parents: ReadonlyArray<Record<string, unknown>>;
  /** The replies card of a replies stage that IS planned over these comments (null: no replies stage). */
  repliesCard: ToolCard | null;
  /** A test account may use `catalog_only` cards (owner decision 7.4). */
  catalogOnly: boolean;
  /** Written by tests (synthetic cards); absent: every tool card. */
  cards?: ReadonlyArray<ToolCard>;
  idProofs?: ReadonlyArray<IdProof>;
}): AlternativesResult {
  const { platform, primary, parents, repliesCard, catalogOnly } = input;
  const proofs = input.idProofs ?? COMMENT_ID_PROOFS;
  const excluded: AlternativesResult["excluded"] = [];
  const kept: CommentAlternative[] = [];
  for (const card of input.cards ?? TOOL_CARDS) {
    if (card.platform !== platform || card.role !== primary.role || card.endpointId === primary.endpointId) continue;
    const leave = (reason: AltExclusion): void => { excluded.push({ endpointId: card.endpointId, reason }); };
    if (card.status !== "verified" && !(card.status === "catalog_only" && catalogOnly)) { leave("status"); continue; }
    if (card.status === "verified" && card.verifiedOn.flatMap((v) => v.calls).length === 0) { leave("no_evidence"); continue; }
    const parent = card.inputs.parent;
    if (!parent) { leave("no_parent_input"); continue; }
    if ((parent.also ?? []).length > 0) { leave("needs_also"); continue; }
    if (parents.length === 0 || !parents.every((p) => present(p[parent.from]))) { leave("parent_value_missing"); continue; }
    if (card.mapping.kind !== "replies") { leave("mapping"); continue; }
    if (repliesCard?.inputs.parent) {
      // what the replies stage binds to on each comment: the comment's id, or a token the comments card keeps on the row; the parent's parent (the video) is not on the comment row and the engine takes it from the stage above
      const needed = [repliesCard.inputs.parent.from, ...(repliesCard.inputs.parent.also ?? []).filter((a) => a.grand !== true).map((a) => a.from)];
      const tokens = new Set((card.mapping.tokens ?? []).map((t) => t.key));
      if (!needed.every((k) => k === "id" || tokens.has(k))) { leave("replies_identity"); continue; }
    }
    if ((card.mapping.relativeDates === true) !== (primary.mapping.kind === "replies" && primary.mapping.relativeDates === true)) { leave("date_semantics"); continue; }
    const capture = card.status === "catalog_only";
    if (!capture && !idsProvenEqual(primary.endpointId, card.endpointId, proofs)) { leave("ids_unproven"); continue; }
    kept.push({
      card,
      capture,
      entry: { endpoint_id: card.endpointId, params: structuredClone(card.inputs.fixed ?? {}), cursor_param: card.inputs.cursor, map_code: cardMapCode(card), map_file_id: "page", parent_binding: { param: parent.param, from: parent.from }, cost_per_row_usd: costPerRowOf(card) },
    });
  }
  // the order: a card with proven ids before a capture, then the fewest conditions it cannot carry, then a paged source before a one-page source, then the cheaper row, then the endpoint id
  kept.sort((x, y) => Number(x.capture) - Number(y.capture) || (x.card.cannot ?? []).length - (y.card.cannot ?? []).length || Number(x.card.inputs.cursor === null) - Number(y.card.inputs.cursor === null) || costPerRowOf(x.card) - costPerRowOf(y.card) || (x.card.endpointId < y.card.endpointId ? -1 : x.card.endpointId > y.card.endpointId ? 1 : 0));
  return { alternatives: kept.slice(0, MAX_COMMENT_ALTERNATIVES), excluded };
}

/**
 * DECISION A (owner): the price the customer approved never changes after approval, and the difference an alternative costs is ours. The quote is the main tool's cost per expected row, EXCEPT when the dearest compatible alternative costs more than twice that per
 * expected row: then the quote is computed on that alternative's cost (so the customer's price already covers a source the main one may hand over to). Read by the compiler and fed to the one pricing path (stagePriceInputs / priceMissionByCode); nothing of the pricing is changed.
 */
export function quoteCostPerRowOf(primary: ToolCard, alternatives: ReadonlyArray<CommentAlternative>): number {
  const own = costPerRowOf(primary);
  const dearest = alternatives.reduce((m, a) => Math.max(m, costPerRowOf(a.card)), 0);
  return dearest > ALTERNATIVE_QUOTE_FACTOR * own ? dearest : own;
}

/** The pages a stage that may use a `catalog_only` card is allowed (the 0.20 USD a mission, at twice the catalog price per page, shared by the stages that use such a card). */
export const catalogOnlyPagesOf = (card: ToolCard, sharedBy: number): number => Math.max(1, Math.floor(CATALOG_ONLY_CAP_USD / Math.max(1, sharedBy) / (card.costUsdPerPage * CATALOG_ONLY_PRICE_MARGIN) + 1e-9));

/** The line the card says when a stage has an alternative (white label: no provider, no endpoint). */
export const ALTERNATIVE_LINE_AR = "إن توقف مصدر الجمع قبل الوصول للعدد، نحاول الإكمال من مصدر آخر للمنصة نفسها، داخل حدود الخطة المعتمدة.";
