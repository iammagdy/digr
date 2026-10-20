import { describe, expect, it, vi } from "vitest";
import { ChatHandler, dateFiltersFromHint, extractDateHint, requestDateFilters } from "../src/functions/shared/chatHandler";
import { createChatDb } from "./helpers/chatSession";
import { socialSubjectText } from "../src/lib/socialTasks";

/**
 * A feed request (posts, comments, videos on X, TikTok, YouTube, Facebook) never gets a silent window:
 * stated dates are used (an impossible day is corrected), a known event is proposed from its published dates,
 * and a topic with no time frame gets exactly ONE question. The model is stubbed to throw: all of this is code.
 */
function run(message: string) {
  const db = createChatDb();
  const handler = new ChatHandler(db as any);
  const model = vi.fn(async () => { throw new Error("the model must not be called"); });
  (handler as any).llm.executeTurn = model;
  const send = () => handler.handleUserMessage({ userId: "u_window", message, userBalance: 5000 }) as Promise<any>;
  return { db, model, send };
}

const BARE_FEED_REQUESTS = [
  "هات ١٠ تغريدات عن كرة السلة",
  "١٠ كومنتس تيك توك عن كرة السلة في مصر",
  "عايز ١٠٠ كومنت من فيديوهات عن القهوة على يوتيوب",
];

describe("a feed request with no time frame", () => {
  it.each(BARE_FEED_REQUESTS)("«%s»: ONE question with the four periods, the plain warning, no plan and no model", async (message) => {
    const { model, send } = run(message);
    const r = await send();
    expect(model).not.toHaveBeenCalled();
    expect(r.outputType).toBe("ask_clarification");
    expect(r.planQuote).toBeUndefined();
    expect(r.clarificationItems).toHaveLength(1);
    const question = r.clarificationItems[0];
    expect(question.id).toBe("social_time_required");
    expect(question.options).toEqual(["آخر شهر", "آخر ٣ شهور", "آخر ٦ شهور", "آخر سنة"]);
    expect(question.defaultOption).toBeUndefined();
    expect(r.contentAr).toContain("سقف");
    expect(r.contentAr).toContain("كبيرة جدًا");
    expect(r.contentAr).not.toMatch(/[A-Za-z0-9]|undefined|null|NaN/);
  });

  it("applies no default window: the saved brief carries none", async () => {
    const { db, send } = run("هات ١٠ تغريدات عن كرة السلة");
    await send();
    const briefs = [...(db.store.get("conversations") || []), ...(db.store.get("briefs") || [])];
    expect(JSON.stringify(briefs)).not.toMatch(/آخر شهر|آخر 3 شهور|آخر ٣ شهور/);
  });

  it("answering with a period gives the plan with that exact window", async () => {
    const { model, send } = run("هات ١٠ تغريدات عن كرة السلة آخر ٣ شهور");
    const r = await send();
    expect(model).not.toHaveBeenCalled();
    expect(r.outputType).toBe("propose_plan");
    const params = r.planQuote.items[0].params;
    const months = (Date.parse(params.dateTo) - Date.parse(params.dateFrom)) / 86400000 / 30;
    expect(Math.round(months)).toBe(3);
  });
});

describe("stated dates, impossible days and known events reach the plan", () => {
  it("a range with 31 September ends on 30 September, never in October and never widened to the year", async () => {
    const { send } = run("هات ١٠ تغريدات عن الجواز على إكس من ١ يناير ٢٠٢٦ إلى ٣١ سبتمبر ٢٠٢٦");
    const r = await send();
    expect(r.outputType).toBe("propose_plan");
    expect(r.planQuote.items[0].params).toMatchObject({ query: "الجواز", dateFrom: "2026-01-01", dateTo: "2026-09-30" });
  });

  it("the 2026 World Cup request gets the tournament dates", async () => {
    const { send } = run("عايز ١٠٠ كومنت من فيديوهات منتخب مصر في كأس العالم ٢٠٢٦ على يوتيوب");
    const r = await send();
    expect(r.outputType).toBe("propose_plan");
    expect(r.planQuote.items[0].params).toMatchObject({ dateFrom: "2026-06-11", dateTo: "2026-07-19" });
  });

  it("companies need no window and get no question about one", async () => {
    const { send } = run("عايز شركتين كهرباء في مصر");
    const r = await send();
    expect(r.outputType).toBe("propose_plan");
    expect(r.planQuote.items[0].params).not.toHaveProperty("dateFrom");
  });
});

describe("the subject of a request leaves its period words out", () => {
  it.each([
    ["هات تغريدات عن الجواز آخر ٣ شهور", "الجواز"],
    ["هات تغريدات عن الجواز من يناير لحد سبتمبر ٢٠٢٦", "الجواز"],
    ["هات تغريدات عن الجواز من ١ يناير ٢٠٢٦ إلى ٣١ سبتمبر ٢٠٢٦", "الجواز"],
  ])("«%s» searches «%s»", (text, subject) => {
    expect(socialSubjectText(text)).toBe(subject);
  });
});

describe("the date helpers", () => {
  it("dateFiltersFromHint reads long dates and corrects the impossible day", () => {
    expect(dateFiltersFromHint("من ١ يناير ٢٠٢٦ إلى ٣١ سبتمبر ٢٠٢٦")).toEqual({ from: "2026-01-01", to: "2026-09-30" });
    expect(dateFiltersFromHint("من 1/1/2026 لحد 31/9/2026")).toEqual({ from: "2026-01-01", to: "2026-09-30" });
    expect(dateFiltersFromHint("آخر شهر", new Date(Date.UTC(2026, 9, 31)))).toEqual({ from: "2026-09-30", to: "2026-10-31" });
  });

  it("extractDateHint finds Arabic-digit years, long dates and known events, and nothing otherwise", () => {
    expect(extractDateHint("بوستات عن الأسعار في ٢٠٢٥")).toBe("2025");
    expect(extractDateHint("كل الفيديوهات في كأس العالم ٢٠٢٦")).toContain("١١ يونيو ٢٠٢٦");
    expect(extractDateHint("هات تغريدات عن كرة السلة")).toBeUndefined();
  });

  it("requestDateFilters never invents a window", () => {
    expect(requestDateFilters("هات تغريدات عن كرة السلة", undefined)).toEqual({});
    expect(requestDateFilters(undefined, "آخر ٦ شهور").from).toBeTruthy();
  });
});
