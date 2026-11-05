import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { createSupabaseStore } from "../agent/src/supabaseStore";

/**
 * MONEY PR 7a, PHASE 2B-1: A CREATE-ONLY WRITE THAT REPORTS AN EXISTING OBJECT (docs/MONEY-PR-7A.md section 12.4). `putNew` treats «already exists» as done (the item store's own retry is safe that way); the add-on runner must
 * KNOW whether it wrote the object or found one, because a version path that already holds another object is the zombie case (release, no charge). `putNewStrict` is additive: `putNew` is unchanged.
 */
const JSON_TYPE = "application/json";

describe("the memory store", () => {
  it("creates once and reports it; a second write of the same path reports it exists and changes nothing", async () => {
    const store = createMemoryStore();
    expect(await store.putNewStrict("msn_a", "versions/v0002.json", "first", JSON_TYPE)).toEqual({ created: true });
    expect(await store.putNewStrict("msn_a", "versions/v0002.json", "second", JSON_TYPE)).toEqual({ created: false });
    expect(await store.getFile("msn_a", "versions/v0002.json")).toBe("first");
  });
  it("refuses a type the bucket refuses, as putNew does", async () => {
    const store = createMemoryStore();
    await expect(store.putNewStrict("msn_a", "x.exe", "x", "application/x-msdownload")).rejects.toThrow("not supported");
  });
  it("putNew is unchanged: an existing path is left as it is and resolves with nothing", async () => {
    const store = createMemoryStore();
    await store.putNew("msn_a", "p.json", "one", JSON_TYPE);
    expect(await store.putNew("msn_a", "p.json", "two", JSON_TYPE)).toBeUndefined();
    expect(await store.getFile("msn_a", "p.json")).toBe("one");
  });
});

describe("the Supabase store (a fake bucket)", () => {
  const storeOver = (upload: (p: string, body: Buffer, o: Record<string, unknown>) => Promise<{ error: unknown }>) => {
    const seen: Array<{ path: string; options: Record<string, unknown> }> = [];
    const client = { storage: { from: () => ({ upload: async (p: string, b: Buffer, o: Record<string, unknown>) => { seen.push({ path: p, options: o }); return upload(p, b, o); } }) } };
    return { store: createSupabaseStore(client), seen };
  };
  it("upsert is OFF (create-only); a created object reports created", async () => {
    const { store, seen } = storeOver(async () => ({ error: null }));
    expect(await store.putNewStrict("msn_a", "versions/v0002.json", "x", JSON_TYPE)).toEqual({ created: true });
    expect(seen[0]).toMatchObject({ path: "msn_a/versions/v0002.json", options: { upsert: false, contentType: JSON_TYPE } });
  });
  it("a 409 or an «already exists» message reports exists, never an error", async () => {
    for (const error of [{ statusCode: "409", message: "x" }, { statusCode: 409, message: "x" }, { message: "The resource already exists" }, { message: "duplicate key" }]) {
      const { store } = storeOver(async () => ({ error }));
      expect(await store.putNewStrict("msn_a", "p.json", "x", JSON_TYPE)).toEqual({ created: false });
    }
  });
  it("any other error throws (the caller must not take a failed write for an existing object)", async () => {
    const { store } = storeOver(async () => ({ error: { statusCode: "500", message: "storage is down" } }));
    await expect(store.putNewStrict("msn_a", "p.json", "x", JSON_TYPE)).rejects.toThrow("storage is down");
  });
  it("putNew is unchanged: an existing object resolves with nothing", async () => {
    const { store } = storeOver(async () => ({ error: { statusCode: "409", message: "exists" } }));
    expect(await store.putNew("msn_a", "p.json", "x", JSON_TYPE)).toBeUndefined();
  });
});
