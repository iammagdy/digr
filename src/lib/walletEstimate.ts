import { priceMissionByCode, type StagePriceInput } from "./agentMission/price";
import { toArabicDigits } from "./arabicDigits";
import { AGENT_MAX_DELIVERED_ROWS } from "./agentMission/constants";
// the cards are DATA files (no catalog, no node module): this module is imported by a page that runs in the browser
import { X_CARDS } from "./agentMission/foundation/toolCards/x";
import { YOUTUBE_CARDS } from "./agentMission/foundation/toolCards/youtube";

/**
 * THE WALLET'S «رصيدك يكفي تقريبًا لـ» (round 14). Live: with 113 points the wallet promised «٤١٠ تعليق يوتيوب، ٩٦٤ منشور إكس، ٣٥ شركة», while a real order costs at least 200 points (the minimum of the mission price rule: 20 X tweets cost 200, 101 YouTube items cost 97 of a plan whose
 * maximum charge was 200 or more) and the plan card's price is the rule of `priceMissionByCode`, not the per-record table of the old calculator. Now: the SAME price function the plan card uses (read only), with the verified cards' own cost per row, finds the largest request whose HOLD (maximum charge plus the 15% buffer, or the minimum) fits the balance.
 * Below the minimum there is no estimate, and the page says so. A kind whose shape has no verified card (companies) is not promised. Pure: no I/O.
 */
export interface WalletChip { id: string; labelAr: string; records: number }
export type WalletCapacity = { kind: "below_minimum"; minimumPoints: number } | { kind: "ok"; chips: WalletChip[] };

/** The replies a comments request brings, as a share of its comments, for the estimate (the live Facebook delivery had 26%, the live YouTube one 4%): the higher, so an estimate never promises more than a plan with replies gives. */
export const WALLET_REPLIES_SHARE = 0.25;
/** The most rows one job may deliver (the engine's own limit): an estimate never promises more than one request can bring. */
const MAX_ROWS = AGENT_MAX_DELIVERED_ROWS;

const CARDS = [...YOUTUBE_CARDS, ...X_CARDS];
const costPerRow = (endpointId: string): number => { const c = CARDS.find((x) => x.endpointId === endpointId); return c ? c.costUsdPerPage / Math.max(1, c.page.observedRowsPerPage) : 0; };

interface Shape { id: string; labelAr: string; stages: (n: number) => StagePriceInput[]; countOf: (n: number) => number }
const SHAPES: ReadonlyArray<Shape> = [
  {
    id: "youtube-comments", labelAr: "تعليق يوتيوب",
    // a request for comments: the two videos' own search, the comments, and the replies that come with them (code-only: the model plans nothing for them)
    stages: (n) => [
      { rows: 2, costPerRowUsd: costPerRow("tikhub.x.youtube-web-search-channel"), deliver: true },
      { rows: n, costPerRowUsd: costPerRow("tikhub.youtube.video.comments"), deliver: true },
      { rows: Math.ceil(n * WALLET_REPLIES_SHARE), costPerRowUsd: costPerRow("anyapi.youtube.comment_replies"), deliver: true, codeOnly: true },
    ],
    countOf: (n) => n,
  },
  { id: "x-posts", labelAr: "منشور إكس", stages: (n) => [{ rows: n, costPerRowUsd: costPerRow("anyapi.x.search.posts"), deliver: true }], countOf: (n) => n },
];

/** The hold of a request of n rows; a request above the job's own cap is not an order at all (it is split into several), so it never fits. */
const holdOf = (shape: Shape, n: number): number => { const p = priceMissionByCode(shape.stages(n)); return p.overCap ? Number.POSITIVE_INFINITY : p.reservePoints; };

/** The largest n whose hold fits `points` (0 when even one does not). */
function largestFitting(shape: Shape, points: number): number {
  if (holdOf(shape, 1) > points) return 0;
  if (holdOf(shape, MAX_ROWS) <= points) return MAX_ROWS;
  let lo = 1;
  let hi = 2;
  while (hi < MAX_ROWS && holdOf(shape, hi) <= points) { lo = hi; hi *= 2; }
  hi = Math.min(hi, MAX_ROWS);
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (holdOf(shape, mid) <= points) lo = mid; else hi = mid; }
  return lo;
}

/** The smallest hold of any order, in points: the minimum order. */
export const minimumOrderPoints = (): number => Math.min(...SHAPES.map((s) => holdOf(s, 1)));

export function walletCapacityOf(balancePoints: number): WalletCapacity {
  const points = Math.max(0, Math.floor(balancePoints));
  const minimum = minimumOrderPoints();
  if (points < minimum) return { kind: "below_minimum", minimumPoints: minimum };
  const chips = SHAPES.map((s) => ({ id: s.id, labelAr: s.labelAr, records: s.countOf(largestFitting(s, points)) })).filter((c) => c.records > 0);
  return chips.length > 0 ? { kind: "ok", chips } : { kind: "below_minimum", minimumPoints: minimum };
}

/** What the wallet says under the balance. «حتى حوالي»: the real hold of a plan is computed from what its tools measure, and the plan card shows it before approval. */
export const BELOW_MINIMUM_AR = (minimumPoints: number): string => `رصيدك أقل من الحد الأدنى للطلب (${toArabicDigits(minimumPoints)} نقطة)؛ اشحن رصيدك لتبدأ طلبًا.`;
export const CAPACITY_HEAD_AR = "رصيدك يكفي لطلب واحد بحجم يصل إلى حوالي";
export const CAPACITY_NOTE_AR = "تقدير تقريبي؛ سعر طلبك الفعلي يظهر في خطته قبل أن تعتمد، ولا يُخصم إلا ما يُسلَّم.";
