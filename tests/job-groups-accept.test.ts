import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isGroupQuoteItems, planSplit, hasJobGroupRpc } from "../src/lib/server/multiProvider/jobGroupPlan";
import { reserveForUnits, DEFAULT_PRICING_BASIS } from "../src/lib/recordPricing";
import { acceptQuoteSupabase } from "../src/lib/supabase/quoteAccept";
import { GROUP_UNAVAILABLE_AR, groupStartLineAr } from "../src/lib/multiProvider/copy";
import { getConfiguredJobPointsCap, DEFAULT_JOB_POINTS_CAP } from "../src/functions/shared/providerSpend";

describe("DT-05 PR-9 group approval", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    [[], false],
    [null, false],
    [{ params: { split: { v: 3 } } }, false],
    [[{ params: {} }], false],
    [[{ params: { split: { v: 2 } } }], false],
    [[{ params: { split: { v: "3" } } }], false],
    [[{ params: { split: { v: 3 } } }, { params: { split: { v: 3 } } }], false],
    [[{ params: { split: { v: 3, part: 1 } } }], true],
  ])("isGroupQuoteItems(%j) is %s", (items, expected) => {
    expect(isGroupQuoteItems(items)).toBe(expected);
  });

  // plan T3 (a): the planSplit table, V = 40, unit 7, the pricing basis' own buffer
  const V = 40, UNIT = 7, BUF = DEFAULT_PRICING_BASIS.safetyBuffer;
  it.each([
    ["X = V + 1", V + 1, 41, 2, [40, 1]],
    ["X = 3V", 3 * V, 120, 3, [40, 40, 40]],
    ["X = 40V", 40 * V, 1600, 40, Array(40).fill(40)],
    ["X = 40V + 1 (beyond the part limit)", 40 * V + 1, 1600, 40, Array(40).fill(40)],
  ] as Array<[string, number, number, number, number[]]>)("(T3 a) planSplit %s", (_n, X, Y, K, volumes) => {
    const r = planSplit({ X, V, unit: UNIT, safetyBuffer: BUF });
    expect(r.Y).toBe(Y);
    expect(r.K).toBe(K);
    expect(r.partVolumes).toEqual(volumes);
    expect(r.partReserves).toEqual(volumes.map((v) => Math.max(1, reserveForUnits(v, UNIT, BUF))));
    expect(r.hold).toBe(r.partReserves.reduce((a, b) => a + b, 0));
    expect(r.partReserves[0]).toBe(Math.max(1, reserveForUnits(V, UNIT, BUF))); // = the single-job item reservation

    // Addendum A1 (N1): literal pins
    if (X === V + 1) {
      expect(r.partReserves).toEqual([322, 9]);
      expect(r.hold).toBe(331);
    } else if (X === 3 * V) {
      expect(r.hold).toBe(966);
    } else if (X === 40 * V) {
      expect(r.hold).toBe(12_880);
    }
  });

  // T02 readiness probe
  const probeAnswer = (data: any, error: any = null) => ({ data, error });
  function adminWith(answer: () => Promise<any>) {
    const rpc = vi.fn(async (_n: string, _a: any) => answer());
    return { rpc } as any;
  }

  it("the probe uses the plan's call and answers true only for quote_not_found", async () => {
    const a = adminWith(async () => probeAnswer({ success: false, error: "quote_not_found" }));
    expect(await hasJobGroupRpc(a)).toBe(true);
    const [name, args] = a.rpc.mock.calls[0];
    expect(name).toBe("accept_group_quote_atomic");
    expect(args).toEqual({
      p_quote_id: expect.stringMatching(/^__diger_group_probe_[0-9a-f]+$/),
      p_user_id: "00000000-0000-0000-0000-000000000000",
      p_expected_quote_hash: "probe",
      p_points_cap: 1,
      p_start_event_ar: "probe",
    });
  });

  it.each([
    ["PGRST202", probeAnswer(null, { code: "PGRST202", message: "x" })],
    ["42883", probeAnswer(null, { code: "42883", message: "x" })],
    ["42501", probeAnswer(null, { code: "42501", message: "x" })],
    ["an unknown code", probeAnswer(null, { code: "XX999", message: "boom" })],
    ["another answer (hash mismatch)", probeAnswer({ success: false, error: "quote_hash_mismatch" })],
    ["a success answer", probeAnswer({ success: true })],
    ["an empty answer", probeAnswer(null)],
    ["quote_not_found with an extra error", probeAnswer({ success: false, error: "quote_not_found" }, { message: "x" })],
  ])("(f) probe answers %s ⇒ false", async (_n, answer) => {
    expect(await hasJobGroupRpc(adminWith(async () => answer))).toBe(false);
  });

  it("(f) a thrown transport error ⇒ false; no rpc function ⇒ false", async () => {
    expect(await hasJobGroupRpc(adminWith(async () => { throw new Error("net"); }))).toBe(false);
    expect(await hasJobGroupRpc({})).toBe(false);
  });

  it("(f) a probe that never resolves ⇒ false after 4 s", async () => {
    vi.useFakeTimers();
    const p = hasJobGroupRpc(adminWith(() => new Promise(() => {})));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await p).toBe(false);
    vi.useRealTimers();
  });

  // T03 group accept branch
  const GROUP_ITEM = {
    capabilitySlug: "mp-business-contacts",
    endpointId: "mp.business.contacts",
    unitPricePoints: 7,
    unitCostUsd: 0.02,
    targetVolumeMax: 40,
    params: {
      split: {
        v: 3,
        part: 1,
        parts: 3,
        perPart: 40,
        partVolumes: [40, 40, 25],
        partReserves: [322, 322, 202],
        hold: 846,
        reachable: 105,
        askedOriginal: 105,
      },
    },
  };

  function adminFor(items: any[], answers: { probe?: any; accept?: any; acceptOld?: any } = {}) {
    const rpc = vi.fn(async (name: string, args: any) => {
      if (name === "accept_group_quote_atomic" && String(args.p_quote_id).startsWith("__diger_group_probe_")) {
        return (answers.probe ?? (async () => ({ data: { success: false, error: "quote_not_found" }, error: null })))();
      }
      if (name === "accept_group_quote_atomic") {
        return answers.accept ?? {
          data: { success: true, already_accepted: false, quote_id: args.p_quote_id, job_id: "job_p1", group_id: "grp_x", reserved_credits: 846 },
          error: null,
        };
      }
      return answers.acceptOld ?? {
        data: { success: true, already_accepted: false, quote_id: args.p_quote_id, job_id: "job_old", reserved_credits: 100 },
        error: null,
      };
    });
    return {
      admin: {
        from: () => ({
          select: () => ({
            eq: () => ({
              single: async () => ({ data: { quote_hash: "h1", items }, error: null }),
            }),
          }),
        }),
        rpc,
      } as any,
      rpc,
    };
  }

  const realAccepts = (rpc: any) =>
    rpc.mock.calls.filter(
      ([n, a]: any[]) =>
        n === "accept_quote_atomic" ||
        (n === "accept_group_quote_atomic" && !String(a.p_quote_id).startsWith("__diger_group_probe_"))
    );

  it("(c) group items ⇒ ONE accept_group_quote_atomic with the exact args; the result is the part-1 job and the hold", async () => {
    const { admin, rpc } = adminFor([GROUP_ITEM]);
    const r = await acceptQuoteSupabase(admin, { userId: "u1", quoteId: "q1" });
    const calls = realAccepts(rpc);
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual([
      "accept_group_quote_atomic",
      {
        p_quote_id: "q1",
        p_user_id: "u1",
        p_expected_quote_hash: "h1",
        p_points_cap: Math.min(getConfiguredJobPointsCap(), DEFAULT_JOB_POINTS_CAP),
        p_start_event_ar: groupStartLineAr({ hold: 846, parts: 3 }),
      },
    ]);
    expect(r).toEqual({
      success: true,
      jobId: "job_p1",
      quoteId: "q1",
      reservedCredits: 846,
      alreadyAccepted: false,
    });
  });

  it("(e) ACCEPT AFTER THE STOP: a quote row with group items made directly in the fake (no card code) is accepted through the group branch with the same args", async () => {
    const other = {
      ...GROUP_ITEM,
      params: {
        split: {
          ...GROUP_ITEM.params.split,
          parts: 2,
          partVolumes: [40, 20],
          partReserves: [322, 161],
          hold: 483,
          reachable: 60,
          askedOriginal: 60,
        },
      },
    };
    const { admin, rpc } = adminFor([other], {
      accept: {
        data: {
          success: true,
          already_accepted: false,
          quote_id: "q2",
          job_id: "job_p1",
          group_id: "grp_y",
          reserved_credits: 483,
        },
        error: null,
      },
    });
    const r = await acceptQuoteSupabase(admin, { userId: "u1", quoteId: "q2", expectedPlanHash: "hX" });
    expect(realAccepts(rpc)[0][1]).toMatchObject({
      p_quote_id: "q2",
      p_expected_quote_hash: "hX",
      p_start_event_ar: groupStartLineAr({ hold: 483, parts: 2 }),
    });
    expect(r.reservedCredits).toBe(483);
  });

  it.each([
    ["PGRST202", { data: null, error: { code: "PGRST202", message: "x" } }],
    ["42883", { data: null, error: { code: "42883", message: "x" } }],
    ["an unknown code", { data: null, error: { code: "XX999", message: "boom" } }],
  ])("(f) PRE-SQL FAIL CLOSED: the probe answers %s ⇒ 503 GROUP_UNAVAILABLE_AR, no accept rpc of either kind", async (_n, answer) => {
    const { admin, rpc } = adminFor([GROUP_ITEM], { probe: async () => answer });
    const r = await acceptQuoteSupabase(admin, { userId: "u1", quoteId: "q1" });
    expect(r).toEqual({ success: false, statusCode: 503, errorAr: GROUP_UNAVAILABLE_AR });
    expect(realAccepts(rpc)).toEqual([]);
  });

  it("(f) a probe that never resolves ⇒ 503 after 4 s, no accept rpc", async () => {
    vi.useFakeTimers();
    const { admin, rpc } = adminFor([GROUP_ITEM], { probe: () => new Promise(() => {}) });
    const p = acceptQuoteSupabase(admin, { userId: "u1", quoteId: "q1" });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await p).toEqual({ success: false, statusCode: 503, errorAr: GROUP_UNAVAILABLE_AR });
    expect(realAccepts(rpc)).toEqual([]);
    vi.useRealTimers();
  });

  it.each([
    ["insufficient_balance", { balance: 5 }],
    ["quote_expired", {}],
    ["concurrency_limit", {}],
    ["invalid_quote_status", {}],
    ["quote_not_found", {}],
  ])("the group branch maps %s exactly as the single-job path does", async (code, extra) => {
    const answer = { data: { success: false, error: code, ...extra }, error: null };
    const g = adminFor([GROUP_ITEM], { accept: answer });
    const o = adminFor([{ ...GROUP_ITEM, params: {} }], { acceptOld: answer });
    expect(await acceptQuoteSupabase(g.admin, { userId: "u1", quoteId: "q1" })).toEqual(
      await acceptQuoteSupabase(o.admin, { userId: "u1", quoteId: "q1" })
    );
  });

  it.each(["invalid_group_plan", "accepted_without_group"])(
    "%s ⇒ 409 with the existing generic text",
    async (code) => {
      const { admin } = adminFor([GROUP_ITEM], { accept: { data: { success: false, error: code }, error: null } });
      expect(await acceptQuoteSupabase(admin, { userId: "u1", quoteId: "q1" })).toEqual({
        success: false,
        statusCode: 409,
        errorAr: "حالة العرض غير صالحة للبدء.",
      });
    }
  );

  it("non-group quotes: the probe is never made and accept_quote_atomic is called exactly as today", async () => {
    const { admin, rpc } = adminFor([{ ...GROUP_ITEM, params: {} }]);
    const r = await acceptQuoteSupabase(admin, { userId: "u1", quoteId: "q1" });
    expect(rpc.mock.calls).toEqual([
      ["accept_quote_atomic", { p_quote_id: "q1", p_user_id: "u1", p_expected_quote_hash: "h1" }],
    ]);
    expect(r).toMatchObject({ success: true, jobId: "job_old" });
  });
});
