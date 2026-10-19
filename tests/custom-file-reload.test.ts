import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";

const state = vi.hoisted(() => ({
  user: null as any,
  job: null as any,
  dataJson: "" as string,
  uploads: [] as string[],
  calls: [] as string[],
}));

function chain(result: () => any) {
  const c: any = {
    select: () => c, eq: () => c, not: () => c, order: () => c, limit: () => c,
    single: async () => result(),
    maybeSingle: async () => result(),
    then: (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject),
  };
  return c;
}

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })) } })),
  createAdminClient: vi.fn(() => ({
    rpc: async (name: string) => { state.calls.push(`rpc:${name}`); return { data: null, error: null }; },
    from: (table: string) => {
      state.calls.push(`from:${table}`);
      if (table === "jobs") return chain(() => ({ data: state.job, error: state.job ? null : new Error("nf") }));
      return chain(() => ({ data: [], error: null }));
    },
    storage: {
      from: () => ({
        download: async (path: string) =>
          /data\.json$/.test(path) && state.dataJson ? { data: { text: async () => state.dataJson }, error: null } : { data: null, error: new Error("nf") },
        upload: async (path: string) => { state.uploads.push(path); return { error: null }; },
        createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://signed.example/${encodeURIComponent(path)}` }, error: null }),
      }),
    },
  })),
}));

import { GET as download } from "../src/app/api/jobs/[id]/download/route";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { encodeFileSpec } from "../src/lib/fileSpec";
import { persistedFileShape } from "../src/lib/fileShapeMessage";
import { normalizeDataset } from "../src/lib/server/normalizationPipeline";
import { createChatDb } from "./helpers/chatSession";

const rows = [
  { company_name: "Nile Energy", industry: "Utilities", location: "Cairo, Egypt", phone: "+20 100 000 0000", description: "Electricity distribution" },
  { company_name: "Delta Power", industry: "Utilities", location: "Alexandria, Egypt", phone: "+20 100 000 0001", description: "Power plants" },
];
const normalized: any = normalizeDataset({ rows, metadata: { country: "Egypt", entityType: "companies" } }, { title: "شركات" });
const columns = (normalized.columns || []).slice(0, 60).map((key: string) => ({ key, titleAr: normalized.codebook?.find((c: any) => c.field === key)?.titleAr || key }));

describe("the custom file survives a page reload", () => {
  it("persistedFileShape returns the stored file only when it is well formed", () => {
    const stored = { fileShape: { spec: { version: 1, groupBy: { column: "city", mode: "sheets" } }, descriptionAr: "شيت منفصل لكل قيمة في «المدينة»" } };
    expect(persistedFileShape(stored)).toEqual(stored.fileShape);
    expect(persistedFileShape({ fileShape: { spec: { version: 1, columns: ["a"], price: 0 }, descriptionAr: "x" } })).toBeUndefined();
    expect(persistedFileShape({ fileShape: { spec: { version: 1, columns: ["a"] }, descriptionAr: "" } })).toBeUndefined();
    expect(persistedFileShape({ items: [{ capabilitySlug: "x" }], summaryAr: "خطة" })).toBeUndefined();
    expect(persistedFileShape(null)).toBeUndefined();
    expect(persistedFileShape(undefined)).toBeUndefined();
  });

  it("the handler keeps the custom file with its assistant message; the reload restores the same download action", async () => {
    const db = createChatDb();
    const handler = new ChatHandler(db as any);
    await db.createRow({ tableId: "conversations", rowId: "c_reload", data: { userId: "u_reload", title: "x", status: "active", totalTokens: 0 } });
    (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("no model call expected"); });
    const live: any = await handler.handleUserMessage({ userId: "u_reload", conversationId: "c_reload", message: "رتب النتائج حسب المدينة تنازلياً", userBalance: 5000, resultColumns: columns });
    expect(live.fileShape.spec.sortBy).toEqual([{ column: "city", direction: "desc" }]);

    const assistantRows = ((db.store.get("messages") || []) as any[]).filter((row) => row.role === "assistant");
    expect(assistantRows).toHaveLength(1);
    // What a reload reads back from the stored row is the same download action the live reply had.
    const restored = persistedFileShape(assistantRows[0].plan);
    expect(restored).toEqual(live.fileShape);
    // No price, no plan, no ledger row came with it.
    expect(assistantRows[0].plan).toEqual({ fileShape: live.fileShape });
    expect(db.store.get("plans_quotes") || []).toHaveLength(0);
    expect(db.store.get("credit_ledger") || []).toHaveLength(0);
  });

  it("the Supabase write keeps it in the message's plan column and the page restores it from there", () => {
    const handlerSource = readFileSync("src/functions/shared/chatHandler.ts", "utf8");
    expect(handlerSource).toContain("fileShapeData ? { fileShape: fileShapeData } : null");
    const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(page).toContain("fileShape: persistedFileShape(document.plan)");
    expect(page).toContain("data-testid=\"download-shaped-file\"");
  });
});

describe("the download route still validates a stored spec against the real columns", () => {
  const params = { params: Promise.resolve({ id: "job_reload" }) };
  const req = (encoded: string) => new NextRequest(`http://localhost/api/jobs/job_reload/download?format=xlsx&spec=${encoded}`);

  beforeEach(() => {
    state.user = { id: "owner-1", app_metadata: {} };
    state.job = { id: "job_reload", user_id: "owner-1", status: "completed", delivered_units: 2, target_volume_max: 2, params: {}, template_slug: "web", endpoint_id: "web" };
    state.dataJson = JSON.stringify({ metadata: { title: "شركات", platform: "web", template: "web", entityType: "companies" }, rows });
    state.uploads = [];
    state.calls = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("a spec naming a column the file does not have is refused in Arabic before anything is built", async () => {
    const res = await download(req(encodeFileSpec({ version: 1, sortBy: [{ column: "المحافظة", direction: "asc" }] })), params);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("«المحافظة»");
    expect(state.uploads).toHaveLength(0);
  });

  it("a spec the stored message carries is built from the saved data with no ledger or provider call", async () => {
    const res = await download(req(encodeFileSpec({ version: 1, sortBy: [{ column: "city", direction: "desc" }] })), params);
    expect(res.status).toBe(200);
    expect(state.uploads).toHaveLength(1);
    expect(state.uploads[0]).toMatch(/shaped_[0-9a-f]{10}\.xlsx$/);
    expect(state.calls.filter((call) => call.startsWith("rpc:") || call.includes("credit_ledger") || call.includes("provider_costs"))).toEqual([]);
  });
});
