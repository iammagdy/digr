import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadTregCatalog, type CatalogEndpoint, type TregCatalog } from "../src/lib/treg/catalog";
import { NO_SENSITIVE_ACCESS } from "../src/lib/treg/dataPolicy";
import { TOOL_CARDS, cardOf, mapPage } from "../src/lib/agentMission/foundation/toolCards";
import { discoverCards, deriveCard, validateChain, ROLE_RULES, ruleOfCapability, discoveryActive, SOCIAL_DISCOVERY_KEY, cardsWithDiscovery, parseSelection, modelSelector, completenessOf, deliveryCompletenessLineAr, discoveryMarkOf, discoveryNotesAr, candidateViewOf } from "../src/lib/agentMission/foundation/discovery";
import { channelEvidenceOf, channelAnswerOf, youtubeChannelChoiceQuestionAr } from "../src/lib/agentMission/foundation/discovery/channelEvidence";
import { carriedBy, chooseCard, hashtagOf, parentInputs, rankedCards } from "../src/lib/agentMission/foundation/compilePlan";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { catalogPage } from "./helpers/discoveryWorld";

/**
 * ROUND 33, CATALOG DISCOVERY: the derivation of tool cards from the catalog's own metadata, the role grammar, the chain validation, the switch, the model's choice and the customer's sentences. Every endpoint here is read from the REAL catalog snapshot (data/treg); pages written by a test
 * are SIMULATED (built from the catalog's own example envelope) and are labelled as such.
 */
const catalog = loadTregCatalog();
const ACCESS = NO_SENSITIVE_ACCESS;
const endpoint = (id: string): CatalogEndpoint => catalog.byId.get(id)!;

describe("THE TREG DISCOVERY REPORT AGAINST THE REPOSITORY SNAPSHOT (read from data/treg, not from memory)", () => {
  const REPORT = [
    "tikhub.youtube.search.videos", "tikhub.youtube.channel.videos", "tikhub.youtube.video.comments",
    "tikhub.x.instagram-v2-search-reels", "scrapecreators.x.v1-instagram-search-hashtag", "anyapi.instagram.user.posts",
  ];
  it("all six endpoints of the report are PRESENT in the sellable catalog snapshot (3,276 endpoints), none own-account, none a write action", () => {
    expect(catalog.endpoints.length).toBe(3276);
    for (const id of REPORT) { const e = catalog.byId.get(id); expect(e, id).toBeDefined(); expect(e!.scope).not.toBe("own_account"); expect(catalog.writeIds.has(id), id).toBe(false); }
  });
  it("what the repository does with each: a hand-written card (verified, or catalog_only with 0 calls ever), a card DERIVED from the catalog, or a refusal WITH A REASON", () => {
    const verdict = (id: string) => { const hand = cardOf(id); if (hand) return { by: "hand", status: hand.status, role: hand.role }; const d = deriveCard(endpoint(id), catalog, ACCESS); return d.ok ? { by: "derived", status: d.card.status, role: d.card.role } : { by: "rejected", reason: d.rejection.reason }; };
    expect(Object.fromEntries(REPORT.map((id) => [id, verdict(id)]))).toEqual({
      "tikhub.youtube.search.videos": { by: "derived", status: "catalog_only", role: "videos.search" },
      "tikhub.youtube.channel.videos": { by: "derived", status: "catalog_only", role: "videos.channel" },
      // the one production-verified tool of the six: its mapping, cursor and reply token were verified on 8 real stored pages (live round 11)
      "tikhub.youtube.video.comments": { by: "hand", status: "verified", role: "video.comments" },
      // the catalog gives the reels search no list path and no item fields (list_path «NOT FOUND», item_fields null): a mapping would be a guess, so it is refused until a real page is captured
      "tikhub.x.instagram-v2-search-reels": { by: "rejected", reason: "no_list_path" },
      "scrapecreators.x.v1-instagram-search-hashtag": { by: "derived", status: "catalog_only", role: "posts.search" },
      // never called live (0 calls ever): catalog_only on its hand-written card since round 10
      "anyapi.instagram.user.posts": { by: "hand", status: "catalog_only", role: "posts.account" },
    });
  });
  it("only ONE of the six has a stored real page in this repository (youtube.video.comments); no derived card has any", () => {
    expect(cardOf("tikhub.youtube.video.comments")!.verifiedOn.length).toBeGreaterThan(0);
    expect(cardOf("anyapi.instagram.user.posts")!.verifiedOn).toEqual([]);
    for (const p of ["youtube", "instagram"]) for (const c of discoverCards(catalog, p, ACCESS).cards) expect(c.verifiedOn, c.endpointId).toEqual([]);
  });
  it("the reels tool's catalog entry really has no list path and no fields (the evidence for the refusal)", () => {
    const e = endpoint("tikhub.x.instagram-v2-search-reels");
    expect(e.list_path).toBe("NOT FOUND");
    expect(e.item_fields).toBeNull();
  });
});

describe("EVERY CARD DERIVED FROM THE REAL CATALOG IS SAFE BY CONSTRUCTION", () => {
  const all = ["youtube", "instagram"].flatMap((p) => discoverCards(catalog, p, ACCESS).cards);
  it("there are derived cards, each catalog_only, marked derived, with no stored page, a role of the grammar, and never the endpoint of a hand-written card", () => {
    expect(all.length).toBeGreaterThanOrEqual(6);
    for (const c of all) {
      expect(c.status, c.endpointId).toBe("catalog_only");
      expect(c.derived?.from, c.endpointId).toBe("catalog");
      expect(c.verifiedOn, c.endpointId).toEqual([]);
      expect(ROLE_RULES.map((r) => r.role), c.endpointId).toContain(c.role);
      expect(TOOL_CARDS.some((h) => h.endpointId === c.endpointId), c.endpointId).toBe(false);
    }
  });
  it("each is a sellable, unblocked, priced-per-call endpoint with an id in its mapping, a declared input for every input it sends, and a chain check with no issue", () => {
    for (const c of all) {
      const e = endpoint(c.endpointId);
      expect(e.cost?.unit, c.endpointId).toBe("call");
      expect(c.costUsdPerPage, c.endpointId).toBe(e.cost!.usd);
      expect(c.mapping.kind === "fields" && c.mapping.fields.id, c.endpointId).toBeTruthy();
      expect(validateChain([c], catalog, ACCESS), c.endpointId).toEqual([]);
      expect(Number((e.observed as { samples: number }).samples), c.endpointId).toBeGreaterThanOrEqual(100);
      expect(Number((e.observed as { ok_rate: number }).ok_rate), c.endpointId).toBeGreaterThanOrEqual(0.9);
    }
  });
  it("a card's cursor input is a CURSOR: crawl4ai lists «limit» as its pagination, which only sizes one answer, so its card has no cursor and its paging is unknown", () => {
    expect(endpoint("crawl4ai.youtube.search.videos").pagination).toContain("limit");
    const card = all.find((c) => c.endpointId === "crawl4ai.youtube.search.videos")!;
    expect(card.inputs.cursor).toBeNull();
    expect(card.derived?.paging).toBe("unknown");
  });
  it("the cursor path of a listing whose catalog `cursor_path` is null is read from the catalog's own example (an account's reels: output.data.nextCursor), not guessed", () => {
    expect(endpoint("anyapi.instagram.user.reels").cursor_path).toBeNull();
    const card = all.find((c) => c.endpointId === "anyapi.instagram.user.reels")!;
    expect(card.page.cursor).toEqual(["output", "data", "nextCursor"]);
    expect(card.derived?.paging).toBe("declared");
  });
  it("a page-number pagination whose next value the catalog gives is a way to the next page (scrapecreators' reels search: pagination «page», answer field `next_page`)", () => {
    const card = all.find((c) => c.endpointId === "scrapecreators.x.v2-instagram-reels-search")!;
    expect(card.inputs.cursor).toBe("page");
    expect(card.page.cursor).toEqual(["next_page"]);
  });
  it("the grammar is DATA about the catalog's vocabulary: no platform name is written in the derivation code, and a capability the table does not list has no role", () => {
    const code = readFileSync("src/lib/agentMission/foundation/discovery/deriveCards.ts", "utf8");
    expect(code).not.toMatch(/"(?:youtube|instagram|tiktok|facebook|x)"/);
    expect(ruleOfCapability("youtube.video.captions")).toBeNull();
    expect(ruleOfCapability(null)).toBeNull();
    expect(ROLE_RULES.every((r) => typeof r.capability === "string" && /^[a-z]+\.[a-z.]+$/.test(r.capability))).toBe(true);
  });
});

describe("THE REFUSALS, each with its reason (synthetic endpoints cloned from a real one, so the cause is the only difference)", () => {
  const base = endpoint("tikhub.youtube.search.videos");
  const withCatalog = (e: CatalogEndpoint, extra: Partial<TregCatalog> = {}): TregCatalog => ({ ...catalog, ...extra, byId: new Map(catalog.byId).set(e.id, e) } as TregCatalog);
  const mutate = (id: string, patch: Partial<CatalogEndpoint>) => { const e = { ...base, id, ...patch } as CatalogEndpoint; return deriveCard(e, withCatalog(e), ACCESS); };
  it("the control: the same clone with nothing changed derives", () => { expect(mutate("t.control", {}).ok).toBe(true); });
  it.each([
    ["no_role", { capability: "youtube.video.captions" }],
    ["async", { async: { kind: "poll" } }],
    ["cost_unknown", { cost: { ...base.cost!, unit: "record" } }],
    ["cost_unknown", { cost: { ...base.cost!, usd: null } }],
    ["no_observed_evidence", { observed: { samples: 3, ok_rate: 1 } }],
    ["no_observed_evidence", { observed: null }],
    ["low_success", { observed: { samples: 5000, ok_rate: 0.6 } }],
    ["no_list_path", { list_path: "NOT FOUND" }],
    ["no_list_path", { list_path: null }],
    ["no_item_fields", { item_fields: null }],
    ["no_id_field", { item_fields: { title: { type: "string", example: "x" } } }],
    ["no_query_input", { inputs: base.inputs.filter((i) => i.name !== "keyword") }],
    ["unsatisfied_required_input", { inputs: [...base.inputs, { name: "mystery_key", in: "query", type: "string", required: true, enum: null, minimum: null, maximum: null, default: null, example: null, note: null }] }],
  ] as const)("%s", (reason, patch) => {
    const r = mutate(`t.${reason}`, patch as Partial<CatalogEndpoint>);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.rejection.reason).toBe(reason);
  });
  it("not sellable (a write action) and blocked (an own-account endpoint) are refused before anything else is read", () => {
    const e = { ...base, id: "t.write" } as CatalogEndpoint;
    expect(!deriveCard(e, withCatalog(e, { writeIds: new Set(["t.write"]) }), ACCESS).ok && (deriveCard(e, withCatalog(e, { writeIds: new Set(["t.write"]) }), ACCESS) as { rejection: { reason: string } }).rejection.reason).toBe("not_sellable");
    const own = { ...base, id: "t.own", scope: "own_account" } as CatalogEndpoint;
    expect(deriveCard(own, withCatalog(own), ACCESS).ok).toBe(false);
  });
  it("a hand-written card is never replaced by a derived one", () => {
    const hand = endpoint("anyapi.instagram.user.posts");
    const r = deriveCard(hand, catalog, ACCESS);
    expect(!r.ok && r.rejection.reason).toBe("has_hand_card");
  });
  it("a listing with no source input of the kind its role needs is refused (an endpoint that lists by URL only cannot take a handle)", () => {
    const r = deriveCard(endpoint("tikhub.instagram.user.posts"), catalog, ACCESS);
    expect(!r.ok && r.rejection.reason).toBe("no_source_input");
  });
});

describe("THE MAPPING a card derives reads the catalog's own shape and keeps what the source wrote (SIMULATED pages built from the catalog's example envelope)", () => {
  const search = discoverCards(catalog, "youtube", ACCESS).cards.find((c) => c.endpointId === "tikhub.youtube.search.videos")!;
  const page = catalogPage("tikhub.youtube.search.videos", [
    { video_id: "AAAAAAAAAAA", title: "عنوان", view_count: "14,943,780 views", published_time: "3 weeks ago", author: "قناة", channel_id: "UC1", url: "https://www.youtube.com/watch?v=AAAAAAAAAAA", duration: "1:00", thumbnails: [], description_snippet: "" },
    { video_id: "BBBBBBBBBBB", title: "عنوان ٢", view_count: "5 views", published_time: "1 day ago", author: "قناة", channel_id: "UC1", url: "https://www.youtube.com/watch?v=BBBBBBBBBBB&pp=tracking", duration: "1:00", thumbnails: [], description_snippet: "" },
  ], "next-token");
  it("one row per listed item, each with its id, its public link WITH the video id (the `?v=` is kept because the catalog's own example of the link has one), and the view count as the source wrote it (never a number read out of «14,943,780 views»)", () => {
    const rows = mapPage(search, page);
    expect(rows.map((r) => r.id)).toEqual(["AAAAAAAAAAA", "BBBBBBBBBBB"]);
    expect(rows[0].link).toBe("https://www.youtube.com/watch?v=AAAAAAAAAAA");
    expect(rows[0].views).toBe("14,943,780 views");
    expect(rows[0].published).toBe("3 weeks ago");
  });
  it("an item with no id is not a row, and the list is read at the catalog's own list path", () => {
    const bad = catalogPage("tikhub.youtube.search.videos", [{ title: "no id" }, { video_id: "CCCCCCCCCCC", title: "x" }]);
    expect(mapPage(search, bad).map((r) => r.id)).toEqual(["CCCCCCCCCCC"]);
    expect(mapPage(search, { data: { other: [] } })).toEqual([]);
  });
  it("an account listing's counter is a counter only because the catalog types it a number (anyapi: comments is a number); a string counter is not made a counter", () => {
    const ig = discoverCards(catalog, "instagram", ACCESS).cards;
    const hashtag = ig.find((c) => c.endpointId === "scrapecreators.x.v1-instagram-search-hashtag")!;
    expect(hashtag.counter).toBeNull();
    expect(search.counter).toBeNull();
  });
  it("the search asks the source for videos only (the catalog's `type` input lists «video»): a fixed input of the card, sent on the first page", () => {
    expect(search.inputs.fixed).toEqual({ type: "video" });
    const ask = buildAsk("عايز ١٠ فيديوهات من يوتيوب عن الذكاء الاصطناعي", null, Date.parse("2026-11-04T18:00:00Z"));
    expect(parentInputs(search, ask)).toEqual({ keyword: "الذكاء الاصطناعي", type: "video" });
  });
});

describe("CANDIDATES AND THEIR ORDER", () => {
  const ask = buildAsk("عايز ١٠ فيديوهات من يوتيوب عن الذكاء الاصطناعي", null, Date.parse("2026-11-04T18:00:00Z"));
  it("without the discovery cards a YouTube request has no keyword search (the hand cards only search INSIDE a channel); with them the derived search joins, and a verified card always outranks a derived one that carries the same", () => {
    expect(rankedCards(ask, "parents", { catalogOnly: true }).map((c) => c.role)).toEqual(["videos.channel"]);
    const { cards } = cardsWithDiscovery(catalog, "youtube", ACCESS);
    const ranked = rankedCards(ask, "parents", { catalogOnly: true, cards });
    expect(ranked.some((c) => c.role === "videos.search")).toBe(true);
    const verified = ranked.findIndex((c) => !c.derived), derived = ranked.findIndex((c) => c.derived);
    expect(verified).toBeLessThan(derived);
  });
  it("a derived card is for a catalog_only caller only: a caller that does not allow catalog_only cards sees none of them", () => {
    const { cards } = cardsWithDiscovery(catalog, "youtube", ACCESS);
    expect(rankedCards(ask, "parents", { catalogOnly: false, cards }).every((c) => c.status === "verified")).toBe(true);
    expect(chooseCard(ask, "parents", { catalogOnly: false, cards })?.derived).toBeUndefined();
  });
  it("a hashtag takes the topic as ONE tag (spaces become «_», no «#»), and a topic of more than three words is not a hashtag", () => {
    expect(hashtagOf("الذكاء الاصطناعي")).toBe("الذكاء_الاصطناعي");
    expect(hashtagOf("#makeup")).toBe("makeup");
    const { cards } = cardsWithDiscovery(catalog, "instagram", ACCESS);
    const tag = cards.find((c) => c.endpointId === "scrapecreators.x.v1-instagram-search-hashtag")!;
    expect(parentInputs(tag, buildAsk("عايز ١٠ منشورات من إنستجرام عن الذكاء الاصطناعي", null, 0))).toMatchObject({ hashtag: "الذكاء_الاصطناعي" });
    // a topic of more than three words describes an event, it is not a tag
    const long = { ...buildAsk("عايز ١٠ منشورات من إنستجرام عن الذكاء الاصطناعي", null, 0), topic: { text: "تأثير الذكاء الاصطناعي على سوق العمل في مصر", relation: "about" as const } };
    expect(rankedCards(long, "parents", { catalogOnly: true, cards: [tag] })).toEqual([]);
  });
  it("an Instagram request with no account: no verified card is eligible, so the only candidates are the derived searches (the hand-written ones need an account)", () => {
    const igAsk = buildAsk("عايز ١٠ منشورات عامة من إنستجرام عن الذكاء الاصطناعي", null, 0);
    expect(rankedCards(igAsk, "parents", { catalogOnly: true })).toEqual([]);
    const { cards } = cardsWithDiscovery(catalog, "instagram", ACCESS);
    expect(rankedCards(igAsk, "parents", { catalogOnly: true, cards }).every((c) => c.role === "posts.search")).toBe(true);
  });
  it("what a card carries of the ask is computed from its inputs (a derived card with a date pair carries the period; one without it does not)", () => {
    const { cards } = cardsWithDiscovery(catalog, "youtube", ACCESS);
    const search = cards.find((c) => c.endpointId === "tikhub.youtube.search.videos")!;
    const withPeriod = buildAsk("عايز ١٠ فيديوهات من يوتيوب عن الذكاء الاصطناعي آخر ٣ شهور", null, Date.parse("2026-11-04T18:00:00Z"));
    expect(carriedBy(search, withPeriod).carried).toEqual(["topic"]);
    expect(search.cannot).toContain("period");
  });
  it("the candidate view a model sees carries only facts about the card, never a price in points", () => {
    const { cards } = cardsWithDiscovery(catalog, "youtube", ACCESS);
    const v = candidateViewOf(cards.find((c) => c.endpointId === "tikhub.youtube.search.videos")!, ["topic"]);
    expect(Object.keys(v).sort()).toEqual(["cannot", "capability", "carries", "costUsdPerPage", "derived", "endpointId", "paging", "role", "status"]);
  });
});

describe("THE CHAIN CHECK refuses an unusable chain BEFORE any read, hold or approval", () => {
  const { cards } = cardsWithDiscovery(catalog, "youtube", ACCESS);
  const search = cards.find((c) => c.endpointId === "tikhub.youtube.search.videos")!;
  const comments = cardOf("tikhub.youtube.video.comments")!;
  const replies = cardOf("anyapi.youtube.comment_replies")!;
  it("a derived YouTube search, the verified comments card and the verified replies card chain: the video's id is what the comments tool takes, the comment's reply token what the replies tool takes", () => {
    expect(validateChain([search, comments, replies], catalog, ACCESS)).toEqual([]);
  });
  it("a parent that does not give the key the next tool takes is refused with the key named", () => {
    const noId = { ...search, mapping: { kind: "fields" as const, fields: { text: ["title"] } } };
    expect(validateChain([noId, comments], catalog, ACCESS)).toContainEqual({ code: "parent_key_missing", parent: search.endpointId, child: comments.endpointId, key: "id" });
  });
  it("a replies tool whose parent key the comments tool does not keep is refused", () => {
    const crawl = cardOf("crawl4ai.youtube.video.comments")!;
    expect(validateChain([search, crawl, replies], catalog, ACCESS)).toContainEqual({ code: "parent_key_missing", parent: crawl.endpointId, child: replies.endpointId, key: "reply_continuation_token" });
  });
  it("an input the catalog does not declare, an unknown endpoint and another platform's tool are each refused", () => {
    expect(validateChain([{ ...search, inputs: { ...search.inputs, query: { field: "not_an_input" } } }], catalog, ACCESS)).toContainEqual({ code: "input_not_declared", endpointId: search.endpointId, input: "not_an_input" });
    expect(validateChain([{ ...search, endpointId: "nobody.made.this" }], catalog, ACCESS)).toContainEqual({ code: "unknown_endpoint", endpointId: "nobody.made.this" });
    const x = TOOL_CARDS.find((c) => c.platform === "x")!;
    expect(validateChain([search, x], catalog, ACCESS)).toContainEqual({ code: "other_platform", endpointId: x.endpointId });
  });
  it("an Instagram hashtag search feeds the verified comments card by the post's link", () => {
    const ig = cardsWithDiscovery(catalog, "instagram", ACCESS).cards;
    const tag = ig.find((c) => c.endpointId === "scrapecreators.x.v1-instagram-search-hashtag")!;
    const c = cardOf("anyapi.instagram.post.comments")!;
    expect(c.inputs.parent?.from).toBe("link");
    expect(validateChain([tag, c], catalog, ACCESS)).toEqual([]);
  });
});

describe("THE SWITCH: only the exact value «test» on a TEST account (owner decision 7.4)", () => {
  it.each([[{ [SOCIAL_DISCOVERY_KEY]: "test" }, true, true], [{ [SOCIAL_DISCOVERY_KEY]: "test" }, false, false], [{ [SOCIAL_DISCOVERY_KEY]: "on" }, true, false], [{ [SOCIAL_DISCOVERY_KEY]: "off" }, true, false], [{ [SOCIAL_DISCOVERY_KEY]: true }, true, false], [{}, true, false], [null, true, false], [undefined, true, false]] as const)("%j test=%s → %s", (settings, isTest, expected) => {
    expect(discoveryActive(settings as never, isTest)).toBe(expected);
  });
  it("the worker wires the cards only through the switch, and the gateway, the price and the settlement files are not touched by this round", () => {
    const run = readFileSync("agent/src/runMission.ts", "utf8");
    expect(run).toContain("discoveryActive(settings, redesign.isTest)");
    for (const f of ["agent/src/gateway.ts", "src/lib/agentMission/price.ts", "agent/src/finalize.ts"]) expect(readFileSync(f, "utf8"), f).not.toMatch(/discovery|derived/i);
  });
});

describe("THE MODEL CHOOSES AMONG VALIDATED CANDIDATES ONLY", () => {
  const { cards } = cardsWithDiscovery(catalog, "youtube", ACCESS);
  const views = cards.filter((c) => c.role === "videos.search").map((c) => candidateViewOf(c, ["topic"]));
  it("an answer naming a candidate is accepted; one naming anything else, or unreadable, is no answer", () => {
    expect(parseSelection(`{"endpointId":"${views[0].endpointId}","reason":"best"}`, views)).toEqual({ endpointId: views[0].endpointId, reason: "best" });
    expect(parseSelection('{"endpointId":"made.up.endpoint","reason":"x"}', views)).toBeNull();
    expect(parseSelection("not json", views)).toBeNull();
    expect(parseSelection("", views)).toBeNull();
    expect(parseSelection('{"endpointId": 5}', views)).toBeNull();
  });
  it("the selector carries the cost of the call and turns an answer outside the candidates into an empty choice the compiler ignores", async () => {
    const good = modelSelector(async () => ({ text: `{"endpointId":"${views[1].endpointId}","reason":"r"}`, costUsd: 0.002 }));
    expect(await good({ request: "r", topic: "t", candidates: views })).toEqual({ endpointId: views[1].endpointId, reason: "r", costUsd: 0.002 });
    const bad = modelSelector(async () => ({ text: '{"endpointId":"nope"}', costUsd: 0.002 }));
    expect(await bad({ request: "r", topic: "t", candidates: views })).toEqual({ endpointId: "", reason: "", costUsd: 0.002 });
    expect(await modelSelector(async () => null)({ request: "r", topic: "t", candidates: views })).toBeNull();
  });
});

describe("THE CHANNEL FROM EVIDENCE (an official channel is not «the first result»)", () => {
  const rows = [{ id: "UC1", title: "FIFA", handle: "@fifa", subscribers: "١٤ مليون" }, { id: "UC2", title: "FIFA+ Arabic", handle: "@fifaplusar", subscribers: "٢ مليون" }, { id: "UC3", title: "قناة أخرى", handle: "@other" }];
  it("exactly one candidate carries every word of the name: that is the channel", () => {
    expect(channelEvidenceOf("Other الرسمية", rows)).toEqual({ kind: "one", channel: rows[2] });
  });
  it("several carry it, or none does: the customer picks among the candidates' own evidence (at most three), and nothing is asked when no candidate exists", () => {
    expect(channelEvidenceOf("FIFA الرسمية", rows)).toEqual({ kind: "ambiguous", options: [rows[0], rows[1]] });
    expect(channelEvidenceOf("فيفا الرسمية", rows)).toEqual({ kind: "ambiguous", options: rows });
    expect(channelEvidenceOf("فيفا", [])).toEqual({ kind: "none" });
  });
  it("the answer to the question is the handle (read as a handle by the existing channel answer reader), else the channel id", () => {
    expect(channelAnswerOf(rows[0])).toBe("@fifa");
    expect(channelAnswerOf({ id: "UCabcdefghijklmnopqrstuv" })).toBe("UCabcdefghijklmnopqrstuv");
  });
  it("the question lists each candidate once with its own title, handle and subscribers; apart from those names (data the customer must recognise, shown as the source wrote them) the text passes the customer-text check: Arabic, no provider, no price", () => {
    const q = youtubeChannelChoiceQuestionAr("فيفا", rows.slice(0, 2));
    expect(q).toContain("@fifa");
    expect(q).toContain("١٤ مليون");
    expect(q.match(/@fifaplusar/g)).toHaveLength(1);
    const withoutNames = youtubeChannelChoiceQuestionAr("فيفا", [{ id: "UC1", title: "الأولى", handle: "@" , subscribers: "١٤ مليون" }, { id: "UC2", title: "الثانية", subscribers: "٢ مليون" }]).replace(/UC\d/g, "").replace(/@/g, "");
    expect(checkCustomerText(withoutNames).issues).toEqual([]);
  });
});

describe("COMPLETENESS: complete within the source, partial, or unknown, never «all of the platform»", () => {
  it("the plan-time state follows the last page read and the paging the catalog described", () => {
    expect(completenessOf("declared", false)).toBe("complete_within_source");
    expect(completenessOf("declared", true)).toBe("partial");
    expect(completenessOf("declared", null)).toBe("unknown");
    expect(completenessOf("unknown", false)).toBe("unknown");
  });
  const { cards } = cardsWithDiscovery(catalog, "youtube", ACCESS);
  const search = cards.find((c) => c.endpointId === "tikhub.youtube.search.videos")!;
  const mark = discoveryMarkOf(search, { pages: 2, rows: 10, hasMore: true });
  it("the file's sentence for each way the read ended: exhausted, the approved limit (with and without more in the source), a known limit or failure, or nothing recorded", () => {
    expect(deliveryCompletenessLineAr(mark, "الفيديوهات", "source_exhausted", 7)).toContain("مكتملة ضمن ما يتيحه المصدر");
    expect(deliveryCompletenessLineAr(mark, "الفيديوهات", "target_reached", 10)).toContain("تسليم جزئي بحكم الحد المعتمد".replace("تسليم", "فالتسليم"));
    expect(deliveryCompletenessLineAr({ ...mark, completeness: "complete_within_source" }, "الفيديوهات", "target_reached", 10)).toContain("كان المصدر قد انتهى");
    expect(deliveryCompletenessLineAr(mark, "الفيديوهات", "budget", 4)).toContain("فالتسليم جزئي");
    expect(deliveryCompletenessLineAr(mark, "الفيديوهات", "failed", 4)).toContain("تعذّر قراءة صفحة");
    expect(deliveryCompletenessLineAr(mark, "الفيديوهات", null, 4)).toContain("الاكتمال غير معروف");
    for (const stop of ["source_exhausted", "target_reached", "budget", "failed", null]) {
      const line = deliveryCompletenessLineAr(mark, "الفيديوهات", stop, 4);
      expect(line).toContain("ولا يمثل كل ما نُشر على المنصة");
      expect(checkCustomerText(line).issues, String(stop)).toEqual([]);
    }
  });
  it("the plan card's sentences pass the customer-text check", () => {
    const ask = buildAsk("عايز ١٠ فيديوهات من يوتيوب عن الذكاء الاصطناعي", null, 0);
    for (const m of [mark, { ...mark, completeness: "unknown" as const }, { ...mark, completeness: "complete_within_source" as const }]) for (const line of discoveryNotesAr(search, ask, m)) expect(checkCustomerText(line).issues, line).toEqual([]);
  });
});
