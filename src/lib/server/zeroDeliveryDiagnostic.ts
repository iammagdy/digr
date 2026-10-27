import { toArabicDigits } from "../arabicDigits";
import { maskSensitive, rejectionReasonCode, type RejectedReasonCode } from "./rejectedRowSample";

/**
 * Why a job ended with nothing delivered. The worker adds up, chunk by chunk, what the post selection and the relevance gate did, and a job that
 * ends with zero accepted records says it in ONE customer line (counts per reason, Arabic, no names of sources, no amounts, no ids). A small
 * sample of the texts that were turned away (at most five posts and five rows, cut short, links and numbers masked) is kept for the owner in the
 * job's private storage; it is read from an admin route only and never reaches a customer response.
 */
export const DIAGNOSTIC_SAMPLE_LIMIT = 5;
export const DIAGNOSTIC_TEXT_CHARS = 140;
export const DIAGNOSTIC_FILE = "diagnostic.json";

export interface DiagnosticSample { text: string; reasonAr: string }

export interface JobDiagnostic {
  v: 1;
  posts: { judged: number; adopted: number; excluded: number; held: number; unreviewed: number };
  rows: { received: number; outsideWindow: number; accepted: number; excluded: number; held: number; unreviewed: number; byReason: Partial<Record<RejectedReasonCode, number>> };
  /** Facebook keyword service: the posts whose comments were asked for and how many gave fewer than asked (see `ProviderAdapterCallOutput.postReads`). */
  postReads: { read: number; sourceShort: number; sourceMissing: number; filteredShort: number; asked: number };
  samples: { posts: DiagnosticSample[]; rows: DiagnosticSample[] };
}

export const emptyDiagnostic = (): JobDiagnostic => ({
  v: 1,
  posts: { judged: 0, adopted: 0, excluded: 0, held: 0, unreviewed: 0 },
  rows: { received: 0, outsideWindow: 0, accepted: 0, excluded: 0, held: 0, unreviewed: 0, byReason: {} },
  postReads: { read: 0, sourceShort: 0, sourceMissing: 0, filteredShort: 0, asked: 0 },
  samples: { posts: [], rows: [] },
});

const count = (value: unknown): number => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : 0);

const TEXT_KEYS = ["text", "comment_text", "message", "post_text", "title", "video_title", "caption", "description"];
const clipText = (value: unknown): string => maskSensitive(String(value ?? "").replace(/\s+/g, " ").trim()).slice(0, DIAGNOSTIC_TEXT_CHARS);
const textOfRow = (row: Record<string, any>): string => {
  const key = TEXT_KEYS.find((candidate) => typeof row?.[candidate] === "string" && row[candidate].trim());
  return key ? clipText(row[key]) : "";
};

function addSample(list: DiagnosticSample[], text: string, reasonAr: string) {
  if (!text || list.length >= DIAGNOSTIC_SAMPLE_LIMIT) return;
  list.push({ text, reasonAr: clipText(reasonAr).slice(0, 120) });
}

/** The posts the selection judged on this chunk. A post turned away adds a sample (its own words, cut short). */
export function recordPostJudgements(d: JobDiagnostic, items: Array<{ text: string; decision: "match" | "no_match" | "uncertain"; by: "evidence" | "review" | "unreviewed"; reasonAr: string }>): JobDiagnostic {
  for (const item of items) {
    d.posts.judged += 1;
    if (item.decision === "match") d.posts.adopted += 1;
    else if (item.decision === "no_match") { d.posts.excluded += 1; addSample(d.samples.posts, clipText(item.text), item.reasonAr); }
    else if (item.by === "unreviewed") d.posts.unreviewed += 1;
    else d.posts.held += 1;
  }
  return d;
}

/** What the relevance gate did with the rows of this chunk. The rows it turned away are counted by reason and sampled. */
export function recordRowGate(d: JobDiagnostic, input: { received: number; outsideWindow: number; accepted: number; excluded: Array<Record<string, any>>; held: number; unreviewed: number }): JobDiagnostic {
  d.rows.received += count(input.received);
  d.rows.outsideWindow += count(input.outsideWindow);
  d.rows.accepted += count(input.accepted);
  d.rows.held += count(input.held);
  d.rows.unreviewed += count(input.unreviewed);
  for (const row of input.excluded) {
    const reasonAr = String(row?._relevance_reason || "غير مطابق");
    const code = rejectionReasonCode(reasonAr);
    d.rows.excluded += 1;
    d.rows.byReason[code] = (d.rows.byReason[code] ?? 0) + 1;
    addSample(d.samples.rows, textOfRow(row), reasonAr);
  }
  return d;
}

export function mergeDiagnostic(a: JobDiagnostic | null | undefined, b: JobDiagnostic): JobDiagnostic {
  const out = emptyDiagnostic();
  for (const source of [a, b]) {
    if (!source || source.v !== 1) continue;
    for (const key of Object.keys(out.posts) as Array<keyof JobDiagnostic["posts"]>) out.posts[key] += count(source.posts?.[key]);
    for (const key of ["received", "outsideWindow", "accepted", "excluded", "held", "unreviewed"] as const) out.rows[key] += count(source.rows?.[key]);
    out.postReads.read += count(source.postReads?.read);
    out.postReads.sourceShort += count(source.postReads?.sourceShort);
    out.postReads.sourceMissing += count(source.postReads?.sourceMissing);
    out.postReads.filteredShort += count(source.postReads?.filteredShort);
    out.postReads.asked = Math.max(out.postReads.asked, count(source.postReads?.asked));
    for (const [code, n] of Object.entries(source.rows?.byReason ?? {})) out.rows.byReason[code as RejectedReasonCode] = (out.rows.byReason[code as RejectedReasonCode] ?? 0) + count(n);
    for (const sample of source.samples?.posts ?? []) addSample(out.samples.posts, sample.text, sample.reasonAr);
    for (const sample of source.samples?.rows ?? []) addSample(out.samples.rows, sample.text, sample.reasonAr);
  }
  return out;
}

/** Adds what the adapter counted while it read the posts of this chunk. */
export function recordPostReads(d: JobDiagnostic, reads: { read: number; sourceShort: number; sourceMissing?: number; filteredShort: number; asked: number } | null | undefined): JobDiagnostic {
  if (!reads) return d;
  d.postReads.read += count(reads.read);
  d.postReads.sourceShort += count(reads.sourceShort);
  d.postReads.sourceMissing += count(reads.sourceMissing);
  d.postReads.filteredShort += count(reads.filteredShort);
  d.postReads.asked = Math.max(d.postReads.asked, count(reads.asked));
  return d;
}

/**
 * The sentence of an X ACCOUNT job that ends with nothing delivered. The request names an account, not a topic, so it never says «موضوع طلبك»: what was not
 * confirmed is that a record is a post written by the account itself. Counts are the job's totals; Arabic-Indic digits; nothing is charged.
 */
export function xAccountZeroDeliveryAr(input: { received: number; held: number; dateDropped: number }): string {
  const received = toArabicDigits(count(input.received));
  const held = count(input.held);
  const dropped = count(input.dateDropped);
  const heldText = held ? ` (أُحيل ${toArabicDigits(held)} إلى المراجعة ولم يُحتسب)` : "";
  const unconfirmed = "لم يتأكد لنا أن أيًّا منها منشور كتبه الحساب نفسه";
  const inside = Math.max(0, count(input.received) - dropped);
  const part = dropped > 0
    ? `استلمنا ${received} سجلاً من الحساب المطلوب، استُبعد منها ${toArabicDigits(dropped)} لأن تاريخها خارج الفترة التي حددتها أو بلا تاريخ نشر يمكن التحقق منه، وبقي ${toArabicDigits(inside)} داخل الفترة لكن ${unconfirmed}`
    : `استلمنا ${received} سجلاً من الحساب المطلوب، لكن ${unconfirmed}`;
  return `${part}${heldText}؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد.`;
}

/** The records held for review that a customer sentence says: the job's total over every page (never only the last page), and never fewer than the last page held. */
export const heldToReport = (total: JobDiagnostic | null | undefined, lastPageHeld: number): number => Math.max(count(lastPageHeld), count(total?.rows?.held));

export const hasDiagnosticSignal = (d: JobDiagnostic): boolean => d.postReads.read > 0 || d.posts.judged > 0 || d.rows.received > 0 || d.rows.excluded > 0 || d.rows.held > 0 || d.rows.unreviewed > 0;

const REASON_LABEL_AR: Record<RejectedReasonCode, string> = {
  topic_not_in_text: "لا تذكر موضوع بحثك",
  out_of_region: "خارج الدولة المطلوبة",
  no_text: "بلا نص يمكن قراءته",
  well_wish: "دعاء أو مجاملة بلا مضمون",
  industry_mismatch: "من مجال مختلف",
  other_mismatch: "لأسباب أخرى",
};

const recordsAr = (n: number): string => (n === 1 ? "سجل واحد" : n === 2 ? "سجلين" : n >= 3 && n <= 10 ? `${toArabicDigits(n)} سجلات` : `${toArabicDigits(n)} سجلًا`);
const postsAr = (n: number): string => (n === 1 ? "منشور واحد" : n === 2 ? "منشورين" : n >= 3 && n <= 10 ? `${toArabicDigits(n)} منشورات` : `${toArabicDigits(n)} منشورًا`);

/**
 * The one customer line of a job that ended with zero accepted records: what was judged and why each part was turned away or held. Counts only,
 * Arabic-Indic digits, nothing that names a source or an amount. Null when there is nothing to say.
 */
export function zeroDeliveryEventAr(d: JobDiagnostic): string | null {
  if (!hasDiagnosticSignal(d)) return null;
  const parts: string[] = [];
  if (d.posts.judged > 0) {
    const post = [`اعتمدنا ${toArabicDigits(d.posts.adopted)}`];
    if (d.posts.excluded > 0) post.push(`واستبعدنا ${toArabicDigits(d.posts.excluded)} لأنها لا تتناول موضوعك`);
    if (d.posts.held > 0) post.push(`وأحلنا ${toArabicDigits(d.posts.held)} إلى المراجعة`);
    if (d.posts.unreviewed > 0) post.push(`وتعذّر التحقق من ${toArabicDigits(d.posts.unreviewed)}`);
    parts.push(`راجعنا ${postsAr(d.posts.judged)}: ${post.join("، ")}`);
  }
  if (d.rows.received > 0 || d.rows.excluded > 0 || d.rows.held > 0) {
    const examined = Math.max(d.rows.received - d.rows.outsideWindow, d.rows.accepted + d.rows.excluded + d.rows.held + d.rows.unreviewed);
    const row = [`قُبل ${toArabicDigits(d.rows.accepted)}`];
    if (d.rows.excluded > 0) {
      const reasons = (Object.entries(d.rows.byReason) as Array<[RejectedReasonCode, number]>)
        .filter(([, n]) => n > 0)
        .sort((x, y) => y[1] - x[1])
        .map(([code, n]) => `${toArabicDigits(n)} ${REASON_LABEL_AR[code]}`);
      row.push(`واستُبعد ${toArabicDigits(d.rows.excluded)}${reasons.length ? ` (${reasons.join("، ")})` : ""}`);
    }
    if (d.rows.held > 0) row.push(`وأُحيل ${toArabicDigits(d.rows.held)} إلى المراجعة ولم يُحتسب`);
    if (d.rows.unreviewed > 0) row.push(`ولم يبلغ التحقق ${toArabicDigits(d.rows.unreviewed)}`);
    if (d.rows.outsideWindow > 0) row.push(`وخرج ${toArabicDigits(d.rows.outsideWindow)} عن الفترة المطلوبة`);
    parts.push(`فحصنا ${recordsAr(examined)}: ${row.join("، ")}`);
  }
  if (parts.length === 0) return null;
  return `لم يُسلَّم شيء، وهذا ما حدث: ${parts.join(". ثم ")}.`;
}

const commentsAr = (n: number): string => (n === 1 ? "تعليق واحد" : n === 2 ? "تعليقين" : n >= 3 && n <= 10 ? `${toArabicDigits(n)} تعليقات` : `${toArabicDigits(n)} تعليقًا`);

/**
 * Why a Facebook keyword job delivered fewer comments than asked, in ONE sentence made only of what was counted: the posts whose comments were read, how many of them
 * returned fewer comments than asked, how many returned enough but fewer were kept (empty or link-only comments are the only ones left out). Arabic-Indic digits, no source name,
 * no amount. Null when nothing was counted (the caller then keeps its own sentence).
 */
export function keywordShortfallReasonAr(d: JobDiagnostic, options: { postsRequested?: number; postsDelivered?: number } = {}): string | null {
  const reads = d.postReads;
  if (reads.read <= 0) return null;
  const asked = reads.asked > 0 ? reads.asked : null;
  const parts: string[] = [];
  // the posts the review approved are not all read: a job reads the number of posts the customer asked for
  if (d.posts.adopted > 0) parts.push(`اعتمدنا ${postsAr(d.posts.adopted)}`);
  parts.push(`قرأنا تعليقات ${postsAr(reads.read)}`);
  // Said with both numbers, so the customer sees what was asked and what was read: the job reads the posts the customer asked for, not all approved ones.
  if (d.posts.adopted > reads.read && options.postsRequested && options.postsRequested > 0) parts.push(`ولم تُقرأ تعليقات بقية المنشورات المعتمدة؛ طلبت ${postsAr(options.postsRequested)}، وقرأنا تعليقات ${postsAr(reads.read)} منها`);
  if (reads.sourceShort > 0) parts.push(`${toArabicDigits(reads.sourceShort)} منها أعاد المصدر لها تعليقات أقل من المطلوب${asked ? ` (${toArabicDigits(asked)} لكل منشور)` : ""}`);
  if (reads.sourceMissing > 0) parts.push(`ونقص ما أعاده المصدر ${commentsAr(reads.sourceMissing)} عن المطلوب`);
  if (reads.filteredShort > 0) parts.push(`${toArabicDigits(reads.filteredShort)} منها لم يكن فيها العدد المطلوب من التعليقات الصالحة بعد استبعاد التعليقات الفارغة وتعليقات الروابط والمكرر`);
  if (options.postsDelivered !== undefined && reads.read > options.postsDelivered) parts.push(`ولم يُسلَّم أي تعليق من ${postsAr(reads.read - options.postsDelivered)} منها`);
  // Comments are delivered as they are: only an empty comment or a link on its own is left out.
  if (d.rows.excluded > 0) parts.push(`واستُبعد ${commentsAr(d.rows.excluded)} (فارغ أو رابط فقط)`);
  return `${parts.join("؛ ")}؛ ولم يُحتسب عليك إلا ما سُلّم.`;
}

// Storage (best effort: the diagnostic is for reading later and must never change what a job delivers or charges).
type PartialsStore = { download?: (path: string) => Promise<{ data?: any; error?: any }>; upload: (path: string, body: any, options?: any) => Promise<any> };

/** One entry per chunk (step), so a chunk that dies and runs again replaces its own entry instead of being counted twice. */
export interface DiagnosticFile { v: 1; steps: Record<string, JobDiagnostic> }

export async function readDiagnosticFile(store: PartialsStore, jobId: string): Promise<DiagnosticFile> {
  try {
    if (typeof store.download !== "function") return { v: 1, steps: {} };
    const { data: blob } = await store.download(`${jobId}/${DIAGNOSTIC_FILE}`);
    if (!blob) return { v: 1, steps: {} };
    const parsed = JSON.parse(typeof blob.text === "function" ? await blob.text() : String(blob));
    return parsed?.v === 1 && parsed.steps && typeof parsed.steps === "object" ? (parsed as DiagnosticFile) : { v: 1, steps: {} };
  } catch {
    return { v: 1, steps: {} };
  }
}

/** The whole job's figures: every chunk's entry added up, in step order. */
export const totalDiagnostic = (file: DiagnosticFile): JobDiagnostic =>
  Object.keys(file.steps).sort((a, b) => Number(a) - Number(b)).reduce<JobDiagnostic>((total, step) => mergeDiagnostic(total, file.steps[step]), emptyDiagnostic());

/** Stores this chunk's entry and returns the job's total so far. Never throws. */
export async function saveStepDiagnostic(store: PartialsStore, jobId: string, step: number, d: JobDiagnostic): Promise<JobDiagnostic> {
  const file = await readDiagnosticFile(store, jobId);
  file.steps[String(step)] = d;
  try {
    await store.upload(`${jobId}/${DIAGNOSTIC_FILE}`, Buffer.from(JSON.stringify(file), "utf-8"), { contentType: "application/json", upsert: true });
  } catch {
    // best effort
  }
  return totalDiagnostic(file);
}
