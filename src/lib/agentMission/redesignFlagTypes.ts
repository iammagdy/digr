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
