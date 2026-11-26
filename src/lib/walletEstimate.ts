import { priceMissionByCode, type StagePriceInput } from "./agentMission/price";
import { toArabicDigits } from "./arabicDigits";
import { AGENT_MAX_DELIVERED_ROWS } from "./agentMission/constants";
// pure numeric snapshot generated from treg_catalog_sellable.json + treg.walletEstimateSlots: browser-safe, zero provider tokens or endpoint IDs
import walletCosts from "../../data/treg/wallet_estimate_costs.json";

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

function positiveCost(key: keyof typeof walletCosts): number {
  const v = walletCosts[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new Error(`Invalid wallet_estimate_costs.json.${key}`);
  }
  return v;
}

const DISCOVERY_USD_PER_ROW = positiveCost("discoveryUsdPerRow");
const COMMENTS_USD_PER_ROW = positiveCost("commentsUsdPerRow");
const REPLIES_USD_PER_ROW = positiveCost("repliesUsdPerRow");
const POSTS_USD_PER_ROW = positiveCost("postsUsdPerRow");

interface Shape { id: string; labelAr: string; stages: (n: number) => StagePriceInput[]; countOf: (n: number) => number }
const SHAPES: ReadonlyArray<Shape> = [
  {
    id: "youtube-comments", labelAr: "تعليق يوتيوب",
    // a request for comments: the two videos' own search, the comments, and the replies that come with them (code-only: the model plans nothing for them)
    stages: (n) => [
      { rows: 2, costPerRowUsd: DISCOVERY_USD_PER_ROW, deliver: true },
      { rows: n, costPerRowUsd: COMMENTS_USD_PER_ROW, deliver: true },
      { rows: Math.ceil(n * WALLET_REPLIES_SHARE), costPerRowUsd: REPLIES_USD_PER_ROW, deliver: true, codeOnly: true },
    ],
    countOf: (n) => n,
  },
  { id: "x-posts", labelAr: "منشور إكس", stages: (n) => [{ rows: n, costPerRowUsd: POSTS_USD_PER_ROW, deliver: true }], countOf: (n) => n },
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
