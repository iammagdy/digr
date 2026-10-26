import { afterEach, describe, expect, it, vi } from "vitest";

// The offline catalog prices the three decision-maker endpoints like the live one does (the real people branch reads them); every other endpoint is read as before.
vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/functions/shared/catalogClient")>();
  const prices: Record<string, number> = { "treg.people.search": 0.015, "treg.people.email.find": 0.01, "treg.people.phone.find": 0.01 };
  return {
    ...actual,
    getEndpointDetails: vi.fn(async (endpointId: string, options?: any) => prices[endpointId]
      ? ({ catalogPriceUsd: prices[endpointId] } as any)
      : actual.getEndpointDetails(endpointId, options)),
  };
});
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { extractRequestIntent, missingInputsForIntent } from "../src/lib/requestIntent";
import { planScopeRows, quoteScopeGaps } from "../src/lib/quoteScopeGaps";
import { createChatDb, withPeopleSettlement } from "./helpers/chatSession";

/**
 * The five fixed requests of the QA run, end to end through the chat handler with the model stubbed to throw: a fully
 * stated request must become the expected structured quote by code alone. The intent assertions read the structured
 * intent; the quote assertions read the saved plan items (what the customer is shown and approves), never prose.
 */
const COMPANIES = "عايز شركتين كهرباء في مصر";
const PEOPLE = "٣ مديرين في شركات الطاقة في السعودية مع إيميلاتهم وأرقامهم";
const COMMENTS = "١٠ كومنتس تيك توك عن كرة السلة في مصر في ٢٠٢٥";
const TWEETS = "هات ١٠ تغريدات عن كرة السلة في ٢٠٢٥";
const STUDIES = "اجمع ١٠ دراسات عن الطاقة الشمسية في ألمانيا";

const TAXONOMY = ["Electrical/Electronic Manufacturing", "Utilities"];

function run(message: string) {
  const db = withPeopleSettlement(createChatDb());
  const handler = new ChatHandler(db as any);
  const model = vi.fn(async () => { throw new Error("the model must not be called for a fully stated request"); });
  (handler as any).llm.executeTurn = model;
  const send = () => handler.handleUserMessage({ userId: "u_five", message, userBalance: 5000 }) as Promise<any>;
  return { db, model, send };
}

const usageRows = (db: ReturnType<typeof createChatDb>) => (db.store.get("llm_usage") || []) as any[];
const quoteRows = (db: ReturnType<typeof createChatDb>) => (db.store.get("plans_quotes") || []) as any[];

describe("five-request regression (no model call)", () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  it("1. «عايز شركتين كهرباء في مصر»: companies, Egypt, two, taxonomy and English keywords", async () => {
    const intent = extractRequestIntent(COMPANIES);
    expect(intent.dataType).toBe("companies");
    expect(intent.country?.english).toBe("Egypt");
    expect(intent.count).toBe(2);
    expect(intent.industry?.taxonomy).toEqual(TAXONOMY);

    const { db, model, send } = run(COMPANIES);
    const r = await send();
    expect(model).not.toHaveBeenCalled();
    expect(r.outputType).toBe("propose_plan");
    const item = r.planQuote.items[0];
    expect(item.capabilitySlug).toBe("icypeas-companies-search");
    expect(item.params.query.location.include).toEqual(["Egypt"]);
    expect(item.params.query.industry.include).toEqual(TAXONOMY);
    expect(item.params.query.keyword.include).toContain("electrical");
    expect(item.targetVolumeMax).toBe(2);
    expect(quoteScopeGaps(r.planQuote.items)).toEqual([]);
    expect(usageRows(db)).toHaveLength(1);
  });

  it("2. the decision-makers request: people, SA, three, work email and phone, English title and keywords", async () => {
    // the suites run with the cap lowered to 600 (vitest.config.mts): three people cost 3 x 258 = 774, which that cap would cut to two
    vi.stubEnv("JOB_MAX_POINTS_CAP", "");
    const intent = extractRequestIntent(PEOPLE);
    expect(intent.dataType).toBe("people");
    expect(intent.country?.iso).toBe("SA");
    expect(intent.count).toBe(3);
    expect(intent.contactFields).toEqual(["work_email", "phone"]);

    const { model, send } = run(PEOPLE);
    const r = await send();
    expect(model).not.toHaveBeenCalled();
    expect(r.outputType).toBe("propose_plan");
    const item = r.planQuote.items[0];
    expect(item.capabilitySlug).toMatch(/people/);
    expect(item.params.title).toBe("Director");
    expect(item.params.country).toBe("SA");
    expect(item.params.keywords).toContain("energy");
    expect(item.params.limit).toBe(3);
    expect(item.targetVolumeMax).toBe(3);
    expect(quoteScopeGaps(r.planQuote.items)).toEqual([]);
  });

  it("3. «١٠ كومنتس تيك توك عن كرة السلة في مصر»: TikTok comments, region EG, the subject, nothing missing", async () => {
    const intent = extractRequestIntent(COMMENTS);
    expect(missingInputsForIntent(intent, COMMENTS)).toEqual([]);

    const { model, send } = run(COMMENTS);
    const r = await send();
    expect(model).not.toHaveBeenCalled();
    expect(r.outputType).toBe("propose_plan");
    const item = r.planQuote.items[0];
    expect(item.capabilitySlug).toBe("social-tiktok-comments");
    expect(item.params.region).toBe("EG");
    expect(item.params.query).toBe("كرة السلة");
    expect(item.targetVolumeMax).toBe(10);
    expect(quoteScopeGaps(r.planQuote.items)).toEqual([]);
  });

  it("4. «هات ١٠ تغريدات عن كرة السلة»: X posts, exactly the subject, no gap, no country chip and no placeholder", async () => {
    const { model, send } = run(TWEETS);
    const r = await send();
    expect(model).not.toHaveBeenCalled();
    expect(r.outputType).toBe("propose_plan");
    const item = r.planQuote.items[0];
    expect(item.capabilitySlug).toBe("social-x-posts");
    expect(item.params).toEqual({ query: "كرة السلة", dateFrom: "2025-01-01", dateTo: "2025-12-31" });
    expect(item.targetVolumeMax).toBe(10);
    expect(quoteScopeGaps(r.planQuote.items)).toEqual([]);
    const chips = planScopeRows(r.planQuote.items);
    expect(chips).toHaveLength(2);
    for (const chip of chips) {
      expect(`${chip.label} ${chip.value}`).not.toContain("الدولة");
      expect(`${chip.label} ${chip.value}`).not.toContain("يلزم تحديد");
    }
  });

  it("5. «اجمع ١٠ دراسات عن الطاقة الشمسية في ألمانيا»: studies, no plan, no quote, one usage row", async () => {
    const intent = extractRequestIntent(STUDIES);
    expect(intent.dataType).toBe("studies");

    const { db, model, send } = run(STUDIES);
    const r = await send();
    expect(model).not.toHaveBeenCalled();
    expect(["answer_question", "refuse"]).toContain(r.outputType);
    expect(r.planQuote).toBeUndefined();
    expect(quoteRows(db)).toHaveLength(0);
    expect(usageRows(db)).toHaveLength(1);
  });
});
