import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryStore } from "../agent/src/memoryStore";
import { accountIsTest } from "../agent/src/redesign";
import { REPLAY_USER, replay } from "./helpers/agentReplay";
import { ENDPOINT, TOPIC, pages, planning } from "./helpers/engineXScenario";

/**
 * S1 LIVE FINDINGS fix 1 (docs/S1-LIVE-FINDINGS.md section 0). The five live missions of 2026-11-01 ran the OLD pipeline although three flags were `test`: the worker asked `isTestAccount({ id })` with no e-mail, and the plus-alias test account
 * `iam.magdy+1@outlook.com` is a test account by its e-mail only. The worker now reads the account's e-mail (read-only) and asks with both. A model-built recipe still never runs raw (tests/redesign-stages.test.ts keeps pinning that).
 */
afterEach(() => { vi.unstubAllGlobals(); });

const PLUS_ALIAS_ID = "b0d08be8-db61-4860-841e-fa963045557e";
const emailsOf = (map: Record<string, string>) => ({ readUserEmail: async (id: string) => map[id] ?? null }) as never;

describe("accountIsTest: id AND e-mail, never the id alone", () => {
  it("the plus-alias test account (known by e-mail only) is a test account", async () => {
    expect(await accountIsTest(emailsOf({ [PLUS_ALIAS_ID]: "iam.magdy+1@outlook.com" }), PLUS_ALIAS_ID)).toBe(true);
  });
  it("a real customer is not, and neither is a look-alike domain", async () => {
    expect(await accountIsTest(emailsOf({ u1: "customer@gmail.com" }), "u1")).toBe(false);
    expect(await accountIsTest(emailsOf({ u1: "iam.magdy+1@outlook.com.evil.com" }), "u1")).toBe(false);
  });
  it("a hard-coded test id needs no e-mail", async () => {
    expect(await accountIsTest(emailsOf({}), "47693c59-89f1-405d-bec1-e72271517870")).toBe(true);
  });
  it("an e-mail that cannot be read leaves the account a non-test account (never a way to switch the new pipeline on)", async () => {
    expect(await accountIsTest({ readUserEmail: async () => { throw new Error("down"); } } as never, PLUS_ALIAS_ID)).toBe(false);
    expect(await accountIsTest({} as never, PLUS_ALIAS_ID)).toBe(false);
  });
});

const setup = (flags: unknown, email: string | null) => (d: Parameters<NonNullable<Parameters<typeof replay>[0]["deps"]>>[0]) => {
  const store = d.store as MemoryStore;
  store.settings.redesign_flags = flags;
  if (email) store.userEmails.set(REPLAY_USER, email);
  return d;
};
const run = (flags: unknown, email: string | null) => replay({ request: "هات ٣٠٠ تغريدة عن محمد صلاح", planning: planning(), execution: () => [], answers: [pages(1)[0], ...pages(30)], deps: setup(flags, email) });

describe("the mission of a plus-alias test account in test mode runs the code-built request", () => {
  it("flag test + the plus-alias e-mail: the stored recipe is built by code", async () => {
    const r = await run({ social_posts: "test" }, "iam.magdy+1@outlook.com");
    expect(r.plannedPlan.stages[0].engine!.built_by).toBe("code");
    expect(r.plannedPlan.stages[0].engine!.endpoint_id).toBe(ENDPOINT);
    expect(String(r.plannedPlan.stages[0].engine!.params.query).startsWith(TOPIC)).toBe(true);
  });
  it("flag test + a real customer: the old path (no built_by)", async () => {
    const r = await run({ social_posts: "test" }, "customer@gmail.com");
    expect(r.plannedPlan.stages[0].engine!.built_by).toBeUndefined();
  });
  it("flag off + the plus-alias account: the old path", async () => {
    const r = await run({ social_posts: "off" }, "iam.magdy+1@outlook.com");
    expect(r.plannedPlan.stages[0].engine!.built_by).toBeUndefined();
  });
  it("the execution records the pipeline that ran the mission: pipe_new = 1 for the test account, 0 for a real customer", async () => {
    const pipe = async (email: string) => {
      const r = await run({ social_posts: "test" }, email);
      const ev = (r.store as MemoryStore).events.filter((e) => e.counts && "pipe_new" in (e.counts as object));
      return ev.map((e) => (e.counts as { pipe_new: number }).pipe_new);
    };
    expect(await pipe("iam.magdy+1@outlook.com")).toEqual([1]);
    expect(await pipe("customer@gmail.com")).toEqual([0]);
  });
});
