import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isGroupQuoteItems, planSplit, hasJobGroupRpc } from "../src/lib/server/multiProvider/jobGroupPlan";
import { reserveForUnits, DEFAULT_PRICING_BASIS } from "../src/lib/recordPricing";

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
});
