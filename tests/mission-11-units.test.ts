import { describe, expect, it } from "vitest";
import { catalogDateKind, parseRelativeAge, approxDayOf, rangeOverlaps, isRelativeAge, APPROX_DATE_NUMBER_FORMAT, approxColumnsOf, APPROX_DATES_KEY } from "../src/lib/agentMission/relativeDates";
import { filterVerdict, findFilterFields, resolveFilters, type StageFilter } from "../src/lib/agentMission/filters";
import { entityDoubt, nameHasDebris, cleanedName } from "../src/lib/agentMission/entityDoubts";
import { withCleanName } from "../src/lib/agentMission/companyNames";
import { exactPlaceLabelAr, placeVerdict, placesInText } from "../src/lib/agentMission/places";
import { isListingEndpoint, namedSourceRoutes, sourceInputOf } from "../src/lib/agentMission/namedRoutes";
import { sourcesFromPages } from "../agent/src/engine/spec";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { workbookNoteAr } from "../agent/src/workbook";
import { makeHarness, tregResult } from "./helpers/agentHarness";
import { loadSystemPrompt } from "../agent/src/prompt";

const DAY = 86_400_000;
// a FIXED moment: the tests never read the clock (2026-10-29 21:00 UTC is Cairo 23:00; the day computed below is the Cairo day)
const NOW = Date.parse("2026-10-29T10:00:00Z");

describe("relative times: «قبل ٤ أيام», «4 days ago», «2 weeks ago» are an age RANGE and an approximate day", () => {
  it.each([
    ["4 days ago", 4 * DAY],
    ["قبل 4 أيام", 4 * DAY],
    ["قبل ٤ أيام", 4 * DAY],
    ["قبل يومين", 2 * DAY],
    ["قبل يوم", DAY],
    ["Streamed 3 days ago", 3 * DAY],
    ["Premiered 2 weeks ago", 14 * DAY],
    ["قبل أسبوعين", 14 * DAY],
    ["1 month ago", 30.4375 * DAY],
    ["قبل شهرين", 2 * 30.4375 * DAY],
    ["قبل 3 أشهر", 3 * 30.4375 * DAY],
    ["قبل ٣ شهور", 3 * 30.4375 * DAY],
    ["an hour ago", 3_600_000],
    ["قبل ساعتين", 2 * 3_600_000],
    ["2 years ago", 2 * 365.25 * DAY],
    ["منذ ٥ دقائق", 5 * 60_000],
  ])("%s", (text, ageMs) => {
    const a = parseRelativeAge(text, NOW)!;
    expect(a).not.toBeNull();
    expect(a.ageMs).toBeCloseTo(ageMs, 0);
    // the item is N units old, less than N+1: the range is [N+1 units back, N units back]
    expect(a.toMs).toBeCloseTo(NOW - ageMs, 0);
    expect(a.fromMs).toBeLessThan(a.toMs);
    expect(a.approxMs).toBe(a.toMs);
  });

  it("anything that is not a relative age is left alone: a date, a sentence that mentions days, a number, an empty value", () => {
    for (const v of ["2026-10-25", "Sat Nov 10 08:35:22 +0000 2018", "قبل أن نبدأ بثلاثة أيام نتحدث", "3 days of rain", "4 days", "", null, undefined, 4, "قبل", "ago", "قبل 5 كيلومتر"]) expect(isRelativeAge(v), String(v)).toBe(false);
  });

  it("the approximate day is the Cairo calendar day N units back; a source never gives a made-up time of day", () => {
    expect(approxDayOf(parseRelativeAge("قبل 4 أيام", NOW)!)).toBe("2026-10-25");
    expect(approxDayOf(parseRelativeAge("2 weeks ago", NOW)!)).toBe("2026-10-15");
    // 22:30 UTC is 00:30 of the next day in Cairo (UTC+2 after the clocks change): one day back is 00:30 of the 29th in Cairo, the 28th in UTC
    const late = Date.parse("2026-10-29T22:30:00Z");
    expect(approxDayOf(parseRelativeAge("قبل يوم", late)!)).toBe("2026-10-29");
  });

  it("two ranges overlap a period when the item MAY be inside it", () => {
    const from = NOW - 90 * DAY;
    // «قبل شهرين»: 61 to 91 days old: it may be inside the 90 days
    expect(rangeOverlaps(parseRelativeAge("قبل شهرين", NOW)!, from, Number.POSITIVE_INFINITY)).toBe(true);
    // «3 months ago» is at least 91 days old: outside
    expect(rangeOverlaps(parseRelativeAge("3 months ago", NOW)!, from, Number.POSITIVE_INFINITY)).toBe(false);
    expect(rangeOverlaps(parseRelativeAge("قبل 5 أشهر", NOW)!, from, Number.POSITIVE_INFINITY)).toBe(false);
    expect(rangeOverlaps(parseRelativeAge("4 days ago", NOW)!, from, Number.POSITIVE_INFINITY)).toBe(true);
  });

  it("the period filter accepts an item whose relative time may fall inside the period and leaves out the one that cannot (live: all 16 new videos were left out)", () => {
    const period: StageFilter = { kind: "period", days: 90, field: "published" };
    const ctx = { textKey: null, now: NOW };
    expect(filterVerdict([period], { published: "قبل 4 أيام" }, ctx)).toBeNull();
    expect(filterVerdict([period], { published: "قبل 3 أسابيع" }, ctx)).toBeNull();
    expect(filterVerdict([period], { published: "قبل شهرين" }, ctx)).toBeNull();
    expect(filterVerdict([period], { published: "5 months ago" }, ctx)).toBe("filter_period");
    expect(filterVerdict([period], { published: "قبل سنتين" }, ctx)).toBe("filter_period");
    // a value that is no moment and no relative age is still left out; a real moment is judged as it always was
    expect(filterVerdict([period], { published: "قريبًا" }, ctx)).toBe("filter_period");
    expect(filterVerdict([period], { published: "2026-10-25T10:00:00Z" }, ctx)).toBeNull();
    expect(filterVerdict([period], { published: "2026-01-01T10:00:00Z" }, ctx)).toBe("filter_period");
  });

  it("the file: an approximate date is written with the word «تقريبًا» before it, and the first sheet says so", () => {
    expect(APPROX_DATE_NUMBER_FORMAT).toBe('"تقريبًا "yyyy-mm-dd');
    expect(approxColumnsOf({ [APPROX_DATES_KEY]: ["published"], published: "2026-10-25" })).toEqual(["published"]);
    expect(approxColumnsOf({ published: "2026-10-25" })).toEqual([]);
    const note = workbookNoteAr({ sheets: 2, hasParentColumn: true, parentLinked: true, hasDateColumn: true, hasApproxDates: true });
    expect(note).toContain("تقريبية");
    expect(note).toContain("قبل ٣ أيام");
    expect(workbookNoteAr({ sheets: 2, hasParentColumn: true, parentLinked: true, hasDateColumn: true })).not.toContain("تقريبية");
    expect(note).not.toMatch(/[0-9]/);
  });
});

describe("a named source is found in every field that names the author (a channel's handle AND its display name)", () => {
  it("the account filter reads the handle, the display name and any other author field; a stage's fields are found from the mapping", () => {
    const fields = findFilterFields({ mappedKeys: ["id", "title", "channel", "username", "views", "published"], columnKeys: ["title", "channel", "views", "published"] });
    expect(fields.account).toBe("username");
    expect(fields.accountFields).toEqual(expect.arrayContaining(["username", "channel"]));
    const resolved = resolveFilters([{ kind: "account", values: ["BBC News"] }], fields, "stage");
    expect(resolved.issues).toEqual([]);
    const account = resolved.filters.find((f) => f.kind === "account")!;
    expect(account.fields).toEqual(expect.arrayContaining(["username", "channel"]));
    // the handle says «@BBCNews»; the display name says «BBC News»: the second names the source the customer wrote
    expect(filterVerdict([account], { username: "@BBCNews", channel: "BBC News" }, { textKey: null, now: NOW })).toBeNull();
    expect(filterVerdict([account], { username: "@Other", channel: "Sky News" }, { textKey: null, now: NOW })).toBe("filter_account");
  });

  it("a mapping with only a display name (no username) still gives an account field (the author's name)", () => {
    const fields = findFilterFields({ mappedKeys: ["id", "title", "channel"], columnKeys: ["title", "channel"] });
    expect(fields.account).toBe("channel");
  });

  it("a source's own LISTING gives items with no author: they belong to the source asked for; an item that names ANOTHER author is still left out", () => {
    const account: StageFilter = { kind: "account", field: "channel", fields: ["channel"], values: ["AlArabiya العربية"] };
    expect(filterVerdict([account], { title: "x", channel: "" }, { textKey: null, now: NOW })).toBe("filter_account");
    expect(filterVerdict([account], { title: "x", channel: "" }, { textKey: null, now: NOW, listing: true })).toBeNull();
    expect(filterVerdict([account], { title: "x", channel: "Sky News" }, { textKey: null, now: NOW, listing: true })).toBe("filter_account");
  });
});

describe("the sources that take the source itself (the catalog's own capabilities)", () => {
  const catalog = loadTregCatalog();
  const allowed = () => true;
  it("a YouTube keyword search has the channel listings of the catalog as routes, cheapest first, each with the input that takes the channel", () => {
    const routes = namedSourceRoutes("tikhub.x.youtube-web-search-video", catalog, allowed);
    expect(routes.length).toBeGreaterThan(2);
    expect(routes.map((r) => r.id)).toEqual(expect.arrayContaining(["crawl4ai.youtube.channel.videos", "tikhub.youtube.channel.videos", "scrapecreators.x.v1-youtube-channel-videos"]));
    expect(routes.every((r) => catalog.byId.get(r.id)!.capability === "youtube.channel.videos")).toBe(true);
    const costs = routes.map((r) => r.usdPerItem);
    expect([...costs].sort((a, b) => a - b)).toEqual(costs);
    expect(routes.find((r) => r.id === "crawl4ai.youtube.channel.videos")!.input).toBe("channel");
    // YouTube's «posts» of a channel are community posts, not videos: never a route for a video search
    expect(routes.some((r) => catalog.byId.get(r.id)!.capability === "youtube.channel.posts")).toBe(false);
  });
  it("an X post search has the account listings; an endpoint that is not a keyword search has none (nothing is claimed)", () => {
    const x = namedSourceRoutes("anyapi.x.search.posts", catalog, allowed);
    expect(x.length).toBeGreaterThan(0);
    expect(x.every((r) => catalog.byId.get(r.id)!.capability === "x.user.posts")).toBe(true);
    expect(namedSourceRoutes("crawl4ai.youtube.channel.videos", catalog, allowed)).toEqual([]);
    expect(namedSourceRoutes("nothing.here", catalog, allowed)).toEqual([]);
  });
  it("a route that the account may not buy is not offered", () => {
    expect(namedSourceRoutes("tikhub.x.youtube-web-search-video", catalog, (id) => id !== "crawl4ai.youtube.channel.videos").map((r) => r.id)).not.toContain("crawl4ai.youtube.channel.videos");
  });
  it("a listing endpoint is recognised by its capability and its source input", () => {
    expect(isListingEndpoint(catalog.byId.get("crawl4ai.youtube.channel.videos"))).toBe(true);
    expect(isListingEndpoint(catalog.byId.get("tikhub.x.youtube-web-search-video"))).toBe(false);
    expect(sourceInputOf(catalog.byId.get("crawl4ai.youtube.channel.videos")!)).toBe("channel");
  });
});

describe("one recipe per named source: the page each named source was read by", () => {
  const rows = (channel: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${channel}${i}`, channel, username: `@${channel.replace(/\s/g, "")}` }));
  const account: StageFilter = { kind: "account", field: "username", fields: ["username", "channel"], values: ["العربية", "اليوم السابع", "BBC News"] };
  it("each name is read by the page that shows its items; the inputs of that page are its first-page inputs", () => {
    const pages = [
      { id: "call_0001", params: { channel: "alarabiya" }, rows: rows("العربية", 3) },
      { id: "call_0002", params: { channel: "youm7" }, rows: rows("اليوم السابع - Youm7", 3) },
      { id: "call_0003", params: { channel: "bbcnews" }, rows: rows("BBC News", 3) },
    ];
    expect(sourcesFromPages(account, pages, null)).toEqual([{ names: ["العربية"], params: { channel: "alarabiya" } }, { names: ["اليوم السابع"], params: { channel: "youm7" } }, { names: ["BBC News"], params: { channel: "bbcnews" } }]);
  });
  it("a name no page shows has no recipe (the model carries the stage out); one page that shows several names serves them all", () => {
    const some = [{ id: "call_0001", params: { channel: "a" }, rows: rows("العربية", 2) }, { id: "call_0002", params: { channel: "b" }, rows: rows("BBC News", 2) }];
    expect(sourcesFromPages(account, some, null)).toBeNull();
    const mixed = [{ id: "call_0001", params: { q: "war" }, rows: [...rows("العربية", 1), ...rows("اليوم السابع", 1), ...rows("BBC News", 1)] }];
    expect(sourcesFromPages(account, mixed, null)).toEqual([{ names: ["العربية", "اليوم السابع", "BBC News"], params: { q: "war" } }]);
  });
  it("a page read from a later position (a cursor) is never a first page", () => {
    const pages = [{ id: "call_0001", params: { q: "a", cursor: "c2" }, rows: rows("BBC News", 2) }];
    expect(sourcesFromPages({ ...account, values: ["BBC News"] }, pages, "cursor")).toBeNull();
  });
  it("a declared call is trusted for a listing that names no author, and ignored when its items name ANOTHER source", () => {
    const listing = (id: string, channel: string) => ({ id, params: { channel }, rows: Array.from({ length: 3 }, (_, i) => ({ id: `${id}${i}`, channel: "", username: "" })) });
    const declared: StageFilter = { ...account, calls: ["call_0001", "call_0002", "call_0003"] };
    expect(sourcesFromPages(declared, [listing("call_0001", "UC1"), listing("call_0002", "UC2"), listing("call_0003", "UC3")], null, true)).toEqual([{ names: ["العربية"], params: { channel: "UC1" } }, { names: ["اليوم السابع"], params: { channel: "UC2" } }, { names: ["BBC News"], params: { channel: "UC3" } }]);
    // not a listing endpoint: a page with no author is no evidence of anything
    expect(sourcesFromPages(declared, [listing("call_0001", "UC1"), listing("call_0002", "UC2"), listing("call_0003", "UC3")], null, false)).toBeNull();
    // the declared call of «BBC News» actually shows another channel: the declaration is ignored, and no other page shows BBC
    const wrong = [listing("call_0001", "UC1"), listing("call_0002", "UC2"), { id: "call_0003", params: { channel: "UC3" }, rows: rows("Sky News", 3) }];
    expect(sourcesFromPages(declared, wrong, null, true)).toBeNull();
  });
});

describe("a company row that looks like a company of the trade and place asked for, but its own text says otherwise", () => {
  const input = { nameKeys: ["name"], descriptionKeys: ["description"], wantedPlaces: ["EG"] };
  it("a name that is a broken spreadsheet line is debris; the real name is the part before the first comma", () => {
    const name = 'serious construction "sc",,11-50,seriouscons.com';
    expect(nameHasDebris(name)).toBe(true);
    expect(cleanedName(name)).toBe("serious construction sc");
    for (const ok of ["Orascom Construction", "Hassan Allam Holding", "Smith, Jones & Co", "Al-Futtaim, Egypt", "builders, inc"]) expect(nameHasDebris(ok), ok).toBe(false);
    expect(nameHasDebris("acme,11-50")).toBe(true);
    expect(nameHasDebris("acme,,")).toBe(true);
    expect(nameHasDebris("acme, 1000+")).toBe(true);
    expect(nameHasDebris("acme, acme.com")).toBe(true);
  });
  it("withCleanName cuts the name column and says so; another column is untouched", () => {
    const columns = [{ key: "name", title_ar: "اسم الشركة" }, { key: "description", title_ar: "نبذة" }];
    const out = withCleanName({ name: 'serious construction "sc",,11-50,seriouscons.com', description: "a law firm in Seattle" }, columns);
    expect(out.debris).toBe(true);
    expect(out.item).toEqual({ name: "serious construction sc", description: "a law firm in Seattle" });
    const same = { name: "Orascom Construction", description: "x" };
    expect(withCleanName(same, columns)).toEqual({ item: same, debris: false });
    expect(withCleanName(same, columns).item).toBe(same);
  });
  it.each([
    ["Big 5 Construct Egypt", "Find new business opportunities in Egypt's USD 570 billion construction market", "other_kind"],
    ["serious construction", "A law firm in Seattle serving construction clients", "other_place"],
    ["serious construction", "A law firm serving construction clients", "other_kind"],
    ["FCC Construction & Development", "fcc.com is a discussion site about construction", "other_kind"],
    ["fibrex construction group", "A construction group whose head office is in Abu Dhabi, United Arab Emirates", "other_place"],
    ["cpc egypt", "A leading Saudi contracting company based in Riyadh, Saudi Arabia", "other_place"],
  ])("%s goes to the model check (%s)", (name, description, reason) => {
    expect(entityDoubt({ name, description }, input)).toBe(reason);
  });
  it.each([
    ["Orascom Construction", "Orascom Construction is a leading contractor in Egypt, the Middle East and Africa, with offices in Dubai and Cairo"],
    ["Hassan Allam", "A contracting and engineering company building infrastructure"],
    ["Arab Contractors", "Egyptian contractor founded in 1955 in Cairo"],
    ["Elsewedy", ""],
  ])("%s is not doubted", (name, description) => {
    expect(entityDoubt({ name, description }, input)).toBeNull();
  });
  it("a place doubt needs a promised place; without one only the kind of body and the name can raise a doubt", () => {
    const noPlace = { ...input, wantedPlaces: [] };
    expect(entityDoubt({ name: "x", description: "Head office in Abu Dhabi" }, noPlace)).toBeNull();
    expect(entityDoubt({ name: "x", description: "A law firm" }, noPlace)).toBe("other_kind");
  });
});

describe("city cells: a district or city of the table is written in Arabic, an unknown place stays as the source gave it", () => {
  it.each([
    ["Nasr City", "مدينة نصر"],
    ["Down Town", "وسط البلد"],
    ["Downtown", "وسط البلد"],
    ["Zahraa El Maadi", "زهراء المعادي"],
    ["First New Cairo", "التجمع الأول"],
    ["Second New Cairo", "التجمع الثاني"],
    ["Sheikh Zayed City", "الشيخ زايد"],
    ["Sheikh Zayed Egypt", "الشيخ زايد"],
    ["mokattam", "المقطم"],
    ["El Agouza", "العجوزة"],
    ["New Cairo City", "القاهرة الجديدة"],
    ["Cairo Governorate", "القاهرة"],
    ["6th of October City", "مدينة ٦ أكتوبر"],
  ])("%s → %s", (source, ar) => {
    expect(exactPlaceLabelAr(source, "city")).toBe(ar);
  });
  it("a place the table does not know stays as the source wrote it (null: the caller keeps the text)", () => {
    for (const v of ["Gamasa", "Some Street 12", "Qalyubia"]) expect(exactPlaceLabelAr(v, "city"), v).toBeNull();
  });
  it("a city of another country is evidence AGAINST an Egypt request, a city of Egypt for it (live: Seattle and Miami companies were delivered for «في مصر»)", () => {
    const fields = ["city", "country", "website", "domain"];
    expect(placeVerdict(["EG"], { city: "Seattle", country: "", website: "", domain: "" }, fields, { bySource: true })).toBe("other_place");
    expect(placeVerdict(["EG"], { city: "miami", country: "", website: "fcc.com", domain: "fcc.com" }, fields, { bySource: true })).toBe("other_place");
    expect(placeVerdict(["EG"], { city: "Nasr City", country: "", website: "", domain: "" }, fields, { bySource: true })).toBe("pass");
    expect(placeVerdict(["EG"], { city: "", country: "EG", website: "x.com", domain: "x.com" }, fields, { bySource: true })).toBe("pass");
    // a source that was asked for Egypt and gives no city passes, as before
    expect(placeVerdict(["EG"], { city: "", country: "", website: "x.com", domain: "x.com" }, fields, { bySource: true })).toBe("pass");
    expect(placesInText("شركة في سياتل").map((e) => e.country)).toEqual(["US"]);
  });
});

describe("planning samples a source's own listing once per named source (live: the third search of one source was refused, so the BBC search went to another source and «العربية» was never sampled on the one that was used)", () => {
  const page = { rows: [{ video_id: "a1", title: "حرب", url: "https://www.youtube.com/watch?v=a1", published: "3 days ago", views: 1 }] };
  const answers = () => Array.from({ length: 8 }, () => tregResult(page, 0.0009));
  const outcome = (r: unknown): string => ((r as { ok?: boolean }).ok === true ? "ok" : String((r as { refused?: string }).refused));

  it("three channels of one listing source are three samples; a third sample of the SAME channel is refused; the repeats cost nothing", async () => {
    const h = makeHarness({ phase: "planning", budgetUsd: 0.05, responses: answers() });
    const ask = (channel: string) => h.gateway.tregCall({ endpoint_id: "crawl4ai.youtube.channel.videos", params: { channel, limit: 12 } } as never);
    const got: string[] = [];
    for (const c of ["@AlArabiya", "@Youm7", "@BBCNews", "@BBCNews", "@BBCNews"]) got.push(outcome(await ask(c)));
    expect(got).toEqual(["ok", "ok", "ok", "ok", "repeat_sample"]);
    expect(h.call).toHaveBeenCalledTimes(4);
  });

  it("a keyword search is still sampled at most twice once it gave rows, whatever the words (the planning budget is shared by every stage)", async () => {
    const h = makeHarness({ phase: "planning", budgetUsd: 0.05, responses: answers() });
    const ask = (query: string) => h.gateway.tregCall({ endpoint_id: "crawl4ai.youtube.search.videos", params: { query, limit: 20 } } as never);
    const got: string[] = [];
    for (const q of ["العربية حرب", "اليوم السابع حرب", "BBC News war"]) got.push(outcome(await ask(q)));
    expect(got).toEqual(["ok", "ok", "repeat_sample"]);
  });

  it("a listing source is sampled for at most eight named sources (the planning budget still decides what is spent)", async () => {
    const h = makeHarness({ phase: "planning", budgetUsd: 0.05, responses: Array.from({ length: 12 }, () => tregResult(page, 0.0009)) });
    const got: string[] = [];
    for (let i = 0; i < 10; i += 1) got.push(outcome(await h.gateway.tregCall({ endpoint_id: "crawl4ai.youtube.channel.videos", params: { channel: `@c${i}`, limit: 12 } } as never)));
    expect(got.filter((x) => x === "ok")).toHaveLength(8);
    expect(got.slice(8)).toEqual(["repeat_sample", "repeat_sample"]);
  });
});

describe("what the catalog says about a source's dates", () => {
  const catalog = loadTregCatalog();
  it("the YouTube search and channel listings give relative times; a comments source with an ISO example and the video details give absolute ones; a source that lists no date field says nothing", () => {
    const kind = (id: string) => catalogDateKind(catalog.byId.get(id)!);
    expect(kind("crawl4ai.youtube.search.videos")).toBe("relative");
    expect(kind("crawl4ai.youtube.channel.videos")).toBe("relative");
    expect(kind("tikhub.youtube.channel.videos")).toBe("relative");
    expect(kind("crawl4ai.youtube.video.detail")).toBe("absolute");
    expect(kind("scrapecreators.youtube.video.comments")).toBe("absolute");
    expect(kind("scrapecreators.x.v1-youtube-channel-videos")).toBeNull();
    expect(catalogDateKind({ item_fields: null })).toBeNull();
  });
});

describe("the prompt the PLANNER reads (live: #297 put the named-source rules after the execution marker, so the planner never saw them)", () => {
  const planning = loadSystemPrompt("planning");
  it.each([
    "SOURCES THE CUSTOMER NAMES",
    "PREFER THE SOURCE'S OWN LISTING",
    "KEEP THE TIME OF A TIMESTAMP",
    "A PERIOD IS READ IN WINDOWS BY CODE",
    "THE SAME JOB, CHEAPER",
    "A SOURCE THAT GIVES ONLY A RELATIVE TIME",
    "A CUSTOMER'S ANSWER TO YOUR QUESTION IS FINAL",
  ])("the planning prompt says: %s", (text) => {
    expect(planning).toContain(text);
  });
  it("the execution prompt keeps its own rules and does not carry the planner's last two", () => {
    const execution = loadSystemPrompt("execution");
    expect(execution).toContain("SOURCES THE CUSTOMER NAMES");
    expect(execution).toContain("A SOURCE THAT GIVES ONLY A RELATIVE TIME");
    expect(execution).not.toContain("A CUSTOMER'S ANSWER TO YOUR QUESTION IS FINAL");
  });
});
