import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { chooseResultList, coerceRow, findCursorPaths, findListPaths, getPath, hintsOf, missionPageOf, readShape } from "../src/lib/treg/shapeReader";
import { buildShapeDigest } from "../src/lib/modelPlanner/digest";
import { extractAndFlattenRows } from "../src/functions/shared/multiStepWorker";
import { findProviderNextCursor } from "../src/lib/server/providerRows";
import { rowIdentity } from "../src/lib/server/retryReuse";
import { isReplyRow } from "../src/lib/server/researchRelevanceGate";

const catalog = loadTregCatalog();
const real = JSON.parse(readFileSync("tests/fixtures/replay/real-rows_anyapi.x.user.posts.json", "utf-8"));

describe("paths", () => {
  const body = { output: { data: { tweets: [{ id: "1" }], nextCursor: "abc" } }, tasks: [{ result: [{ a: 1 }] }] };
  it("reads a dotted path, an array index and «root»", () => {
    expect(getPath(body, "output.data.nextCursor")).toBe("abc");
    expect(getPath(body, "tasks.0.result")).toEqual([{ a: 1 }]);
    expect(getPath([{ a: 1 }], "root")).toEqual([{ a: 1 }]);
    expect(getPath(body, "output.nope.x")).toBeUndefined();
    expect(getPath(body, "")).toBeUndefined();
    expect(getPath(body, null)).toBeUndefined();
  });

  it("finds every list of objects in an example and picks the result list: a known list name, then the shallowest", () => {
    const example = { usage: { lines: [{ about: "x" }] }, rows: [{ id: 1, text: "a" }] };
    expect(findListPaths(example).map((p) => p.path).sort()).toEqual(["rows", "usage.lines"]);
    expect(chooseResultList(findListPaths(example))).toBe("rows");
    expect(chooseResultList([])).toBeNull();
  });
});

describe("the list: catalog path, then the example's structure, then the common keys, then a single object", () => {
  it("1. the catalog's list_path wins", () => {
    const r = readShape({ output: { data: { tweets: [{ id: "1" }, { id: "2" }] } } }, { listPath: "output.data.tweets" });
    expect(r.listStrategy).toBe("list_path");
    expect(r.listPath).toBe("output.data.tweets");
    expect(r.rows).toHaveLength(2);
  });

  it("an empty list at the catalog's path is a valid empty page, not a failure", () => {
    const r = readShape({ data: { comments: [] } }, { listPath: "data.comments" });
    expect(r.listStrategy).toBe("list_path");
    expect(r.rows).toEqual([]);
  });

  it("«root»: the answer is the list", () => {
    expect(readShape([{ a: 1 }, { a: 2 }], { listPath: "root" }).rows).toHaveLength(2);
  });

  it("2. a path the catalog got wrong is replaced by where its own example holds the list", () => {
    const example = { output: { data: { items: [{ id: "x" }] } } };
    const r = readShape({ output: { data: { items: [{ id: "1" }, { id: "2" }] } } }, { listPath: "NOT FOUND", example });
    expect(r.listStrategy).toBe("example");
    expect(r.listPath).toBe("output.data.items");
    expect(r.rows).toHaveLength(2);
  });

  it("a list_path that is not a list in THIS answer is reported and the next rule is tried", () => {
    const r = readShape({ rows: [{ id: "1" }] }, { listPath: "output.data.tweets" });
    expect(r.listStrategy).toBe("common_keys");
    expect(r.rows).toHaveLength(1);
    expect(r.warnings[0]).toContain("output.data.tweets");
  });

  it("3. common keys, a few levels deep, under any envelope", () => {
    expect(readShape({ ok: true, rows: [{ id: "1" }] }).listPath).toBe("rows");
    expect(readShape({ data: { result: { comments: [{ id: "1" }] } } }).listPath).toBe("data.result.comments");
    expect(readShape({ success: true, total: 3, leads: [{ id: "1" }] }).listPath).toBe("leads");
    expect(readShape({ data: { weird: [{ id: "1" }] } }).rows).toHaveLength(1); // any list of objects at an envelope level
  });

  it("4. one object under data / user / profile is one row", () => {
    const r = readShape({ code: 0, data: { id: "7", name: "a" } }, { listPath: "NOT FOUND" });
    expect(r.listStrategy).toBe("single_object");
    expect(r.rows).toEqual([{ id: "7", name: "a" }]);
  });

  it("nothing recognisable is none, with no rows (never invented)", () => {
    for (const body of [null, undefined, "text", 5, [], {}, { message: "rate limited" }]) {
      const r = readShape(body as any, {});
      expect(r.rows).toEqual([]);
    }
    expect(readShape({ message: "rate limited" }).listStrategy).toBe("none");
  });

  it("a list of plain strings is not a list of rows", () => {
    expect(readShape({ urls: ["https://a", "https://b"] }, {}).rows).toEqual([]);
  });
});

describe("the cursor: never trust cursor_path alone", () => {
  it("anyapi.x.user.posts: the file says cursor_path null; the cursor sits at output.data.nextCursor and is found from the example", () => {
    const e = catalog.byId.get("anyapi.x.user.posts")!;
    expect(e.cursor_path).toBeNull();
    const r = readShape({ output: { data: { nextCursor: "next-123", tweets: [{ id: "1" }] } } }, hintsOf(e));
    expect(r.nextCursor).toBe("next-123");
    expect(r.cursorPath).toBe("output.data.nextCursor");
    expect(r.cursorStrategy).toBe("example");
    expect(r.cursorKind).toBe("token");
  });

  it("the catalog's cursor_path is used when it is right", () => {
    const e = catalog.byId.get("tikhub.tiktok.video.comments")!;
    const r = readShape({ data: { comments: [{ cid: "1" }], cursor: 20, has_more: 1 } }, hintsOf(e));
    expect(r.cursorStrategy).toBe("cursor_path");
    expect(r.nextCursor).toBe("20");
    expect(r.cursorKind).toBe("offset");
    expect(r.hasMore).toBe(true);
  });

  it("a cursor_path that points at a boolean flag («data.has_more») is NOT a cursor", () => {
    const r = readShape({ data: { comments: [{ cid: "1" }], has_more: true, cursor: "tok" } }, { listPath: "data.comments", cursorPath: "data.has_more" });
    expect(r.cursorPath).toBe("data.cursor");
    expect(r.nextCursor).toBe("tok");
    expect(r.cursorStrategy).toBe("common_keys");
  });

  it("a cursor beside has_more false is a position, not a next page", () => {
    const r = readShape({ data: { comments: [{ cid: "1" }], cursor: 40, has_more: false } }, { listPath: "data.comments", cursorPath: "data.cursor" });
    expect(r.nextCursor).toBeNull();
    expect(r.hasMore).toBe(false);
  });

  it("«has_more» written as the text «False» is read as false", () => {
    expect(readShape({ rows: [{ id: "1" }], cursor: "abc", has_more: "False" }).nextCursor).toBeNull();
  });

  it("a masked placeholder is not a cursor (the catalog example of the Facebook comments service holds «<omitted: expires>»)", () => {
    const e = catalog.byId.get("scrapecreators.x.v1-facebook-post-comments")!;
    expect(readShape(e.example_response_trimmed, hintsOf(e)).nextCursor).toBeNull();
    expect(readShape({ rows: [{ id: "1" }], cursor: "<omitted: expires>" }).nextCursor).toBeNull();
  });

  it("the echo of the request is not a next cursor (params.offset is what was SENT)", () => {
    const body = { params: { offset: "953154282154098691", count: "5" }, data: { items: [{ id: "1" }] } };
    expect(findCursorPaths(body)).toEqual([]);
    expect(readShape(body, { listPath: "data.items", example: body }).nextCursor).toBeNull();
  });

  it("a next-page ADDRESS is labelled «url», so nobody sends it back as a parameter", () => {
    const r = readShape({ organic_results: [{ title: "a" }], pagination: { next: "https://www.bing.com/search?q=x&first=11" } });
    expect(r.cursorKind).toBe("url");
  });

  it("no cursor at all is null", () => {
    expect(readShape({ rows: [{ id: "1" }] }).nextCursor).toBeNull();
    expect(readShape({ rows: [{ id: "1" }], cursor: "" }).nextCursor).toBeNull();
    expect(readShape({ rows: [{ id: "1" }], cursor: "null" }).nextCursor).toBeNull();
  });
});

describe("types: tolerant, never a guess", () => {
  const itemFields = { isReply: { type: "boolean" }, createdUtc: { type: "number" }, likes: { type: "number" }, id: { type: "string" }, isPinned: { type: "null" } };

  it("reads the live text forms as the catalog declares them", () => {
    const counts: Record<string, number> = {};
    const row = coerceRow({ isReply: "True", createdUtc: "1792308962", likes: "12", id: 2101118004087886, isPinned: "False", extra: "keep" }, itemFields, counts);
    expect(row.isReply).toBe(true);
    expect(row.createdUtc).toBe(1792308962);
    expect(row.likes).toBe(12);
    expect(row.id).toBe("2101118004087886");
    expect(row.isPinned).toBe(false); // the example had null: the NAME decides
    expect(row.extra).toBe("keep");
    expect(counts).toMatchObject({ isReply: 1, createdUtc: 1, likes: 1, id: 1, isPinned: 1 });
  });

  it("real values are untouched, and «False» is false (not true)", () => {
    expect(coerceRow({ isReply: false, createdUtc: 1792308962 }, itemFields)).toEqual({ isReply: false, createdUtc: 1792308962 });
    expect(coerceRow({ isReply: "False" }, itemFields).isReply).toBe(false);
  });

  it("a value that cannot be read as declared stays exactly as it came, and is counted", () => {
    const bad: Record<string, number> = {};
    const row = coerceRow({ isReply: "maybe", createdUtc: "soon", likes: "1.2K" }, itemFields, {}, bad);
    expect(row).toEqual({ isReply: "maybe", createdUtc: "soon", likes: "1.2K" });
    expect(bad).toEqual({ isReply: 1, createdUtc: 1, likes: 1 });
  });

  it("a number beyond the safe integers is not turned into a (wrong) number", () => {
    expect(coerceRow({ likes: "9007199254740993" }, itemFields).likes).toBe("9007199254740993");
  });

  it("with no declared type, the name of a field decides, for flags, counts and Unix times only", () => {
    const row = coerceRow({ isVerified: "True", viewCount: "1,250", postedAt: "1792308962", date: "2026-10-18", format: "1", name: "True" }, null);
    expect(row).toEqual({ isVerified: true, viewCount: 1250, postedAt: 1792308962, date: "2026-10-18", format: "1", name: "True" });
  });

  it("null and missing values stay as they are", () => {
    expect(coerceRow({ isReply: null, likes: undefined }, itemFields)).toEqual({ isReply: null, likes: undefined });
  });
});

describe("the REAL anyapi.x.user.posts rows (all strings), read by the module alone", () => {
  const e = catalog.byId.get("anyapi.x.user.posts")!;
  const reading = readShape(real.pages[0], hintsOf(e));

  it("finds the ten rows (the stored envelope is {ok, rows}: the catalog path is wrong for it, the common keys find the list)", () => {
    expect(reading.rows).toHaveLength(10);
    expect(reading.listStrategy).toBe("common_keys");
    expect(reading.listPath).toBe("rows");
    expect(reading.warnings[0]).toContain("output.data.tweets");
  });

  it("reads «True»/«False» as booleans, Unix seconds as numbers, counts as numbers; keeps the author handle as written", () => {
    const own = reading.rows[0];
    const reply = reading.rows[1];
    expect(own.isReply).toBe(false);
    expect(reply.isReply).toBe(true);
    expect(typeof own.createdUtc).toBe("number");
    expect(own.createdUtc).toBe(1792308962);
    expect(own.likes).toBe(10);
    expect(own.authorHandle).toBe("elonmusk");
    expect(own.isPinned).toBe(false);
  });

  it("the gate's reply reader gives the same answer on the module's rows as on the raw rows", () => {
    const raw = real.pages[0].rows as Array<Record<string, unknown>>;
    expect(reading.rows.map((r) => isReplyRow(r as any))).toEqual(raw.map((r) => isReplyRow(r as any)));
  });
});

/**
 * Same rows as the hand-written readers read today: the count, the identity of each row and every top-level scalar value. The hand reader FLATTENS one level
 * (`user: {nickname}` becomes `user_nickname`, a nested object becomes JSON text, null becomes an empty text); the module returns the row as it came, nested.
 * Those differences are the flattening, not a different row, and are not counted.
 */
function sameRows(handRows: Array<Record<string, any>>, moduleRows: Array<Record<string, any>>): string[] {
  const problems: string[] = [];
  if (handRows.length !== moduleRows.length) return [`count: hand ${handRows.length}, module ${moduleRows.length}`];
  const nestedPrefixOf = (mod: Record<string, any>, key: string) => Object.keys(mod).some((p) => key.startsWith(`${p}_`) && typeof mod[p] === "object" && mod[p] !== null);
  handRows.forEach((hand, i) => {
    const mod = moduleRows[i];
    // the identity of a nested row differs only because flattening promotes `company.name` to `company_name` (a key the identity reader takes for the row's name)
    const flat = Object.values(mod).every((v) => typeof v !== "object" || v === null);
    if (flat && rowIdentity(hand) !== rowIdentity(mod)) problems.push(`row ${i}: identity ${rowIdentity(hand)} vs ${rowIdentity(mod)}`);
    for (const [k, v] of Object.entries(hand)) {
      if (v === "" || v === null || v === undefined) continue;
      if (!(k in mod)) { if (!nestedPrefixOf(mod, k)) problems.push(`row ${i}: «${k}» missing in the module's row`); continue; }
      if (typeof mod[k] === "object" && mod[k] !== null) continue; // flattened to text by the hand reader
      if (String(mod[k]) !== String(v) && String(mod[k]).toLowerCase() !== String(v).toLowerCase()) problems.push(`row ${i}: «${k}» ${JSON.stringify(v)} vs ${JSON.stringify(mod[k])}`);
    }
  });
  return problems;
}

describe("replay: the module ALONE against the hand-written readers, on every fixture of a service we sell today", () => {
  const FIXTURES: Array<[label: string, body: unknown, endpointId: string]> = [
    ["real rows · anyapi.x.user.posts", real.pages[0], "anyapi.x.user.posts"],
    ["catalog example · anyapi.x.user.posts", catalog.byId.get("anyapi.x.user.posts")!.example_response_trimmed, "anyapi.x.user.posts"],
    ["catalog example · anyapi.x.search.posts", catalog.byId.get("anyapi.x.search.posts")!.example_response_trimmed, "anyapi.x.search.posts"],
    ["catalog example · tikhub.tiktok.video.comments", catalog.byId.get("tikhub.tiktok.video.comments")!.example_response_trimmed, "tikhub.tiktok.video.comments"],
    ["catalog example · crawl4ai.tiktok.video.comments", catalog.byId.get("crawl4ai.tiktok.video.comments")!.example_response_trimmed, "crawl4ai.tiktok.video.comments"],
    ["catalog example · crawl4ai.youtube.video.comments", catalog.byId.get("crawl4ai.youtube.video.comments")!.example_response_trimmed, "crawl4ai.youtube.video.comments"],
    ["catalog example · scrapecreators.x.v1-facebook-post-comments", catalog.byId.get("scrapecreators.x.v1-facebook-post-comments")!.example_response_trimmed, "scrapecreators.x.v1-facebook-post-comments"],
    ["catalog example · icypeas.companies.search", catalog.byId.get("icypeas.companies.search")!.example_response_trimmed, "icypeas.companies.search"],
    ["catalog example · icypeas.people.search", catalog.byId.get("icypeas.people.search")!.example_response_trimmed, "icypeas.people.search"],
    ["catalog example · blitzapi.jobs.search", catalog.byId.get("blitzapi.jobs.search")!.example_response_trimmed, "blitzapi.jobs.search"],
  ];

  it.each(FIXTURES)("rows: %s", (_label, body, endpointId) => {
    const hand = extractAndFlattenRows(body as any);
    const mod = readShape(body, hintsOf(catalog.byId.get(endpointId)!)).rows;
    // the module returns the rows as they are nested; the hand reader flattens one level (parent_child): compare the top-level values
    expect(sameRows(hand, mod), `${_label}`).toEqual([]);
  });

  it("the routed wrappers (treg.people.search, treg.companies.search) have no example: both readers find nothing", () => {
    for (const id of ["treg.people.search", "treg.companies.search"]) {
      const e = catalog.byId.get(id)!;
      expect(e.example_response_trimmed).toBeNull();
      expect(readShape(e.example_response_trimmed, hintsOf(e)).rows).toEqual([]);
      expect(extractAndFlattenRows(e.example_response_trimmed as any)).toEqual([]);
    }
  });

  // THE MISMATCHES (cursors). The rows are the same everywhere above; the cursors differ in exactly these cases.
  it("MISMATCH 1: the hand-written reader takes the masked placeholder «<omitted: expires>» of the Facebook comments example for a cursor; the module does not", () => {
    const e = catalog.byId.get("scrapecreators.x.v1-facebook-post-comments")!;
    expect(findProviderNextCursor(e.example_response_trimmed)).toBe("<omitted: expires>");
    expect(readShape(e.example_response_trimmed, hintsOf(e)).nextCursor).toBeNull();
  });

  it("MISMATCH 2: the module finds pagination.token of the Icypeas company and people searches; the generic hand-written reader finds none (their own parser reads it)", () => {
    for (const id of ["icypeas.companies.search", "icypeas.people.search"]) {
      const e = catalog.byId.get(id)!;
      expect(findProviderNextCursor(e.example_response_trimmed)).toBeNull();
      const r = readShape(e.example_response_trimmed, hintsOf(e));
      expect(r.cursorPath).toBe("pagination.token");
      expect(r.nextCursor).toMatch(/^eyJ/);
    }
  });

  it("the cursors agree on X posts, X account posts and TikTok comments", () => {
    for (const id of ["anyapi.x.search.posts", "anyapi.x.user.posts", "tikhub.tiktok.video.comments"]) {
      const e = catalog.byId.get(id)!;
      expect(readShape(e.example_response_trimmed, hintsOf(e)).nextCursor).toBe(findProviderNextCursor(e.example_response_trimmed));
    }
  });

  it("no cursor on the crawl4ai comment services, on the jobs source's example or on the real X fixture, in either reader", () => {
    for (const id of ["crawl4ai.tiktok.video.comments", "crawl4ai.youtube.video.comments", "blitzapi.jobs.search"]) {
      const e = catalog.byId.get(id)!;
      expect(readShape(e.example_response_trimmed, hintsOf(e)).nextCursor).toBeNull();
      expect(findProviderNextCursor(e.example_response_trimmed)).toBeNull();
    }
    expect(readShape(real.pages[0], hintsOf(catalog.byId.get("anyapi.x.user.posts")!)).nextCursor).toBeNull();
  });
});

describe("the whole snapshot: every example answer is read without an error, and the catalog's own list paths are found", () => {
  const withExample = catalog.endpoints.filter((e) => e.example_response_trimmed !== null && e.example_response_trimmed !== undefined);

  it("2,337 endpoints have an example answer", () => {
    expect(withExample).toHaveLength(2337);
  });

  it("reading never throws and never returns a row that is not an object", () => {
    for (const e of withExample) {
      const r = readShape(e.example_response_trimmed, hintsOf(e));
      expect(Array.isArray(r.rows)).toBe(true);
      for (const row of r.rows) expect(typeof row).toBe("object");
    }
  });

  it("the catalog's list_path is found by that path for 1,265 of the 1,274 endpoints that give one; the other nine are listed", () => {
    const withPath = withExample.filter((e) => e.list_path && e.list_path !== "NOT FOUND");
    expect(withPath).toHaveLength(1274);
    const notByPath = withPath.filter((e) => readShape(e.example_response_trimmed, hintsOf(e)).listStrategy !== "list_path").map((e) => e.id).sort();
    expect(notByPath).toEqual([
      "adyntel.meta-ads.library.search", "aiark.people.phone.find", "coingecko.coins.market-chart", "contactout.companies.enrich",
      "influencersclub.creators.post.details", "justoneapi.x.taobao-get-social-feed-v1", "pdl.people.enrich", "sixtyfour.people.email.find.personal", "sixtyfour.people.email.find.work",
    ]);
  });

  it("where the file says «NOT FOUND», the module still finds rows for 725 of 1,063 endpoints (338 hold no list or object to read)", () => {
    const notFound = withExample.filter((e) => e.list_path === "NOT FOUND");
    expect(notFound).toHaveLength(1063);
    const withRows = notFound.filter((e) => readShape(e.example_response_trimmed, hintsOf(e)).rows.length > 0);
    expect(withRows).toHaveLength(725);
  });
});

const routedEnvelope = {
  output: {
    full_name: "Lina Mansour",
    first_name: "Lina",
    last_name: "Mansour",
    title: "VP Product",
    company: "Nile Labs",
    company_domain: "nilelabs.example",
    linkedin_url: "https://www.linkedin.com/in/lina-mansour-demo",
    location: "Cairo, Egypt",
  },
  raw: {
    data: {
      company: { domain: "wrong-raw.example", industry: "Software", name: "Wrong Raw Co" },
      first_name: "Wrong",
      id: "p_01",
      insight: { decision_role: "exec", department: "product", location: "Wrong Raw City", seniority: "vp", summary: "Synthetic", topics: ["a", "b", "c"] },
      last_name: "Raw",
      linkedin: "wrong",
      linkedin_url: "https://www.linkedin.com/in/wrong-raw",
      location: { city: "Alex", country_code: "ZZ" },
      name: "Wrong Raw",
      title: "Wrong Raw Title",
    },
    meta: { took_ms: 42 },
  },
  _treg: {
    served_by: "crawl4ai.people.enrich",
    provider: "crawl4ai",
    tier: "core",
    outcome: "hit",
    tried: [{ endpoint_id: "crawl4ai.people.enrich", provider: "crawl4ai", outcome: "hit", status: 200, charged_micro: 950 }],
    charged_micro: 950,
    dropped: [{ endpoint_id: "p1", why: "cap" }],
  },
};

describe("routedOutputOnly (D-0215 R2 opt-in & K3 isolation)", () => {

  it("T5 & K3: default hintsOf leaves customer/default reading unchanged; routedOutputOnly reads strictly from output and ignores raw/_treg", () => {
    const endpoint = catalog.byId.get("treg.people.enrich")!;
    const explicitFalseRead = readShape(routedEnvelope, { ...hintsOf(endpoint), routedOutputOnly: false });
    expect(explicitFalseRead.listPath).toBe("_treg.tried");
    expect(explicitFalseRead.listStrategy).toBe("inferred_list");

    const defaultRead = readShape(routedEnvelope, hintsOf(endpoint));
    expect(defaultRead.listPath).toBe("output");
    expect(defaultRead.listStrategy).toBe("single_object");
    expect(defaultRead.rows).toEqual([routedEnvelope.output]);

    const withRawContacts = {
      ...routedEnvelope,
      raw: { ...routedEnvelope.raw, data: { ...routedEnvelope.raw.data, emails: [{ email: "leak@raw.example", type: "work" }], phones: [{ phone: "+201099999999" }] } },
    };
    const isolatedRead = readShape(withRawContacts, { ...hintsOf(endpoint), routedOutputOnly: true });
    expect(isolatedRead.listPath).toBe("output");
    expect(isolatedRead.rows).toEqual([routedEnvelope.output]);

    const nullOutput = readShape({ output: null, raw: withRawContacts.raw, _treg: routedEnvelope._treg }, { ...hintsOf(endpoint), routedOutputOnly: true });
    expect(nullOutput.rows).toEqual([]);
    expect(nullOutput.listStrategy).toBe("none");

    const listOutput = readShape({ output: { items: [{ full_name: "Lina Mansour" }] }, raw: withRawContacts.raw, _treg: routedEnvelope._treg }, { routedOutputOnly: true });
    expect(listOutput.listPath).toBe("output.items");
    expect(listOutput.rows).toEqual([{ full_name: "Lina Mansour" }]);

    const arrayOutput = readShape({ output: [{ full_name: "Lina Mansour" }], raw: withRawContacts.raw, _treg: routedEnvelope._treg }, { routedOutputOnly: true });
    expect(arrayOutput.listPath).toBe("output");
    expect(arrayOutput.listStrategy).toBe("list_path");
    expect(arrayOutput.rows).toEqual([{ full_name: "Lina Mansour" }]);
  });
});

describe("DT-20261125-customer-treg-reader: shared routed rule (M1–M7, K1–K3, D5)", () => {
  const routedCommentsEp = catalog.byId.get("treg.youtube.video.comments")!;
  const routedPostsEp = catalog.byId.get("treg.x.search.posts")!;
  const routedFbPostsEp = catalog.byId.get("treg.facebook.user.posts")!;
  const routedFbCommentsEp = catalog.byId.get("treg.facebook.post.comments")!;
  const routedAmazonEp = catalog.byId.get("treg.amazon.search.products")!;
  const routedYoutubeSearchEp = catalog.byId.get("treg.youtube.search.videos")!;
  const directEp = catalog.endpoints.find((e) => e.kind === "direct")!;

  const shapeA = {
    output: { comments: null, next_cursor: null },
    raw: null,
    _treg: {
      served_by: null,
      outcome: "empty",
      tried: [{ endpoint_id: "ep_a", provider: "prov_a", outcome: "empty", status: 200, charged_micro: 100 }],
      charged_micro: 100,
      dropped: [{ endpoint_id: "ep_b", why: "cap" }, { endpoint_id: "ep_c", why: "policy" }],
    },
  };

  const shapeAWithMeta = {
    output: { video_id: "v_1", comments: null, next_cursor: null },
    raw: null,
    _treg: shapeA._treg,
  };

  const shapeB = {
    output: { posts: null, next_cursor: null },
    raw: null,
    _treg: {
      served_by: null,
      outcome: "empty",
      tried: [1, 2, 3].map((n) => ({ endpoint_id: `ep_${n}`, provider: `prov_${n}`, outcome: "empty", status: 200, charged_micro: 50 })),
      charged_micro: 150,
      dropped: [{ endpoint_id: "ep_d", why: "cap" }],
    },
  };

  const shapeC = {
    output: { comments: [], next_cursor: null },
    raw: null,
    _treg: {
      served_by: null,
      outcome: "empty",
      tried: [{ endpoint_id: "ep_a", provider: "prov_a", outcome: "empty", status: 200, charged_micro: 0 }],
      charged_micro: 0,
      dropped: [{ endpoint_id: "ep_b", why: "cap" }],
    },
  };

  const shapeD = (n: number, nextCursor: string | null) => ({
    output: {
      posts: Array.from({ length: n }, (_, i) => ({ id: `p_${i + 1}`, text: `Synthetic post ${i + 1}`, author: `user_${i + 1}` })),
      next_cursor: nextCursor,
    },
    raw: {
      output: { data: { posts: [{ id: "raw_only" }] }, found: true },
      provider: "prov_a",
      costUsd: 0.001,
      items: n,
      replayed: false,
      source: { id: "s1", name: "src", kind: "social", artworkKey: "k1" },
      resultId: "r1",
    },
    _treg: {
      served_by: "ep_a",
      provider: "prov_a",
      tier: "core",
      outcome: "hit",
      tried: [{ endpoint_id: "ep_a", provider: "prov_a", outcome: "hit", status: 200, charged_micro: 750 }],
      charged_micro: 750,
    },
  });

  const shapeE = (n: number) => ({
    output: {
      products: Array.from({ length: n }, (_, i) => ({ asin: `ASIN_${i + 1}`, title: `Product ${i + 1}`, price: 10 + i })),
      count: n,
    },
    raw: {
      code: 200,
      data: {
        total_products: n,
        country: "US",
        domain: "example.com",
        products: Array.from({ length: n }, (_, i) => ({ asin: `RAW_${i + 1}` })),
      },
      message: null,
      recordTime: "2026-11-25T00:00:00Z",
      requestId: "req_1",
      requestParams: { query: { q: "desk" }, body: null },
    },
    _treg: {
      served_by: "ep_a",
      provider: "prov_a",
      tier: "core",
      outcome: "hit",
      tried: [{ endpoint_id: "ep_a", provider: "prov_a", outcome: "hit", status: 200, charged_micro: 1476 }],
      charged_micro: 1476,
    },
  });

  const shapeF = { detail: "upstream timeout" };

  it("M1: Shape A & Shape A with meta yield 0 rows and none strategy under hintsOf and buildShapeDigest", () => {
    const readA = readShape(shapeA, hintsOf(routedCommentsEp));
    expect(readA.rows).toEqual([]);
    expect(readA.nextCursor).toBeNull();
    expect(readA.listStrategy).toBe("none");
    const digestA = buildShapeDigest(shapeA, routedCommentsEp).reading;
    expect(digestA.rows).toEqual([]);
    expect(digestA.nextCursor).toBeNull();
    expect(digestA.listStrategy).toBe("none");

    const readAMeta = readShape(shapeAWithMeta, hintsOf(routedCommentsEp));
    expect(readAMeta.rows).toEqual([]);
    expect(readAMeta.nextCursor).toBeNull();
    expect(readAMeta.listStrategy).toBe("none");
    const digestAMeta = buildShapeDigest(shapeAWithMeta, routedCommentsEp).reading;
    expect(digestAMeta.rows).toEqual([]);
    expect(digestAMeta.nextCursor).toBeNull();
    expect(digestAMeta.listStrategy).toBe("none");
  });

  it("M2: Shape B yields 0 rows and none strategy under hintsOf and buildShapeDigest", () => {
    const readB = readShape(shapeB, hintsOf(routedFbPostsEp));
    expect(readB.rows).toEqual([]);
    expect(readB.listStrategy).toBe("none");
    const digestB = buildShapeDigest(shapeB, routedFbPostsEp).reading;
    expect(digestB.rows).toEqual([]);
    expect(digestB.listStrategy).toBe("none");
  });

  it("M3: Shape C yields empty rows array under output.comments with null nextCursor", () => {
    const readC = readShape(shapeC, hintsOf(routedFbCommentsEp));
    expect(readC.rows).toEqual([]);
    expect(readC.listPath).toBe("output.comments");
    expect(readC.nextCursor).toBeNull();
  });

  it("M4: Shape D matches output-only reading for n=1 and n=9", () => {
    for (const n of [1, 9]) {
      const sD = shapeD(n, "cur_next");
      const readD = readShape(sD, hintsOf(routedPostsEp));
      const expected = readShape({ output: sD.output }, {});
      expect(readD.rows).toEqual(expected.rows);
      expect(readD.listPath).toBe("output.posts");
      expect(readD.nextCursor).toBe("cur_next");
      expect(readD.cursorPath).toBe("output.next_cursor");
    }
  });

  it("M5: Shape E returns output products for n=16 and n=48", () => {
    for (const n of [16, 48]) {
      const sE = shapeE(n);
      const readE = readShape(sE, hintsOf(routedAmazonEp));
      expect(readE.rows).toEqual(sE.output.products);
      expect(readE.listPath).toBe("output.products");
    }
  });

  it("M6: treg.people.enrich returns output only without raw/_treg leakage", () => {
    const readM6 = readShape(routedEnvelope, hintsOf(catalog.byId.get("treg.people.enrich")!));
    expect(readM6.rows).toEqual([routedEnvelope.output]);
    for (const key of ["raw", "_treg", "tried", "dropped"]) {
      expect(readM6.rows[0]).not.toHaveProperty(key);
    }
  });

  it("M7: Shape F behaviour matches between routed and unrouted", () => {
    const readF = readShape(shapeF, hintsOf(routedYoutubeSearchEp));
    const unroutedF = readShape(shapeF, { ...hintsOf(routedYoutubeSearchEp), routedOutputOnly: false });
    expect(readF.rows).toEqual([]);
    expect(readF.listStrategy).toBe("none");
    expect(readF).toEqual(unroutedF);

    const digestF = buildShapeDigest(shapeF, routedYoutubeSearchEp).reading;
    const rootRowF = readShape(shapeF, { ...hintsOf(routedYoutubeSearchEp), routedOutputOnly: false, rootObjectIsRow: true });
    expect(digestF.rows).toEqual([shapeF]);
    expect(digestF.listPath).toBe("root");
    expect(digestF.listStrategy).toBe("root_object");
    expect(digestF).toEqual(rootRowF);
  });

  it("K1: direct endpoint behaviour is identical with hintsOf and manual hints", () => {
    const directBody = {
      output: { items: [{ id: "1" }] },
      data: { rows: [{ id: "2" }] },
    };
    const directTopLevel = [{ id: "3" }];
    const directHints = hintsOf(directEp);
    const manualHints = {
      listPath: directEp.list_path,
      cursorPath: directEp.cursor_path,
      example: directEp.example_response_trimmed,
      itemFields: directEp.item_fields,
    };
    expect(readShape(directBody, directHints).rows).toEqual(readShape(directBody, manualHints).rows);
    expect(readShape(directBody, directHints).listPath).toEqual(readShape(directBody, manualHints).listPath);
    expect(readShape(directBody, directHints).nextCursor).toEqual(readShape(directBody, manualHints).nextCursor);
    expect(readShape(directTopLevel, directHints).rows).toEqual(readShape(directTopLevel, manualHints).rows);
  });

  it("K2: missionPage declared listPath wins over routedOutputOnly", () => {
    const mp = missionPageOf("anyapi.facebook.user.posts")!;
    const body = { output: { data: { posts: [{ id: "p1" }] } } };
    const readK2 = readShape(body, { ...hintsOf(routedPostsEp), missionPage: mp });
    expect(readK2.listPath).toBe(mp.listPath);
    expect(readK2.rows).toEqual([{ id: "p1" }]);
  });

  it("K3: routed hit reads output list; routed empty object returns 0 rows", () => {
    const k3Hit = {
      output: { mentions: [{ id: "m1", text: "hi" }] },
      raw: { items: [{ id: "r1" }] },
      _treg: { tried: [{ endpoint_id: "ep_a" }] },
    };
    const readK3Hit = readShape(k3Hit, hintsOf(routedPostsEp));
    expect(readK3Hit.listPath).toBe("output.mentions");
    expect(readK3Hit.rows).toEqual([{ id: "m1", text: "hi" }]);

    const k3Empty = {
      output: { ok: true },
      raw: { items: [{ id: "r1" }] },
      _treg: { tried: [{ endpoint_id: "ep_a" }] },
    };
    const readK3Empty = readShape(k3Empty, hintsOf(routedPostsEp));
    expect(readK3Empty.rows).toEqual([]);
    expect(readK3Empty.listStrategy).toBe("none");
  });

  it("D5: cursor is read from output only; raw and _treg cursor leaks are ignored", () => {
    const d5Envelope = {
      output: { posts: [{ id: "1" }], next_cursor: null },
      raw: { next_cursor: "raw_leak", pagination: { next: "https://raw.example/2" } },
      _treg: { cursor: "treg_leak" },
    };
    const readD5 = readShape(d5Envelope, hintsOf(routedPostsEp));
    expect(readD5.nextCursor).toBeNull();
    expect(readD5.cursorPath).toBeNull();
    expect(readD5.cursorStrategy).toBe("none");
  });

  it("C1: isEmptyOrErrorRoutedObject counts payload fields only when non-empty", () => {
    const c1NullMentions = readShape({ output: { mentions: null, next_cursor: null } }, hintsOf(routedPostsEp));
    expect(c1NullMentions.rows).toEqual([]);
    expect(c1NullMentions.listStrategy).toBe("none");

    const c1Email = readShape({ output: { email: "a@b.com" } }, hintsOf(catalog.byId.get("treg.people.enrich")!));
    expect(c1Email.rows).toEqual([{ email: "a@b.com" }]);
    expect(c1Email.listStrategy).toBe("single_object");

    const c1NullFields = readShape({ output: { full_name: null, title: null } }, hintsOf(catalog.byId.get("treg.people.enrich")!));
    expect(c1NullFields.rows).toEqual([]);
    expect(c1NullFields.listStrategy).toBe("none");
  });
});
