import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryDb } from "./helpers/memoryDb";
import { customerMissionView, priceExplainOf, PRICE_PROMISE_AR } from "../src/lib/agentMission/customerView";
import { publicPlanOf } from "../src/lib/agentMission/overLimit";
import { requestTextForCustomer } from "../src/lib/agentMission/customerActions";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { RETYPE_NOTE_AR } from "../src/components/mission/PlanEditor";
import { AgentMissionCardBody } from "../src/components/mission/AgentMissionCard";
import { setChatModelForTesting } from "../src/lib/agentMission/chatModel";
import { COSMETICS_PLAN, OPEN_ID, runJourneyCase } from "../evals/customer-journey/runner";
import { ORIGINAL_REQUEST } from "../evals/customer-journey/corpus";

/**
 * ROUND 57: THE PLAN CARD SAYS WHAT THE PRICE COUNTS AND WHAT THE HOLD IS (13 Nov: «٣٢» read as 32 companies when the plan was 20 companies and 12 contact rows; the hold 374 next to the price 325 was never explained), and
 * «اكتب الطلب من جديد» never cancels the plan before a new request is sent. No price, hold or charge changes: the sentences are written from the plan's own numbers.
 */
const PUBLIC = publicPlanOf(JSON.parse(JSON.stringify(COSMETICS_PLAN)));
afterEach(() => { setChatModelForTesting(null); vi.restoreAllMocks(); });

describe("the card's price explanation", () => {
  it("the cosmetics plan: each step's count and the hold as price + margin, in its own numbers", () => {
    expect(priceExplainOf(PUBLIC)).toEqual([
      // ROUND 58 CHANGED: the priced total is said to be items, with the companies' own count (was «…، والمجموع ٣٢.»; the customer read it as 32 companies)
      "السعر محسوب على كل عنصر يُسلَّم من كل خطوة: ٢٠ من «شركات مستحضرات التجميل في مصر من خرائط جوجل» و١٢ من «بيانات التواصل المنشورة في الموقع الرسمي لكل شركة»، والمجموع ٣٢ عنصرًا محسوبًا في السعر، وعدد الشركات فيها ٢٠ فقط، لا ٣٢.",
      "الحجز المؤقت ٣٧٤ نقطة = أقصى السعر ٣٢٥ نقطة + هامش أمان ٤٩ نقطة؛ وهو ليس خصمًا، ولا يُخصم أكثر من أقصى السعر، ويُحرَّر ما لا يُستخدم منه بعد التسليم.",
    ]);
    for (const line of priceExplainOf(PUBLIC)) expect(checkCustomerText(line, { maxChars: 400 }).issues, line).toEqual([]);
  });
  it("one step, and a hold equal to the price (the minimum applied): nothing to add", () => {
    const one = { ...PUBLIC, stages: [PUBLIC.stages[0]], price: { ...PUBLIC.price, max_charge_points: 200, reserve_points: 200 } };
    expect(priceExplainOf(one)).toEqual([]);
  });
  it("is drawn on the card under the unchanged promise sentence; the price and the hold cells are unchanged", () => {
    const v = customerMissionView({ mission: { id: OPEN_ID, status: "plan_ready", question_ar: null, plan_public: PUBLIC, reserved_points: 374, unit_price_points: 10.144063, delivered_units: null, charged_points: null, summary_ar: null, files: null, created_at: new Date().toISOString() } as any, events: [], queue: null, now: Date.now() });
    expect(v.priceNoteAr).toBe(PRICE_PROMISE_AR);
    expect(v.priceFacts.filter((f) => f.labelAr !== "الوقت المتوقع")).toEqual([{ labelAr: "السعر حتى", valueAr: "٣٢٥ نقطة" }, { labelAr: "حجز مؤقت", valueAr: "٣٧٤ نقطة" }]);
    const html = renderToStaticMarkup(createElement(AgentMissionCardBody, { view: v, isGuest: false }));
    expect(html).toContain('data-testid="agent-price-explain"');
    expect(html).toContain("هامش أمان ٤٩ نقطة");
    expect(html).toContain("٢٠ من «شركات مستحضرات التجميل في مصر من خرائط جوجل»");
  });
});

describe("«اكتب الطلب من جديد» reads the words back and changes nothing", () => {
  it("returns the request's words; the plan stays plan_ready; another customer's mission is not found", async () => {
    const db: any = createMemoryDb();
    db.seed("missions", [{ id: OPEN_ID, user_id: "u-owner", status: "plan_ready", request_text: ORIGINAL_REQUEST }]);
    expect(await requestTextForCustomer(db, { id: OPEN_ID, userId: "u-owner" })).toEqual({ ok: true, requestText: ORIGINAL_REQUEST });
    expect(db.rows("missions")[0].status).toBe("plan_ready");
    expect(await requestTextForCustomer(db, { id: OPEN_ID, userId: "u-other" })).toMatchObject({ ok: false, status: 404 });
  });
  it("the editor says what it does before it is pressed", () => {
    expect(checkCustomerText(RETYPE_NOTE_AR, { maxChars: 400 }).issues).toEqual([]);
    expect(RETYPE_NOTE_AR).toContain("الخطة الحالية تفضل زي ما هي");
  });
  it("a request retyped in full and sent as a change is the request itself, never joined to its own copy", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    setChatModelForTesting(async () => ({ ok: true, text: JSON.stringify({ type: "edit_of_open_request", reason: "t", reply: "", count: null }) }));
    const retyped = `${ORIGINAL_REQUEST} وكمان عايز صفحة الفيسبوك لكل شركة.`;
    const [t] = await runJourneyCase({ id: "RETYPE", kind: "C_revision", title: "retyped", turns: [retyped], expect: { keepPlan: false, newMission: "allowed" } }, []);
    expect(t.newMissions.filter((m) => m.status !== "cancelled").map((m) => m.request)).toEqual([retyped]);
  });
});
