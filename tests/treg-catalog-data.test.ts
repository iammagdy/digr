import { describe, expect, it } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { catalogSearch, describeEndpoint, endpointCostUsd, isSellable, loadTregCatalog, parseCatalog } from "../src/lib/treg/catalog";

const SNAPSHOT = "data/treg/treg_catalog_sellable.json";
const WRITES = "data/treg/treg_write_actions.json";
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

describe("the committed data files are the attached files, unchanged", () => {
  it("sizes and sha256", () => {
    expect(statSync(SNAPSHOT).size).toBe(10_389_806);
    expect(sha(SNAPSHOT)).toBe("5d8a125d5a563d892cfabceef2a21a0429191bba8017e2707d1bf626035315cc");
    expect(statSync(WRITES).size).toBe(90_183);
    expect(sha(WRITES)).toBe("0570489d74ee86b4abc14e7e66764546cbb0eae924c63d2518823ed179754909");
  });

  it("the snapshot says what it is", () => {
    const head = JSON.parse(readFileSync(SNAPSHOT, "utf-8"));
    expect(head.count).toBe(3276);
    expect(head.endpoints).toHaveLength(3276);
    expect(head.excluded).toEqual({ own_account: 652, write: 29, paused: 12 });
    expect(head.source).toContain("describe pass 2026-10-27");
    expect(head.note).toContain("Field TYPES in examples can differ from live calls");
  });
});

describe("the typed catalog (no network)", () => {
  const catalog = loadTregCatalog();

  it("loads once and keeps every endpoint, with unique ids and the write list apart", () => {
    expect(catalog.count).toBe(3276);
    expect(catalog.endpoints).toHaveLength(3276);
    expect(catalog.byId.size).toBe(3276);
    expect(catalog.writeIds.size).toBe(276);
    expect(catalog.excluded).toEqual({ own_account: 652, write: 29, paused: 12 });
    expect(loadTregCatalog()).toBe(catalog);
  });

  it("no write action is in the sellable snapshot, and every endpoint of the snapshot is sellable", () => {
    for (const id of catalog.writeIds) expect(catalog.byId.has(id), id).toBe(false);
    expect(catalog.endpoints.filter((e) => !isSellable(e.id, catalog))).toEqual([]);
    expect(catalog.endpoints.filter((e) => String(e.scope).toLowerCase() === "own_account")).toEqual([]);
  });

  it("every entry carries the fields a planner needs", () => {
    for (const e of catalog.endpoints) {
      expect(typeof e.id).toBe("string");
      expect(typeof e.name).toBe("string");
      expect(["GET", "POST"]).toContain(e.method);
      expect(Array.isArray(e.inputs)).toBe(true);
      expect(Array.isArray(e.pagination)).toBe(true);
      expect(Array.isArray(e.siblings)).toBe(true);
      expect(e.id.startsWith(`${e.provider}.`)).toBe(true);
    }
  });
});

describe("isSellable", () => {
  const catalog = loadTregCatalog();
  const writeId = [...catalog.writeIds][0];

  it("a sellable endpoint is sellable", () => {
    for (const id of ["anyapi.x.user.posts", "anyapi.x.search.posts", "tikhub.tiktok.video.comments", "scrapecreators.x.v1-facebook-post-comments", "icypeas.companies.search", "treg.people.search"]) {
      expect(isSellable(id, catalog), id).toBe(true);
    }
  });

  it("a write action is never sellable (all 276)", () => {
    for (const id of catalog.writeIds) expect(isSellable(id, catalog), id).toBe(false);
    expect(describeEndpoint(writeId, catalog)).toBeNull();
  });

  it("an id the catalog does not know is not sellable (made up, own-account or paused: all were removed from the snapshot)", () => {
    for (const id of ["", "   ", "x.y.z", "anyapi.x.not-there", "treg.twitter.tweets", "tiktok-profile"]) expect(isSellable(id, catalog), id).toBe(false);
  });

  it("an endpoint whose scope is own_account is not sellable even when it is in a snapshot", () => {
    const small = parseCatalog({ source: "t", count: 1, excluded: { own_account: 0, write: 0, paused: 0 }, endpoints: [{ id: "p.a", provider: "p", scope: "own_account", inputs: [], pagination: [], siblings: [] }] }, []);
    expect(isSellable("p.a", small)).toBe(false);
    const open = parseCatalog({ endpoints: [{ id: "p.a", provider: "p", scope: "any_account", inputs: [], pagination: [], siblings: [] }] }, [{ id: "p.a" }]);
    expect(isSellable("p.a", open)).toBe(false); // on the write list wins
  });

  it("a snapshot with a duplicate id or no list is refused", () => {
    expect(() => parseCatalog({ endpoints: [{ id: "a" }, { id: "a" }] }, [])).toThrow(/duplicate/);
    expect(() => parseCatalog({}, [])).toThrow(/no endpoints/);
  });
});

describe("describeEndpoint", () => {
  const catalog = loadTregCatalog();

  it("returns the whole entry of a sellable endpoint: inputs, cost, observed stats, paths, example", () => {
    const e = describeEndpoint("anyapi.x.user.posts", catalog)!;
    expect(e.method).toBe("POST");
    expect(e.inputs.map((i) => [i.name, i.required])).toEqual([["cursor", false], ["handle", true], ["limit", false]]);
    expect(e.cost).toMatchObject({ unit: "call", usd: 0.0005 });
    expect(endpointCostUsd(e)).toBe(0.0005);
    expect(e.list_path).toBe("output.data.tweets");
    expect(e.cursor_path).toBeNull(); // the file says null; the real cursor sits at output.data.nextCursor (see the shape reader)
    expect(Object.keys(e.item_fields!)).toContain("createdUtc");
    expect(e.item_fields!.isReply.type).toBe("boolean");
    expect(e.example_response_trimmed).toBeTruthy();
  });

  it("the catalog example of anyapi.x.user.posts has NO author field, while the live rows carry authorHandle: the example is not the live shape", () => {
    const e = describeEndpoint("anyapi.x.user.posts", catalog)!;
    expect(Object.keys(e.item_fields!)).not.toContain("authorHandle");
    expect(Object.keys(e.item_fields!).some((k) => /author/i.test(k))).toBe(false);
  });

  it("a routed endpoint states its price as a range in a note, with cost 0", () => {
    const e = describeEndpoint("treg.people.search", catalog)!;
    expect(e.kind).toBe("routed");
    expect(endpointCostUsd(e)).toBe(0);
    expect(e.cost!.billing_note).toContain("misses are billed too");
  });

  it("unknown ids give null", () => {
    expect(describeEndpoint("nope.nope", catalog)).toBeNull();
  });
});

describe("catalogSearch", () => {
  const catalog = loadTregCatalog();

  it("by platform and words: the X post search comes first for «search posts» on x", () => {
    const hits = catalogSearch({ platform: "x", words: ["search", "posts"], limit: 10 }, catalog);
    expect(hits.map((h) => h.id)).toContain("anyapi.x.search.posts");
    expect(hits.every((h) => h.platform === "x")).toBe(true);
    expect(hits[0].score).toBeGreaterThan(0);
    expect(hits).toEqual([...hits].sort((a, b) => b.score - a.score));
  });

  it("among endpoints of equal relevance the cheaper call comes first, and a price of 0 (a routed range) does not count as cheap", () => {
    const entry = (id: string, usd: number) => ({ id, provider: id.split(".")[0], platform: "x", name: "posts", capability: "x.posts", summary: "", method: "POST", inputs: [], pagination: [], siblings: [], scope: "any_account", tier: "core", kind: "direct", cost: { usd, unit: "call" }, observed: { ok_rate: 1, samples: 10 } });
    const small = parseCatalog({ endpoints: [entry("a.dear", 0.002), entry("b.routed", 0), entry("c.cheap", 0.0005)] }, []);
    expect(catalogSearch({ platform: "x", words: ["posts"] }, small).map((h) => h.id)).toEqual(["c.cheap", "a.dear", "b.routed"]);
  });

  it("TikTok video comments are found with their required input and price", () => {
    const hit = catalogSearch({ platform: "tiktok", words: ["comments"], limit: 20 }, catalog).find((h) => h.id === "tikhub.tiktok.video.comments")!;
    expect(hit).toBeDefined();
    expect(hit.requiredInputs).toEqual(["aweme_id"]);
    expect(hit.costUsd).toBe(0.001);
    expect(hit.observedOkRate).toBeGreaterThan(0.99);
  });

  it("never returns a write action, however the words are chosen", () => {
    const words = [...catalog.writeIds].slice(0, 40).flatMap((id) => id.split(/[.-]/));
    for (const w of words.slice(0, 40)) for (const h of catalogSearch({ words: [w], limit: 50 }, catalog)) expect(catalog.writeIds.has(h.id)).toBe(false);
  });

  it("a platform written in capitals or with a hamza spelling is read the same; a limit is respected; an unknown word finds nothing", () => {
    expect(catalogSearch({ platform: "X", words: ["posts"], limit: 3 }, catalog)).toHaveLength(3);
    expect(catalogSearch({ platform: "TikTok", words: ["comments"], limit: 2 }, catalog).length).toBeLessThanOrEqual(2);
    expect(catalogSearch({ words: ["zzzzqqqq"] }, catalog)).toEqual([]);
  });

  it("is deterministic", () => {
    const a = catalogSearch({ words: ["companies", "search"], limit: 10 }, catalog).map((h) => h.id);
    const b = catalogSearch({ words: ["companies", "search"], limit: 10 }, catalog).map((h) => h.id);
    expect(a).toEqual(b);
    expect(a.length).toBe(10);
  });
});
