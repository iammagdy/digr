import { contractTypeOf, type ContractStageLike } from "./taskContracts";

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

export type BuiltBy = "code" | "model";

/**
 * THE STAGE 1 ORDERING GATE (docs/REDESIGN-PLAN.md section 4.3): raw delivery is effective only when the type's flag is active for this account AND the stored recipe was BUILT BY CODE from the tool's own fields
 * (`built_by === "code"`, set when the request is built by code). A recipe the model wrote never runs raw, whatever the flag says: raw delivery of an under-specified request would deliver everything the source returns.
 */
export function rawDeliveryEffective(input: { flags: RedesignFlags; type: RedesignType; isTest: boolean; builtBy: BuiltBy | undefined }): boolean {
  return input.builtBy === "code" && redesignActive(input.flags, input.type, { isTest: input.isTest });
}

/** The request type of a plan, from the shape of its stages (the same rule the file contract uses): posts (an account's posts when the customer named the account), comments, companies, people, places. */
export function redesignTypeOf(stages: ReadonlyArray<Pick<ContractStageLike, "key" | "title_ar" | "parent_key" | "deliver" | "role_preference" | "endpoint_id">>, facts: { account: boolean }, capabilityOf?: (endpointId: string) => string | null): RedesignType {
  switch (contractTypeOf(stages, capabilityOf)) {
    case "comments": return "social_comments";
    case "companies": return "companies";
    case "companies_people": return "people";
    case "places": return "places";
    default: return facts.account ? "social_account" : "social_posts";
  }
}
