/**
 * The ceilings that limit how large one job can grow, as configuration with the safe defaults the platform runs on today.
 *
 * Nothing here is a price, a points cap, a provider limit or a model setting: those stay where they are (JOB_MAX_POINTS_CAP,
 * the provider daily cap, the unit prices) and keep limiting every job whatever is set here. A ceiling raised here only lets a
 * job get as far as the frozen points cap lets it get; the rows beyond the cap are never requested, delivered or charged.
 *
 * Order of precedence: the test override (never in production) > the environment variable > the default. Every value is clamped to
 * its own [min, max], so a typo can neither switch a ceiling off nor set it to a number the worker cannot honour.
 */

export type ScaleKey = "absoluteMaxPages" | "largeJobPageAllowance" | "socialMaxRows" | "maxPerVideo" | "maxVideosPerJob";

interface ScaleSpec {
  env: string;
  /** What the platform runs on today. */
  def: number;
  min: number;
  max: number;
  /** One line for the owner: what the ceiling is. */
  whatAr: string;
}

export const SCALE_SPECS: Record<ScaleKey, ScaleSpec> = {
  // Provider pages (chunks) one job may read; with a page of 50 rows this is the real limit of a feed job (30 x 50 = 1,500 rows).
  absoluteMaxPages: { env: "LONG_JOB_MAX_PAGES", def: 30, min: 1, max: 2000, whatAr: "أكبر عدد من الدفعات لمهمة واحدة" },
  // How many pages a large job may read per page it would need if every record matched (relevance misses use the slack).
  largeJobPageAllowance: { env: "LONG_JOB_PAGE_ALLOWANCE", def: 3, min: 1, max: 10, whatAr: "هامش الدفعات الإضافية" },
  // Most rows one social plan item may ask for. 0 = the per-service defaults (500 or 1,000). Only comment and big post services rise.
  socialMaxRows: { env: "LONG_JOB_SOCIAL_MAX_ROWS", def: 0, min: 0, max: 100_000, whatAr: "أكبر عدد سجلات لبند اجتماعي واحد" },
  // Most comments taken from one video, and most videos one job reads.
  maxPerVideo: { env: "LONG_JOB_MAX_PER_VIDEO", def: 500, min: 1, max: 5000, whatAr: "أكبر عدد تعليقات من فيديو واحد" },
  maxVideosPerJob: { env: "LONG_JOB_MAX_VIDEOS", def: 20, min: 1, max: 200, whatAr: "أكبر عدد فيديوهات لمهمة واحدة" },
};

let testOverrides: Partial<Record<ScaleKey, number>> | null = null;

/** Test hook only: ignored when NODE_ENV is production. Pass null to clear. */
export function setScaleOverridesForTesting(overrides: Partial<Record<ScaleKey, number>> | null): void {
  testOverrides = overrides;
}

export function scaleValue(key: ScaleKey, env: Record<string, string | undefined> = process.env): number {
  const spec = SCALE_SPECS[key];
  const clamp = (n: number) => Math.min(spec.max, Math.max(spec.min, Math.floor(n)));
  const override = env.NODE_ENV === "production" ? undefined : testOverrides?.[key];
  if (typeof override === "number" && Number.isFinite(override)) return clamp(override);
  const raw = String(env[spec.env] ?? "").trim();
  if (raw !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return clamp(parsed);
  }
  return spec.def;
}

/** The effective row ceiling of a social service: raised by LONG_JOB_SOCIAL_MAX_ROWS only for the services that can serve it. */
export function effectiveSocialMaxRows(defaultMaxRows: number, kind: string, env: Record<string, string | undefined> = process.env): number {
  const raised = scaleValue("socialMaxRows", env);
  const raisable = kind === "comments" || (kind === "posts" && defaultMaxRows >= 500);
  return raised > 0 && raisable ? Math.max(defaultMaxRows, raised) : defaultMaxRows;
}
