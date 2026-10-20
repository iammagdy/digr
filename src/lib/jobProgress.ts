import { formatAr } from "./arabicDigits";
import { durationRangeAr } from "./missionDuration";
import { etaTextAr } from "./jobEta";

/**
 * Live progress of a running job, from the REAL chunks it has finished: «تم ١٢٬٠٠٠ من ٥٠٬٠٠٠ · المتبقي حوالي …».
 * The remaining time is the number of chunks still needed (records left over the records a chunk really delivered lately) times the
 * rolling average of the last real chunk times. It is recomputed at every chunk, widens honestly when the provider slows down or the
 * job is waiting to retry, and says nothing until a few chunks have run (no fake precision). It reads counts and times only.
 */
export const ROLLING_CHUNKS = 8;
export const MIN_CHUNKS_FOR_ETA = 3;
/** A gap longer than this is a stall or a closed page, not the cost of a chunk. */
export const IDLE_GAP_MS = 30 * 60 * 1000;
/** Allowance for building the files after the last chunk. */
const ASSEMBLY_SECONDS = { optimistic: 10, pessimistic: 45 };

/** The cumulative delivered count when a chunk ended (the «الصفحة N» line of a job writes it with its units). */
export interface ChunkMark {
  at: number;
  units: number;
}

export interface JobEventRowLike {
  message?: string | null;
  units?: number | null;
  created_at?: string | null;
}

/** The chunk marks of a job from its progress events (only the «الصفحة …» lines are chunk ends). */
export function chunkMarksFromEvents(rows: readonly JobEventRowLike[]): ChunkMark[] {
  const marks: ChunkMark[] = [];
  for (const row of rows) {
    if (typeof row?.message !== "string" || !/^الصفحة\s/u.test(row.message)) continue;
    const at = Date.parse(String(row.created_at || ""));
    const units = Number(row.units);
    if (!Number.isFinite(at) || !Number.isFinite(units)) continue;
    marks.push({ at, units });
  }
  return marks.sort((a, b) => a.at - b.at);
}

export interface JobProgressInput {
  delivered: number;
  target: number;
  marks: readonly ChunkMark[];
  /** When the job started, to count the first chunk. */
  startedAt?: number;
  /** The job is waiting to retry (a backoff is active, or attempts were already spent). */
  retrying?: boolean;
}

export interface JobProgress {
  deliveredAr: string;
  targetAr: string;
  /** «تم ١٢٬٠٠٠ من ٥٠٬٠٠٠ · المتبقي حوالي ٢٠ دقيقة» */
  lineAr: string;
  /** The remaining time alone, or null while there are too few chunks to say. */
  remainingAr: string | null;
  optimisticSeconds: number | null;
  pessimisticSeconds: number | null;
  /** True when the range was widened because the chunks are slowing down or the job is retrying. */
  widened: boolean;
  chunksSeen: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function p90(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.9 * sorted.length) - 1)];
}
const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length);

export function computeJobProgress(input: JobProgressInput): JobProgress {
  const target = Math.max(0, Math.floor(input.target));
  const delivered = Math.max(0, Math.min(Math.floor(input.delivered), target || Math.floor(input.delivered)));
  const base = { deliveredAr: formatAr(delivered), targetAr: formatAr(target) };
  const head = `تم ${base.deliveredAr} من ${base.targetAr}`;

  const marks = [...input.marks].sort((a, b) => a.at - b.at);
  const all: ChunkMark[] = Number.isFinite(input.startedAt) ? [{ at: input.startedAt as number, units: 0 }, ...marks] : marks;
  const gaps: number[] = [];
  const gains: number[] = [];
  for (let i = 1; i < all.length; i++) {
    const gap = (all[i].at - all[i - 1].at) / 1000;
    if (gap > 0 && gap * 1000 <= IDLE_GAP_MS) {
      gaps.push(gap);
      gains.push(Math.max(0, all[i].units - all[i - 1].units));
    }
  }
  const recentGaps = gaps.slice(-ROLLING_CHUNKS);
  const recentGains = gains.slice(-ROLLING_CHUNKS);
  const chunksSeen = recentGaps.length;

  const remaining = Math.max(0, target - delivered);
  if (target > 0 && remaining === 0) {
    return { ...base, lineAr: `${head} · اكتمل الجمع، وجارٍ تجهيز الملفات`, remainingAr: null, optimisticSeconds: null, pessimisticSeconds: null, widened: false, chunksSeen };
  }
  const avgGain = mean(recentGains);
  if (chunksSeen < MIN_CHUNKS_FOR_ETA || !(avgGain > 0) || target <= 0) {
    return { ...base, lineAr: `${head} · نحسب الوقت المتبقي بعد بضع دفعات`, remainingAr: null, optimisticSeconds: null, pessimisticSeconds: null, widened: false, chunksSeen };
  }

  const chunksLeft = Math.ceil(remaining / avgGain);
  let slowdown = 1;
  if (recentGaps.length >= 6) {
    const earlier = mean(recentGaps.slice(0, recentGaps.length - 3));
    const lately = mean(recentGaps.slice(-3));
    if (earlier > 0 && lately > 1.5 * earlier) slowdown += 0.25;
  }
  if (input.retrying) slowdown += 0.25;
  const optimistic = chunksLeft * median(recentGaps) + ASSEMBLY_SECONDS.optimistic;
  const pessimistic = chunksLeft * Math.max(p90(recentGaps), mean(recentGaps)) * slowdown + ASSEMBLY_SECONDS.pessimistic;
  const optimisticSeconds = Math.round(optimistic);
  const pessimisticSeconds = Math.round(Math.max(pessimistic, optimistic));
  const widened = slowdown > 1;

  let remainingAr: string;
  if (pessimisticSeconds < 60) remainingAr = "أقل من دقيقة";
  else if (pessimisticSeconds <= optimisticSeconds * 1.35 && !widened) remainingAr = etaTextAr(Math.round((optimisticSeconds + pessimisticSeconds) / 2)) || durationRangeAr(optimisticSeconds, pessimisticSeconds);
  else remainingAr = durationRangeAr(optimisticSeconds, pessimisticSeconds);
  return { ...base, lineAr: `${head} · المتبقي ${remainingAr}`, remainingAr, optimisticSeconds, pessimisticSeconds, widened, chunksSeen };
}
