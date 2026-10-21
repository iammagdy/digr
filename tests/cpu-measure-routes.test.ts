import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { measureCpu, recordSamples, type CpuSample } from "./helpers/cpuMeter";
import { createLatencyDb } from "./helpers/loadHarness";

/**
 * Raw CPU per route, in milliseconds on this machine, with in-memory fakes and no model. Written to CPU_OUT when set (the capacity
 * model reads it). The assertions only check that every route was measured and that the heaviest one is the chat turn that builds a plan.
 */
const h = vi.hoisted(() => ({ db: null as any, rowsInResult: 1000 }));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async (token?: string) => ({ data: { user: token ? { id: String(token), email: `${token}@x.test`, email_confirmed_at: "2026-10-01T00:00:00Z", user_metadata: {} } : null }, error: token ? null : new Error("no session") })) },
  })),
  createAdminClient: vi.fn(() => h.db.client),
}));
vi.mock("../src/functions/shared/catalogClient", () => ({
  searchCatalog: vi.fn(async () => []),
  getCachedCatalogEndpoints: vi.fn(() => []),
  getEndpointDetails: vi.fn(async (id: string) => ({ id, catalogPriceUsd: 0.005, pointsPerUnit: 28 })),
}));
vi.mock("../src/lib/server/sendPlatformEmail", () => ({ sendPlatformEmail: vi.fn(async () => ({ ok: true })), getRecipient: vi.fn(async () => null) }));
vi.mock("../src/functions/shared/llmClient", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/functions/shared/llmClient")>();
  class NoModelClient extends original.LlmClient {
    async executeTurn(): Promise<never> { throw new Error("no model in the CPU measurement"); }
  }
  return { ...original, LlmClient: NoModelClient };
});

import { POST as chatRoute } from "../src/app/api/chat/route";
import { GET as busyStatus } from "../src/app/api/busy-status/route";
import { GET as llmEnabled } from "../src/app/api/llm-enabled/route";
import { GET as driverStatus } from "../src/app/api/driver-status/route";
import { GET as walletBalance } from "../src/app/api/wallet/balance/route";

const send = (user: string, message: string) => chatRoute(new NextRequest("http://localhost:3000/api/chat", {
  method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${user}` }, body: JSON.stringify({ message }),
}));

const samples: CpuSample[] = [];
let counter = 0;

describe("raw CPU per route (milliseconds on this machine, handlers only)", () => {
  beforeAll(() => {
    h.db = createLatencyDb({ tables: {} }, 0);
    for (const method of ["warn", "error", "log", "info"] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
  });

  it("the chat turns: a greeting, a fully stated request that builds a plan, a request that needs one question", async () => {
    samples.push(await measureCpu("chat_greeting", async () => { await (await send(`cpu_g_${counter++}`, "مرحبا")).text(); }, { runs: 25 }));
    samples.push(await measureCpu("chat_plan", async () => { await (await send(`cpu_p_${counter++}`, "أريد ٣٠ تعليق على يوتيوب عن كرة القدم خلال الشهر الماضي")).text(); }, { runs: 25 }));
    samples.push(await measureCpu("chat_question", async () => { await (await send(`cpu_q_${counter++}`, "أريد بيانات شركات")).text(); }, { runs: 25 }));
  });

  it("the public status routes", async () => {
    samples.push(await measureCpu("busy_status", async () => { await (await busyStatus(new NextRequest("http://x/api/busy-status", { headers: { "x-forwarded-for": `10.0.0.${counter++ % 250}` } }))).text(); }, { runs: 100 }));
    samples.push(await measureCpu("llm_enabled", async () => { await (await llmEnabled()).text(); }, { runs: 100 }));
    samples.push(await measureCpu("driver_status", async () => { await (await driverStatus()).text(); }, { runs: 100 }));
  });

  it("the balance read", async () => {
    for (let i = 0; i < 12; i += 1) h.db.rows("credit_ledger").push({ id: `l_${i}`, user_id: "cpu_bal", delta: i % 2 ? -5 : 20, type: i % 2 ? "reserve" : "topup", created_at: "2026-10-20T00:00:00Z" });
    samples.push(await measureCpu("wallet_balance", async () => { await (await walletBalance(new NextRequest("http://x/api/wallet/balance", { headers: { authorization: "Bearer cpu_bal" } }))).text(); }, { runs: 100 }));
  });

  it("every route was measured, and the plan-building turn is the heaviest of them", () => {
    const by = Object.fromEntries(samples.map((s) => [s.name, s.medianMs]));
    for (const name of ["chat_greeting", "chat_plan", "chat_question", "busy_status", "llm_enabled", "driver_status", "wallet_balance"]) expect(by[name], name).toBeGreaterThan(0);
    expect(by.chat_plan).toBeGreaterThan(by.busy_status);
    expect(by.chat_plan).toBeGreaterThan(by.driver_status);
    recordSamples(process.env.CPU_OUT, samples);
  }, 120_000);
});
