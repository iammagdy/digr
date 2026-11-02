/**
 * THE PER-REQUEST-TYPE SWITCH of the redesign (docs/REDESIGN.md section 11, docs/REDESIGN-PLAN.md section 5). One mode per type, stored as one jsonb value in `agent_settings` under the key `redesign_flags`
 * (no table, no SQL). Modes: `off` (the old pipeline, byte for byte), `test` (the new pipeline for test accounts only), `on` (everyone). A missing, unknown or unreadable value is `off`: a broken setting can
 * never turn the new behaviour on. Pure: no I/O.
 */
export const REDESIGN_FLAGS_KEY = "redesign_flags";
export const REDESIGN_TYPES = ["social_posts", "social_account", "social_comments", "companies", "people", "places"] as const;
export type RedesignType = (typeof REDESIGN_TYPES)[number];
export const REDESIGN_MODES = ["off", "test", "on"] as const;
export type RedesignMode = (typeof REDESIGN_MODES)[number];
export type RedesignFlags = Record<RedesignType, RedesignMode>;

const isMode = (v: unknown): v is RedesignMode => typeof v === "string" && (REDESIGN_MODES as ReadonlyArray<string>).includes(v);
export const isRedesignType = (v: unknown): v is RedesignType => typeof v === "string" && (REDESIGN_TYPES as ReadonlyArray<string>).includes(v);

/** Every type, each `off` unless the value says `off`, `test` or `on` for it exactly. Anything else is `off`. */
export function normalizeRedesignFlags(raw: unknown): RedesignFlags {
  const out = Object.fromEntries(REDESIGN_TYPES.map((t) => [t, "off"])) as RedesignFlags;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const o = raw as Record<string, unknown>;
  for (const t of REDESIGN_TYPES) { const v = o[t]; if (isMode(v)) out[t] = v; }
  return out;
}

/** The flags out of the settings the worker read (`store.readSettings()`); an unreadable object reads as all off. */
export function readRedesignFlags(settings: Record<string, unknown> | null | undefined): RedesignFlags {
  try { return normalizeRedesignFlags(settings ? settings[REDESIGN_FLAGS_KEY] : undefined); } catch { return normalizeRedesignFlags(undefined); }
}

/** `on` for everyone, `test` for a test account only, `off` for nobody. */
export function redesignActive(flags: RedesignFlags, type: RedesignType, who: { isTest: boolean }): boolean {
  const mode = flags[type];
  return mode === "on" || (mode === "test" && who.isTest);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// PER-PLATFORM FLAGS (docs/ROOT-CAUSE.md, section 5.3). The five social platforms each have an optional mode, stored in the SAME `redesign_flags` value of `agent_settings` beside the six types (no table, no SQL), written by the same admin action with the same audit row. NO KEY means the
// platform follows its request type's value (the default: today's behaviour); a key overrides the type for a mission on that platform, in both directions. Pure: no I/O.
export const SOCIAL_PLATFORMS = ["tiktok", "x", "instagram", "facebook", "youtube"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];
export type PlatformFlags = Partial<Record<SocialPlatform, RedesignMode>>;
export const isSocialPlatform = (v: unknown): v is SocialPlatform => typeof v === "string" && (SOCIAL_PLATFORMS as ReadonlyArray<string>).includes(v);
/** The request types a platform key can switch: the three social ones. */
const SOCIAL_TYPES: ReadonlyArray<RedesignType> = ["social_posts", "social_account", "social_comments"];

/** The platform keys of the stored value: a valid platform with a valid mode is kept, everything else is ignored (an unreadable value is no override at all). */
export function readPlatformFlags(raw: unknown): PlatformFlags {
  const out: PlatformFlags = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const o = raw as Record<string, unknown>;
  for (const p of SOCIAL_PLATFORMS) { const v = o[p]; if (isMode(v)) out[p] = v; }
  return out;
}
/** The platform flags out of the settings the worker read (`store.readSettings()`). */
export function readPlatformFlagsOf(settings: Record<string, unknown> | null | undefined): PlatformFlags {
  try { return readPlatformFlags(settings ? settings[REDESIGN_FLAGS_KEY] : undefined); } catch { return {}; }
}

/** The mode that decides for a request type on a platform: the platform's own value when it has one (a social type only), else the type's. */
export function redesignActiveFor(flags: RedesignFlags, platformFlags: PlatformFlags, type: RedesignType, platform: SocialPlatform | null, who: { isTest: boolean }): boolean {
  if (platform !== null && SOCIAL_TYPES.includes(type)) {
    const own = platformFlags[platform];
    if (own !== undefined) return own === "on" || (own === "test" && who.isTest);
  }
  return redesignActive(flags, type, who);
}

/** The platform a plan is on, from the STRUCTURE of its stages: the capability the code stored, else the platform words of the tool's own id (never a title). The first stage that names one decides. */
export function platformOfStages(stages: ReadonlyArray<{ capability?: string; endpoint_id?: string }>): SocialPlatform | null {
  for (const st of stages) {
    const cap = typeof st.capability === "string" ? st.capability.split(".")[0] : "";
    if (isSocialPlatform(cap)) return cap;
    const id = String(st.endpoint_id ?? "").toLowerCase();
    if (!id) continue;
    if (id.includes("tiktok")) return "tiktok";
    if (id.includes("youtube")) return "youtube";
    if (id.includes("instagram")) return "instagram";
    if (id.includes("facebook")) return "facebook";
    // the `x` between a vendor and a job («tikhub.x.…») is a namespace marker, not the platform: X is a tweet search, an X user or an X post, or a twitter word
    if (id.includes("twitter") || /(?:^|\.)x\.(?:x\.)?(?:search|user|post|tweet|timeline)/.test(id)) return "x";
  }
  return null;
}
