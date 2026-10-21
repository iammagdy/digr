import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: () => ({}) }));
import { DEGRADED_BANNER_AR, DEGRADED_CLOSED_AR, DEGRADED_SLOW_FACTOR, degradedLevel } from "../src/lib/degradedMode";
import { getSlowFactor, setDegradedFromServer } from "../src/lib/degradedClient";
import { basePollDelayMs, nextBackgroundDelayMs, nextPollDelayMs } from "../src/lib/pollSchedule";
import { getBusyState } from "../src/lib/server/busyState";
import { GET as busyStatus } from "../src/app/api/busy-status/route";
import { GET as llmEnabled } from "../src/app/api/llm-enabled/route";
import { GET as driverStatus } from "../src/app/api/driver-status/route";

const env = { ...process.env };
afterEach(() => { process.env = { ...env }; setDegradedFromServer(false); });

describe("degraded mode: a configuration switch, off by default", () => {
  it("only «on» and «closed» are read; anything else is off", () => {
    expect(degradedLevel({})).toBe("off");
    for (const bad of ["", "off", "true", "1", "ON ", "yes"]) expect(degradedLevel({ DEGRADED_MODE: bad }), bad).toBe(bad.trim().toLowerCase() === "on" ? "on" : "off");
    expect(degradedLevel({ DEGRADED_MODE: "closed" })).toBe("closed");
  });

  it("the customer sentences are plain Arabic: no digits in Latin, no provider, no model, no money, no emoji", () => {
    for (const text of [DEGRADED_BANNER_AR, DEGRADED_CLOSED_AR]) {
      expect(text).not.toMatch(/[A-Za-z0-9]/);
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(text).not.toMatch(/دولار|USD|مزود|نموذج|Claude/);
    }
    expect(DEGRADED_CLOSED_AR).toContain("لا يُخصم شيء");
  });

  it("«on» slows every optional wait by the same factor and does not refuse anything; «off» changes nothing", () => {
    expect(getSlowFactor()).toBe(1);
    setDegradedFromServer(true);
    expect(getSlowFactor()).toBe(DEGRADED_SLOW_FACTOR);
    expect(nextPollDelayMs({ elapsedMs: 0, hidden: false, random: 0.5, slow: getSlowFactor() })).toBe(basePollDelayMs(0, false) * DEGRADED_SLOW_FACTOR);
    expect(nextBackgroundDelayMs(0.5, getSlowFactor())).toBe(30_000 * DEGRADED_SLOW_FACTOR);
    expect(nextPollDelayMs({ elapsedMs: 0, hidden: false, random: 0.5 })).toBe(basePollDelayMs(0, false));
    expect(nextPollDelayMs({ elapsedMs: 0, hidden: false, random: 0.5, slow: -3 })).toBe(basePollDelayMs(0, false));
    setDegradedFromServer(false);
    expect(getSlowFactor()).toBe(1);
  });

  it("«closed» closes the door like the busy mode: no new request starts, the sentence says nothing is deducted", async () => {
    process.env.DEGRADED_MODE = "closed";
    const state = await getBusyState({});
    expect(state).toMatchObject({ busy: true, reason: "service_load", messageAr: DEGRADED_CLOSED_AR });
    delete process.env.DEGRADED_MODE;
    expect((await getBusyState({})).busy).toBe(false);
  });

  it("the status answer tells the page which level it is in, and the edge may keep it", async () => {
    process.env.DEGRADED_MODE = "on";
    const on = await (await busyStatus(new NextRequest("http://x/api/busy-status", { headers: { "x-forwarded-for": "1.2.3.4" } }))).json();
    expect(on).toMatchObject({ busy: false, degraded: true, degradedMessageAr: DEGRADED_BANNER_AR });
    delete process.env.DEGRADED_MODE;
    const off = await (await busyStatus(new NextRequest("http://x/api/busy-status", { headers: { "x-forwarded-for": "1.2.3.5" } }))).json();
    expect(off).toMatchObject({ degraded: false, degradedMessageAr: "" });
  });

  it("no money, price, reserve, review or settlement code reads the switch", () => {
    for (const file of ["src/app/api/worker/chunk/route.ts", "src/lib/server/typedLedger.ts", "src/lib/pointsCap.ts", "src/lib/pricing.ts", "src/lib/supabase/quoteAccept.ts", "src/lib/server/companyRelevanceReview.ts", "src/lib/server/sampledReview.ts"]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/degradedMode|DEGRADED_MODE/);
    }
  });
});

describe("the public status routes are answered by the edge for a while (one function run per window for the whole room)", () => {
  it("busy 15 s, model switch 30 s, driver 30 s (shorter than the 3-minute heartbeat window); all public and with a stale window", async () => {
    const busy = await busyStatus(new NextRequest("http://x/api/busy-status", { headers: { "x-forwarded-for": "9.9.9.9" } }));
    expect(busy.headers.get("cache-control")).toBe("public, s-maxage=15, stale-while-revalidate=30");
    expect((await llmEnabled()).headers.get("cache-control")).toBe("public, s-maxage=30, stale-while-revalidate=60");
    expect((await driverStatus()).headers.get("cache-control")).toBe("public, s-maxage=30, stale-while-revalidate=30");
  });
});

describe("a return to the tab does not re-read the balance when the last read is fresh", () => {
  it("the focus handler checks the age of the last read", () => {
    const hook = readFileSync("src/hooks/useBalance.tsx", "utf8");
    expect(hook).toContain("BALANCE_FOCUS_MIN_GAP_MS = 20_000");
    expect(hook).toContain("Date.now() - lastReadAt.current >= BALANCE_FOCUS_MIN_GAP_MS");
    expect(hook).toContain('window.addEventListener("focus", onFocus)');
    expect(hook).toContain('window.addEventListener("diger:balance-changed", on)');
  });
});
