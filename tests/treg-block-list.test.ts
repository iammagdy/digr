import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { BLOCK_LIST_SIZES, CATALOG_SNAPSHOT, blockedEndpointReason, isEndpointBlocked, providerOf } from "../src/lib/treg/blockList";
import { executeTregCall } from "../src/functions/shared/tregClient";
import { executeTregCallWithRetry } from "../src/lib/server/tregAdapter";

const writeActions: Array<{ id: string; scope: string; trigger_word: string }> = JSON.parse(readFileSync("data/treg/treg_write_actions.json", "utf-8"));
const index = JSON.parse(readFileSync("data/treg/treg_catalog_index.json", "utf-8"));

const okResponse = () => new Response(JSON.stringify({ ok: true, rows: [] }), { status: 200, headers: { "x-treg-cost-micro": "0" } });

describe("the hard block list", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("TREG_TOKEN", "not-a-real-token");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("the lists are the committed files, unchanged", () => {
    expect(writeActions).toHaveLength(276);
    expect(BLOCK_LIST_SIZES.writeActions).toBe(276);
    expect(BLOCK_LIST_SIZES.sellable).toBe(3276);
    expect(index.ids).toHaveLength(3276);
    expect(CATALOG_SNAPSHOT.count).toBe(3276);
    expect(CATALOG_SNAPSHOT.excluded).toEqual({ own_account: 652, write: 29, paused: 12 });
    const bytes = readFileSync("data/treg/treg_write_actions.json");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("0570489d74ee86b4abc14e7e66764546cbb0eae924c63d2518823ed179754909");
  });

  it("no write action is also sellable", () => {
    const sellable = new Set<string>(index.ids);
    expect(writeActions.filter((w) => sellable.has(w.id))).toEqual([]);
  });

  it("EVERY one of the 276 write actions is blocked, and not one request leaves for any of them", async () => {
    for (const action of writeActions) {
      expect(blockedEndpointReason(action.id)).toBe("write_action");
      const result = await executeTregCall({ endpointId: action.id, params: { x: 1 }, userId: "u", jobId: "j" });
      expect(result.ok).toBe(false);
      expect(result.blocked).toBe("write_action");
      expect(result.error).toBe("endpoint_blocked");
      expect(result.costMicro).toBe(0);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a blocked call is not retried either", async () => {
    const result = await executeTregCallWithRetry({ endpointId: writeActions[0].id, params: {}, userId: "u", jobId: "j" }, 3);
    expect(result.blocked).toBe("write_action");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an endpoint the catalog marks own_account is blocked whenever its scope is known", async () => {
    const sellableId = index.ids[0];
    expect(blockedEndpointReason(sellableId, "own_account")).toBe("own_account");
    expect(blockedEndpointReason(sellableId, "any_account")).toBeNull();
    const result = await executeTregCall({ endpointId: sellableId, endpointScope: "own_account", params: {}, userId: "u", jobId: "j" });
    expect(result.blocked).toBe("own_account");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an endpoint of a known provider that is not in the sellable catalog (own-account, paused, or made up by a model) is blocked", async () => {
    const provider = providerOf(index.ids[0]);
    const madeUp = `${provider}.not.in.the.catalog.v9`;
    expect(blockedEndpointReason(madeUp)).toBe("not_sellable");
    const result = await executeTregCall({ endpointId: madeUp, params: {}, userId: "u", jobId: "j" });
    expect(result.blocked).toBe("not_sellable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a sellable endpoint is called as before (one request, to the call route)", async () => {
    const result = await executeTregCall({ endpointId: "anyapi.x.user.posts", method: "POST", params: { handle: "elonmusk" }, userId: "u", jobId: "j" });
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/call/anyapi.x.user.posts");
  });

  it("every endpoint the product calls today is sellable, so the block list stops none of them", () => {
    const used = [
      "anyapi.facebook.search_posts", "anyapi.facebook.user.posts", "anyapi.tiktok.search.videos", "anyapi.tiktok.user.videos", "anyapi.x.search.posts", "anyapi.x.user.posts",
      "crawl4ai.facebook.user.posts", "crawl4ai.tiktok.search.videos", "crawl4ai.tiktok.user.videos", "crawl4ai.tiktok.video.comments", "crawl4ai.x.user.posts",
      "crawl4ai.youtube.channel.videos", "crawl4ai.youtube.search.videos", "crawl4ai.youtube.video.comments", "icypeas.companies.search", "icypeas.people.search",
      "justoneapi.x.facebook-search-post-v1", "scrapecreators.x.v1-facebook-post-comments", "scrapecreators.x.v1-facebook-profile-posts", "tikhub.tiktok.search.videos",
      "tikhub.tiktok.user.profile", "tikhub.tiktok.video.comments", "tikhub.x.twitter-web-fetch-search-timeline", "tikhub.youtube.channel.videos", "tikhub.youtube.search.videos",
      "tikhub.youtube.video.comments", "treg.companies.search", "treg.people.email.find", "treg.people.email.verify", "treg.people.phone.find", "treg.people.search",
    ];
    for (const id of used) expect(isEndpointBlocked(id), id).toBe(false);
  });

  it("ids that are not provider ids at all (a product slug, a placeholder) are not matched by the catalog rules", () => {
    for (const id of ["tiktok-profile", "mp.business.contacts", "", "   "]) expect(blockedEndpointReason(id)).toBeNull();
  });
});
