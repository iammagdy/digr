import { describe, expect, it } from "vitest";
import {
  REDESIGN_FLAGS_KEY, REDESIGN_TYPES, normalizeRedesignFlags, rawDeliveryEffective, readRedesignFlags, redesignActive, redesignTypeOf,
} from "../src/lib/agentMission/redesignFlags";
import { setRedesignFlag } from "../src/lib/agentMission/adminActions";

/** S1 item 0.1: one switch per request type (off | test | on) in agent_settings key `redesign_flags`, default OFF, unknown or unreadable reads as OFF. */
const ALL_OFF = { social_posts: "off", social_account: "off", social_comments: "off", companies: "off", people: "off", places: "off" };

describe("the flags default to off for every type", () => {
  it("the key and the six types are fixed", () => {
    expect(REDESIGN_FLAGS_KEY).toBe("redesign_flags");
    expect([...REDESIGN_TYPES]).toEqual(["social_posts", "social_account", "social_comments", "companies", "people", "places"]);
  });
  it("no setting, null, a string, an array: all off", () => {
    for (const raw of [undefined, null, "on", 7, [], {}]) expect(normalizeRedesignFlags(raw)).toEqual(ALL_OFF);
  });
  it("an unknown mode or an unknown type reads as off and is not kept", () => {
    expect(normalizeRedesignFlags({ social_posts: "maybe", social_comments: "ON", companies: 1, unknown_type: "on", people: "test" })).toEqual({ ...ALL_OFF, people: "test" });
  });
  it("an unreadable settings object (a getter that throws) reads as off", () => {
    const bad = {}; Object.defineProperty(bad, REDESIGN_FLAGS_KEY, { get() { throw new Error("boom"); } });
    expect(readRedesignFlags(bad as Record<string, unknown>)).toEqual(ALL_OFF);
    expect(readRedesignFlags(undefined)).toEqual(ALL_OFF);
    expect(readRedesignFlags({ [REDESIGN_FLAGS_KEY]: { social_posts: "on" } }).social_posts).toBe("on");
  });
});

describe("test mode is active for a test account only", () => {
  const flags = normalizeRedesignFlags({ social_posts: "test", social_comments: "on", social_account: "off" });
  it("off is never active, on is active for everyone, test only for a test account", () => {
    expect(redesignActive(flags, "social_account", { isTest: true })).toBe(false);
    expect(redesignActive(flags, "social_comments", { isTest: false })).toBe(true);
    expect(redesignActive(flags, "social_posts", { isTest: true })).toBe(true);
    expect(redesignActive(flags, "social_posts", { isTest: false })).toBe(false);
  });
});

describe("THE STAGE 1 ORDERING GATE: raw delivery needs a request built by code", () => {
  const on = normalizeRedesignFlags({ social_posts: "on" });
  it("a recipe built by the model never runs raw, whatever the flag says", () => {
    expect(rawDeliveryEffective({ flags: on, type: "social_posts", isTest: false, builtBy: "model" })).toBe(false);
    expect(rawDeliveryEffective({ flags: on, type: "social_posts", isTest: false, builtBy: undefined })).toBe(false);
  });
  it("built by code AND the flag active: raw; flag off: never", () => {
    expect(rawDeliveryEffective({ flags: on, type: "social_posts", isTest: false, builtBy: "code" })).toBe(true);
    expect(rawDeliveryEffective({ flags: ALL_OFF as never, type: "social_posts", isTest: true, builtBy: "code" })).toBe(false);
    expect(rawDeliveryEffective({ flags: normalizeRedesignFlags({ social_posts: "test" }), type: "social_posts", isTest: false, builtBy: "code" })).toBe(false);
  });
});

describe("the type of a plan comes from its stages", () => {
  const stage = (o: Record<string, unknown>) => ({ key: "s", title_ar: "x", parent_key: null, deliver: true, ...o });
  it("posts, an account's posts, comments", () => {
    expect(redesignTypeOf([stage({ key: "posts" })], { account: false })).toBe("social_posts");
    expect(redesignTypeOf([stage({ key: "posts" })], { account: true })).toBe("social_account");
    expect(redesignTypeOf([stage({ key: "posts" }), stage({ key: "comments", parent_key: "posts" })], { account: false })).toBe("social_comments");
  });
});

describe("the admin write: validated, with before and after for the audit row", () => {
  const fake = (value: unknown) => { const upserts: unknown[] = []; return { upserts, from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: value === undefined ? null : { value } }) }) }), upsert: async (row: unknown) => { upserts.push(row); return { error: null }; } }) }; };
  it("changes one type and reports before and after", async () => {
    const c = fake({ social_posts: "test" });
    const r = await setRedesignFlag(c, { type: "social_comments", mode: "test", adminId: "a1" });
    expect(r).toMatchObject({ ok: true, before: "off", after: "test" });
    expect((c.upserts[0] as { key: string; value: Record<string, string> }).key).toBe("redesign_flags");
    expect((c.upserts[0] as { value: Record<string, string> }).value).toEqual({ ...ALL_OFF, social_posts: "test", social_comments: "test" });
  });
  it("an invalid type or mode is refused and nothing is written", async () => {
    const c = fake(undefined);
    expect(await setRedesignFlag(c, { type: "nope", mode: "on", adminId: "a1" })).toMatchObject({ ok: false, status: 400 });
    expect(await setRedesignFlag(c, { type: "social_posts", mode: "yes", adminId: "a1" })).toMatchObject({ ok: false, status: 400 });
    expect(c.upserts).toEqual([]);
  });
});
