import { StorageApiError, StorageUnknownError } from "@supabase/storage-js";
import { describe, expect, it } from "vitest";
import { createSupabaseStore } from "../agent/src/supabaseStore";

/**
 * MONEY PR 7a, PHASE 2B-1 SAFETY FIX 2: A STORAGE FAILURE IS NOT «NOT FOUND» (docs/MONEY-PR-7A.md section 13.6). `getFileBytes` answered null for ANY download error, so the add-on runner's check «does the published path already hold
 * a version?» took a rate limit, a permission failure or a server error for an empty path. Now null means ONE thing: the storage service itself said that THIS object does not exist (an API error whose body says «Object not found»
 * with status 404, which the service sends as HTTP 400 or 404); every other answer is a controlled error. The errors here are the real classes of the installed client (`@supabase/storage-js`), not look-alikes.
 */
const storeOver = (download: (path: string) => Promise<{ data: unknown; error: unknown }>) => {
  const seen: string[] = [];
  const client = { storage: { from: () => ({ download: async (p: string) => { seen.push(p); return download(p); } }) } };
  return { store: createSupabaseStore(client), seen };
};
const api = (message: string, status: number, statusCode: string) => new StorageApiError(message, status, statusCode);
const blob = (text: string) => new Blob([text]);

describe("TEST 4: a confirmed «object not found» is null, as before", () => {
  const confirmed: Array<[string, unknown]> = [
    ["HTTP 400 with the service's own body (how the storage service answers)", api("Object not found", 400, "404")],
    ["HTTP 404 with the same body", api("Object not found", 404, "404")],
  ];
  for (const [label, error] of confirmed) {
    it(label, async () => {
      const { store, seen } = storeOver(async () => ({ data: null, error }));
      expect(await store.getFileBytes("msn_a", "versions/v0002.json")).toBeNull();
      expect(await store.getFile("msn_a", "versions/v0002.json")).toBeNull();
      expect(seen[0]).toBe("msn_a/versions/v0002.json");
    });
  }
  it("an object that is there still comes back as its bytes and its text", async () => {
    const { store } = storeOver(async () => ({ data: blob("{\"v\":1}"), error: null }));
    expect((await store.getFileBytes("msn_a", "p.json"))!.toString("utf8")).toBe("{\"v\":1}");
    expect(await store.getFile("msn_a", "p.json")).toBe("{\"v\":1}");
  });
});

describe("TEST 5: every other failure is a controlled error, never «not found»", () => {
  const failures: Array<[string, () => Promise<{ data: unknown; error: unknown }>]> = [
    ["403 permission failure", async () => ({ data: null, error: api("new row violates row-level security policy", 403, "403") })],
    ["401 unauthorized", async () => ({ data: null, error: api("Invalid Compact JWS", 401, "403") })],
    ["429 rate limit", async () => ({ data: null, error: api("Too many requests", 429, "429") })],
    ["500 server error", async () => ({ data: null, error: api("Internal Server Error", 500, "500") })],
    ["503 unavailable", async () => ({ data: null, error: api("Service Unavailable", 503, "503") })],
    ["a missing BUCKET (a 404 that is not about this object)", async () => ({ data: null, error: api("Bucket not found", 404, "404") })],
    ["a 404 from a gateway in front of the service (no object message)", async () => ({ data: null, error: api("Not Found", 404, "404") })],
    ["«Object not found» but with a server status", async () => ({ data: null, error: api("Object not found", 500, "404") })],
    ["a 400 that says something else", async () => ({ data: null, error: api("Invalid path specified in request URL", 400, "400") })],
    ["an unknown error of the client (the network)", async () => ({ data: null, error: new StorageUnknownError("fetch failed", new TypeError("fetch failed")) })],
    ["an error that is a bare message (an ambiguous shape)", async () => ({ data: null, error: { message: "not_found" } })],
    ["an error with no message at all", async () => ({ data: null, error: {} })],
    ["no error and no data (an unexpected answer)", async () => ({ data: null, error: null })],
    ["a thrown exception", async () => { throw new Error("socket hang up"); }],
  ];
  for (const [label, download] of failures) {
    it(label, async () => {
      const { store } = storeOver(download);
      await expect(store.getFileBytes("msn_a", "versions/v0002.json")).rejects.toThrow();
      await expect(store.getFile("msn_a", "versions/v0002.json")).rejects.toThrow();
    });
  }
  it("the error says what failed and carries no path-less secret: a short message", async () => {
    const { store } = storeOver(async () => ({ data: null, error: api("Internal Server Error", 500, "500") }));
    await expect(store.getFileBytes("msn_a", "p.json")).rejects.toThrow(/^download: Internal Server Error/);
  });
});
