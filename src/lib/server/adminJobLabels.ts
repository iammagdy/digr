import { capabilityById } from "../multiProvider/catalog";
import { CHAIN_CAPABILITY_SLUG } from "../multiProvider/routes";
import { getSocialCapability } from "../socialSources";
import { SOCIAL_PLATFORM_LABEL_AR } from "../socialTasks";

/**
 * ADMIN ONLY, READ ONLY. Arabic labels for the owner's call logs: what a provider call was for, and a short label of the job behind it.
 * Nothing here reaches a customer route (a test walks the customer files and fails on an import of this module), and nothing here writes.
 *
 * Two jobs:
 *  1. `adminCapabilityLabelAr`: the label of a capability id that a call row carries (a TREG capability slug, a data-provider id such as
 *     `firecrawl.scrape`). The worker stores the slug; the screens turn it into Arabic here.
 *  2. `deriveJobLabelAr`: for OLD rows (written before a call carried its own metadata) and for every row's «المهمة» column, a short label read
 *     from the job (its capability, its parameters), the plan card text and the conversation title. Nothing is invented: it returns null when
 *     nothing can be read, and the screen then says «غير مسجّل (قبل التحديث)».
 */
export const NOT_RECORDED_AR = "غير مسجّل (قبل التحديث)";

const MAX_TOPIC_CHARS = 40;
const MAX_LABEL_CHARS = 70;

const COMPANIES_RE = /compan|b2b|icypeas.*compan/i;
const PEOPLE_RE = /people|decision|lead|contact/i;

/** The Arabic admin label of a capability id or slug, or null for an empty value. An unknown id is shown as itself, never hidden. */
export function adminCapabilityLabelAr(id: unknown): string | null {
  if (typeof id !== "string" || !id.trim()) return null;
  const value = id.trim();
  const catalog = capabilityById(value);
  if (catalog) return catalog.labelAr;
  const social = getSocialCapability(value);
  if (social) return `${social.nameAr} (TREG)`;
  const lower = value.toLowerCase();
  if (lower === CHAIN_CAPABILITY_SLUG) return "بيانات تواصل الشركات (عدة مزودين)";
  if (PEOPLE_RE.test(lower) && !COMPANIES_RE.test(lower)) return "صناع القرار (TREG)";
  if (COMPANIES_RE.test(lower)) return "دليل الشركات (TREG)";
  return value;
}

const cleanText = (value: unknown): string =>
  String(value ?? "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[#*_`>~|\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const clip = (value: string, max: number): string => (value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`);

function parseParams(raw: unknown): Record<string, any> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, any>;
  if (typeof raw === "string" && raw.trim().startsWith("{")) {
    try { const parsed = JSON.parse(raw); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
  }
  return {};
}

const firstString = (...values: unknown[]): string => {
  for (const v of values) {
    const item = Array.isArray(v) ? v.find((x) => typeof x === "string" && x.trim()) : v;
    if (typeof item === "string" && cleanText(item)) return cleanText(item);
  }
  return "";
};

/** What the job is about, from its own parameters: the topic, a channel or account, or the sector with its place. */
export function jobTopicFromParams(params: Record<string, any>): string {
  const topic = firstString(params.query, params.keyword, params.topic, params.hashtag, params.channels, params.channel, params.username, params.handle, params.account);
  if (topic) return clip(topic.replace(/^@/, "@"), MAX_TOPIC_CHARS);
  const place = firstString(params.city, params.region, params.country);
  const sector = firstString(params.industry, params.sector);
  return clip([sector, place].filter(Boolean).join(" — "), MAX_TOPIC_CHARS);
}

const SOCIAL_KIND_AR = { comments: "تعليقات", videos: "فيديوهات", posts: "منشورات" } as const;

function jobTypeLabelAr(slug: string): string | null {
  if (!slug) return null;
  const social = getSocialCapability(slug);
  if (social) {
    // The word comes from the slug (social-facebook-posts is catalogued with the kind «videos»), the platform from the capability.
    const kind = /-posts$/.test(slug) ? "posts" : /-comments$/.test(slug) ? "comments" : social.kind;
    return `${SOCIAL_KIND_AR[kind]} ${SOCIAL_PLATFORM_LABEL_AR[social.platform]}`;
  }
  const label = adminCapabilityLabelAr(slug);
  if (!label || label === slug) return null;
  return label.replace(/\s*\((?:TREG|Firecrawl|Context\.dev)\)\s*$/, "").replace(/\s*\(عدة مزودين\)\s*$/, "").trim() || null;
}

export interface JobLabelSources {
  /** A row of `jobs` (snake or camel case, whatever the table carries). */
  job?: Record<string, any> | null;
  /** The plan card row the job was accepted from, when one is found. */
  quote?: Record<string, any> | null;
  conversationTitle?: string | null;
}

/** The slug the job ran, from the job row first and the plan items second. */
export function jobSlugOf(sources: JobLabelSources): string {
  const job = sources.job ?? {};
  const fromJob = firstString(job.template_slug, job.templateSlug, job.capability_slug, job.capabilitySlug, job.endpoint_id, job.endpointId);
  if (fromJob) return fromJob;
  const items = Array.isArray(sources.quote?.items) ? sources.quote!.items : [];
  return firstString(items[0]?.capabilitySlug, items[0]?.capability_slug, items[0]?.endpointId);
}

/** A short Arabic label of the job, e.g. «تعليقات تيك توك — كرة السلة», or null when nothing can be read. */
export function deriveJobLabelAr(sources: JobLabelSources): string | null {
  const job = sources.job ?? {};
  const quote = sources.quote ?? {};
  const items = Array.isArray(quote.items) ? quote.items : [];
  const params = { ...parseParams(items[0]?.params), ...parseParams(job.params) };
  const type = jobTypeLabelAr(jobSlugOf(sources));
  const topic = jobTopicFromParams(params);
  const parts = [type, topic].filter((p): p is string => Boolean(p));
  if (parts.length === 2) return clip(parts.join(" — "), MAX_LABEL_CHARS);
  const summary = cleanText(quote.summary_ar ?? quote.summaryAr);
  if (summary) return clip(summary, MAX_LABEL_CHARS);
  const title = cleanText(sources.conversationTitle);
  if (parts.length === 1 && title && !title.includes(parts[0])) return clip(`${parts[0]} — ${title}`, MAX_LABEL_CHARS);
  if (parts.length === 1) return clip(parts[0], MAX_LABEL_CHARS);
  return title ? clip(title, MAX_LABEL_CHARS) : null;
}

export type DerivedCallStatus = "success" | "failed" | "empty";

/**
 * The status of an OLD row, only where the row itself settles it: a committed row that returned units was a success. A committed row with no
 * units could be a failed or an empty call, so it stays unknown (never guessed), and so does an uncommitted estimate.
 */
export function deriveStatusFromRow(row: { units: number; isEstimate: boolean }): DerivedCallStatus | null {
  return !row.isEstimate && row.units > 0 ? "success" : null;
}

/** The admin page of a job (the jobs screen opened on that one job). */
export const adminJobHref = (jobId: string): string => `/admin/jobs?job=${encodeURIComponent(jobId)}`;
