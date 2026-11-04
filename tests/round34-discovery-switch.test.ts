import { describe, expect, it } from "vitest";
import { SOCIAL_DISCOVERY_MODES, readSocialDiscoveryMode, setSocialDiscovery } from "../src/lib/agentMission/adminActions";
import { SOCIAL_DISCOVERY_SETTING_KEY } from "../src/lib/agentMission/constants";
import { SOCIAL_DISCOVERY_KEY, discoveryActive } from "../src/lib/agentMission/foundation/discovery";
import { accountIsTest } from "../agent/src/redesign";

/**
 * ROUND 34: THE ONE SETTING THAT TURNS THE CATALOG DISCOVERY ON. The admin route writes ONE key of `agent_settings` (`social_discovery`), only `test` or `off`, with before and after for the audit row; the worker reads it and applies it to a TEST account only.
 * No schema, no permission, no financial setting and no other key is touched by it.
 */
const fake = (value: unknown, failWrite = false) => {
  const upserts: Array<{ key: string; value: unknown; updated_by?: string }> = [];
  const reads: string[] = [];
  return { upserts, reads, from: (table: string) => ({
    select: () => ({ eq: (_c: string, key: string) => ({ maybeSingle: async () => { reads.push(`${table}:${key}`); return { data: value === undefined ? null : { value } }; } }) }),
    upsert: async (row: { key: string; value: unknown; updated_by?: string }) => { if (failWrite) return { error: { message: "no" } }; upserts.push(row); return { error: null }; },
  }) };
};

describe("the admin write: one key, two values, before and after", () => {
  it("the key is the one the worker reads, and only `test` and `off` exist", () => {
    expect(SOCIAL_DISCOVERY_SETTING_KEY).toBe("social_discovery");
    expect(SOCIAL_DISCOVERY_KEY).toBe(SOCIAL_DISCOVERY_SETTING_KEY);
    expect([...SOCIAL_DISCOVERY_MODES]).toEqual(["test", "off"]);
  });
  it("reads the current value first, writes ONLY `agent_settings.social_discovery`, and reports before → after", async () => {
    const c = fake(undefined);
    const r = await setSocialDiscovery(c, { mode: "test", adminId: "a1" });
    expect(r).toMatchObject({ ok: true, before: "off", after: "test" });
    expect(c.reads).toEqual(["agent_settings:social_discovery"]);
    expect(c.upserts).toHaveLength(1);
    expect(c.upserts[0]).toMatchObject({ key: "social_discovery", value: "test", updated_by: "a1" });
  });
  it("turning it off writes `off` and reports the earlier mode", async () => {
    const c = fake("test");
    expect(await setSocialDiscovery(c, { mode: "off", adminId: "a1" })).toMatchObject({ ok: true, before: "test", after: "off" });
    expect(c.upserts[0]).toMatchObject({ key: "social_discovery", value: "off" });
  });
  it("`on`, any other value and a non-string are refused and nothing is written (no setting can give a derived tool to a customer)", async () => {
    const c = fake(undefined);
    for (const mode of ["on", "TEST", "yes", "", null, undefined, true, 1, { mode: "test" }]) expect(await setSocialDiscovery(c, { mode, adminId: "a1" }), String(mode)).toMatchObject({ ok: false, status: 400 });
    expect(c.upserts).toEqual([]);
    expect(c.reads).toEqual([]);
  });
  it("a failed write is reported as a failure, not as success", async () => {
    expect(await setSocialDiscovery(fake(undefined, true), { mode: "test", adminId: "a1" })).toMatchObject({ ok: false, status: 500 });
  });
  it("what the admin page shows: `test` only for the exact value, else `off`", () => {
    expect(readSocialDiscoveryMode("test")).toBe("test");
    for (const v of ["on", "off", "TEST", null, undefined, 1, {}, ["test"]]) expect(readSocialDiscoveryMode(v)).toBe("off");
  });
});

describe("the worker side: the value is applied to a TEST account only", () => {
  it("the stored value `test` (as `agent_settings` returns it) switches a test account on and never a customer", () => {
    const settings = { [SOCIAL_DISCOVERY_SETTING_KEY]: "test", redesign_flags: { x: "on" } };
    expect(discoveryActive(settings, true)).toBe(true);
    expect(discoveryActive(settings, false)).toBe(false);
    expect(discoveryActive({ [SOCIAL_DISCOVERY_SETTING_KEY]: "off" }, true)).toBe(false);
  });
  it("test-account eligibility is decided by the shared classifier (the e-mail aliases of the owner, the @digr.local accounts and the pinned ids); a customer's e-mail is not eligible", async () => {
    const mail = (email: string | null) => ({ readUserEmail: async () => email });
    expect(await accountIsTest(mail("iam.magdy+1@outlook.com"), "b0d08be8-db61-4860-841e-fa963045557e")).toBe(true);
    expect(await accountIsTest(mail("iam.magdy@outlook.com"), "47693c59-89f1-405d-bec1-e72271517870")).toBe(true);
    expect(await accountIsTest(mail("test_accept@digr.local"), "00000000-0000-0000-0000-000000000002")).toBe(true);
    expect(await accountIsTest(mail("someone@example.com"), "11111111-1111-1111-1111-111111111111")).toBe(false);
    expect(await accountIsTest(mail("iam.magdy+1@outlook.com.evil.com"), "11111111-1111-1111-1111-111111111111")).toBe(false);
  });
});
