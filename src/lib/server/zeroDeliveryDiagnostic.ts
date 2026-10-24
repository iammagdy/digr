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
  samples: { posts: DiagnosticSample[]; rows: DiagnosticSample[] };
}

export const emptyDiagnostic = (): JobDiagnostic => ({
  v: 1,
  posts: { judged: 0, adopted: 0, excluded: 0, held: 0, unreviewed: 0 },
  rows: { received: 0, outsideWindow: 0, accepted: 0, excluded: 0, held: 0, unreviewed: 0, byReason: {} },
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
    for (const [code, n] of Object.entries(source.rows?.byReason ?? {})) out.rows.byReason[code as RejectedReasonCode] = (out.rows.byReason[code as RejectedReasonCode] ?? 0) + count(n);
    for (const sample of source.samples?.posts ?? []) addSample(out.samples.posts, sample.text, sample.reasonAr);
    for (const sample of source.samples?.rows ?? []) addSample(out.samples.rows, sample.text, sample.reasonAr);
  }
  return out;
}

export const hasDiagnosticSignal = (d: JobDiagnostic): boolean => d.posts.judged > 0 || d.rows.received > 0 || d.rows.excluded > 0 || d.rows.held > 0 || d.rows.unreviewed > 0;

const REASON_LABEL_AR: Record<RejectedReasonCode, string> = {
  topic_not_in_text: "لا تذكر موضوع بحثك",
  out_of_region: "خارج الدولة المطلوبة",
  no_text: "بلا نص يمكن قراءته",
  industry_mismatch: "من مجال مختلف",
  other_mismatch: "لأسباب أخرى",
};

const recordsAr = (n: number): string => (n === 1 ? "سجل واحد" : n === 2 ? "سجلان" : n >= 3 && n <= 10 ? `${toArabicDigits(n)} سجلات` : `${toArabicDigits(n)} سجلًا`);
const postsAr = (n: number): string => (n === 1 ? "منشور واحد" : n === 2 ? "منشوران" : n >= 3 && n <= 10 ? `${toArabicDigits(n)} منشورات` : `${toArabicDigits(n)} منشورًا`);

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
