import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The fake provider can NOT be enabled on a production deployment and never touches the live database. Files: src/lib/server/
 * fakeProviderMode.ts (the guard), fakeSocialSource.ts (the fake), src/app/api/worker/chunk/route.ts and src/app/api/chat/accept-quote/
 * route.ts (the two places that read the guard). Truth table and a whole job: tests/fake-provider-mode.test.ts.
 */
const state = vi.hoisted(() => ({ acceptCalls: 0, gateReady: false }));
vi.mock("../src/lib/supabase/server", async () => {
  const base = (await import("./helpers/scaleHarness")).supabaseServerMock();
  const user = { id: "user_1", email: "a@b.c", email_confirmed_at: "2026-10-01T00:00:00Z", user_metadata: {} };
  return { ...base, createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user }, error: null })) } })) };
});
vi.mock("../src/lib/server/sendPlatformEmail", async () => (await import("./helpers/scaleHarness")).sendPlatformEmailMock());
vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/functions/shared/catalogClient")>()), getEndpointDetails: vi.fn(async () => null), searchCatalog: vi.fn(async () => []) }));
vi.mock("../src/lib/server/providerGate", () => ({
  getLiveProviderGateStatusFromSettings: vi.fn(async () => (state.gateReady ? { isReady: true } : { isReady: false, reasonCode: "live_provider_disabled", messageAr: "المصدر المباشر غير مفعّل الآن." })),
}));
vi.mock("../src/lib/supabase/quoteAccept", () => ({ acceptQuoteSupabase: vi.fn(async () => { state.acceptCalls += 1; return { success: false, statusCode: 400, errorAr: "stop here" }; }) }));

import { CRON_SECRET, jobRow, seedSocialJob, setupEnv, callWorker } from "./helpers/scaleHarness";
import { getInjectedProviderAdapter, setProviderAdapterForTesting } from "../src/lib/server/tregAdapter";
import { PRODUCTION_DATABASE_REF } from "../src/lib/server/fakeProviderMode";
import { POST as workerPost } from "../src/app/api/worker/chunk/route";
import { POST as acceptQuote } from "../src/app/api/chat/accept-quote/route";

const TEST_URL = "https://abcdefghijklmnop.supabase.co";
const saved = { ...process.env };
let restore: () => void;

function setEnv(env: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete (process.env as any)[key];
    else (process.env as any)[key] = value;
  }
}

beforeEach(() => {
  restore = setupEnv();
  setProviderAdapterForTesting(null);
  state.acceptCalls = 0;
  state.gateReady = false;
});
afterEach(() => { restore(); setProviderAdapterForTesting(null); process.env = { ...saved }; });

describe("VERCEL_ENV=production with the flag set: the worker refuses a mock and uses no fake source", () => {
  it("the flag, a production deployment and a test database address together still mean off", async () => {
    setEnv({ NODE_ENV: "production", VERCEL_ENV: "production", PRESSURE_FAKE_PROVIDER: "on", NEXT_PUBLIC_SUPABASE_URL: TEST_URL, ENABLE_MOCK_PROVIDER: undefined });
    const jobId = seedSocialJob({ target: 30, videoCount: 1, perVideo: 30 });
    const res = await workerPost(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", { method: "POST", headers: { authorization: `Bearer ${CRON_SECRET}` }, body: JSON.stringify({ jobId, expectedStep: 0, disableSelfChain: true, mockProvider: true }) }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("محظور");
    expect(getInjectedProviderAdapter()).toBeNull();
    expect(jobRow(jobId).delivered_units).toBe(0);
  });

  it("an ordinary chunk on production with the flag takes the REAL path: no fake adapter is installed, the live gate decides and the reserve is released untouched", async () => {
    setEnv({ NODE_ENV: "production", VERCEL_ENV: "production", PRESSURE_FAKE_PROVIDER: "on", NEXT_PUBLIC_SUPABASE_URL: TEST_URL, ENABLE_MOCK_PROVIDER: undefined });
    const jobId = seedSocialJob({ target: 30, videoCount: 1, perVideo: 30 });
    const out = await callWorker(jobId);
    expect(getInjectedProviderAdapter()).toBeNull();
    expect(jobRow(jobId).delivered_units ?? 0).toBe(0);
    expect(JSON.stringify(out.json)).not.toContain("fake");
  });

  it("the live database address with the flag on a preview is off too: no fake adapter is installed and nothing is delivered", async () => {
    setEnv({ NODE_ENV: "production", VERCEL_ENV: "preview", PRESSURE_FAKE_PROVIDER: "on", NEXT_PUBLIC_SUPABASE_URL: `https://${PRODUCTION_DATABASE_REF}.supabase.co`, ENABLE_MOCK_PROVIDER: undefined });
    const jobId = seedSocialJob({ target: 30, videoCount: 1, perVideo: 30 });
    await callWorker(jobId);
    expect(getInjectedProviderAdapter()).toBeNull();
    expect(jobRow(jobId).delivered_units ?? 0).toBe(0);
  });
});

describe("VERCEL_ENV=production with the flag set: the approval route does not open the test door", () => {
  const approve = () => acceptQuote(new NextRequest("http://x/api/chat/accept-quote", { method: "POST", body: JSON.stringify({ quoteId: "q1", expectedPlanHash: "a".repeat(64), explicitApproval: true }) }));

  it("production + flag: the live gate answers 503 and nothing is accepted or reserved", async () => {
    setEnv({ NODE_ENV: "production", VERCEL_ENV: "production", PRESSURE_FAKE_PROVIDER: "on", NEXT_PUBLIC_SUPABASE_URL: TEST_URL, ENABLE_MOCK_PROVIDER: undefined });
    const res = await approve();
    expect(res.status).toBe(503);
    expect((await res.json()).reasonCode).toBe("live_provider_disabled");
    expect(state.acceptCalls).toBe(0);
  });

  it("a preview with the flag and a test database passes the live gate (the next guard, the plan check, answers 409), and the live database address does not (503)", async () => {
    setEnv({ NODE_ENV: "production", VERCEL_ENV: "preview", PRESSURE_FAKE_PROVIDER: "on", NEXT_PUBLIC_SUPABASE_URL: TEST_URL, ENABLE_MOCK_PROVIDER: undefined });
    const open = await approve();
    expect(open.status).toBe(409);
    expect((await open.json()).gaps).toContain("empty_plan");
    setEnv({ NEXT_PUBLIC_SUPABASE_URL: `https://${PRODUCTION_DATABASE_REF}.supabase.co` });
    const closed = await approve();
    expect(closed.status).toBe(503);
    expect((await closed.json()).reasonCode).toBe("live_provider_disabled");
    expect(state.acceptCalls).toBe(0);
  });
});

describe("the fake source and its guard are read in exactly two routes and nowhere else", () => {
  it("no other source file imports the fake provider or its guard", () => {
    const files: string[] = [];
    const walk = (dir: string) => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else if (/\.(ts|tsx)$/.test(name)) files.push(path); } };
    walk("src");
    const users = files.filter((file) => /fakeProviderMode|fakeSocialSource/.test(readFileSync(file, "utf8")) && !/fakeProviderMode\.ts$|fakeSocialSource\.ts$/.test(file));
    expect(users.sort()).toEqual(["src/app/api/chat/accept-quote/route.ts", "src/app/api/worker/chunk/route.ts"]);
  });
  it("the guard itself reads only three environment values and names the live project", () => {
    const source = readFileSync("src/lib/server/fakeProviderMode.ts", "utf8");
    expect([...new Set([...source.matchAll(/env\.([A-Z_]+)/g)].map((match) => match[1]))].sort()).toEqual(["NEXT_PUBLIC_SUPABASE_URL", "PRESSURE_FAKE_PROVIDER", "VERCEL_ENV"]);
    expect(source).toContain('PRODUCTION_DATABASE_REF = "pfinlfaqwnytesedchik"');
  });
});
