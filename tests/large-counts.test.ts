import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { extractNumberFromText } from "../src/lib/arabicNumbers";
import { understandRequest } from "../src/lib/requestUnderstanding";
import { createLatencyDb } from "./helpers/loadHarness";

const h = vi.hoisted(() => ({ db: null as any }));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async (token?: string) => ({ data: { user: token ? { id: String(token), email: `${token}@x.test`, email_confirmed_at: "2026-10-01T00:00:00Z", user_metadata: {} } : null }, error: token ? null : new Error("no session") })) },
  })),
  createAdminClient: vi.fn(() => h.db.client),
}));
vi.mock("../src/functions/shared/catalogClient", () => ({
  searchCatalog: vi.fn(async () => []),
  getCachedCatalogEndpoints: vi.fn(() => []),
  getEndpointDetails: vi.fn(async (id: string) => ({ id, catalogPriceUsd: 0.005, pointsPerUnit: 28 })),
}));
vi.mock("../src/lib/server/sendPlatformEmail", () => ({ sendPlatformEmail: vi.fn(async () => ({ ok: true })), getRecipient: vi.fn(async () => null) }));
vi.mock("../src/functions/shared/llmClient", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/functions/shared/llmClient")>();
  class NoModelClient extends original.LlmClient { async executeTurn(): Promise<never> { throw new Error("no model"); } }
  return { ...original, LlmClient: NoModelClient };
});
import { POST as chatRoute } from "../src/app/api/chat/route";

describe("a count written with a magnitude word is read as asked (up to the ceiling), not as its small part", () => {
  const cases: Array<[string, number | undefined]> = [
    ["٥ آلاف شركة", 5000], ["5k posts", 5000], ["٢ مليون تعليق", 100000], ["١٠ مليون تعليق على فيسبوك", 100000],
    ["عشرة آلاف تعليق على تيك توك", 10000], ["خمسين ألف منشور", 50000], ["مليون شركة", 100000], ["10 ملايين", 100000], ["مية ألف تعليق", 100000],
    // the readings that were right stay right
    ["ألف تعليق", 1000], ["ألفين منشور", 2000], ["١٠٠٠ تعليق", 1000], ["ألف وخمسمية تعليق", 1500], ["٥٠ شركة كهرباء", 50], ["عايز خمس شركات", 5], ["تلاتة صناع قرار", 3],
    ["في سنة 2024 تعليقات", undefined],
  ];
  for (const [text, expected] of cases) it(`${text} => ${expected}`, () => expect(extractNumberFromText(text)).toBe(expected));

  it("the understanding of such a request carries the count, so the plan can say how much of it fits", () => {
    expect(understandRequest("٥ آلاف تعليق على تيك توك عن كرة القدم").volume).toBe(5000);
    expect(understandRequest("٢ مليون تعليق على فيسبوك").volume).toBe(100000);
  });
});

describe("through the chat: a count the customer wrote is the plan's count, a very large one is cut with the reason, and the topic is only the topic", () => {
  beforeAll(() => {
    h.db = createLatencyDb({ tables: {} }, 0);
    for (const method of ["warn", "error", "log", "info"] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
  });
  const ask = async (user: string, message: string) => {
    const res = await chatRoute(new NextRequest("http://localhost:3000/api/chat", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${user}` }, body: JSON.stringify({ message }) }));
    expect(res.status).toBe(200);
    return res.json();
  };

  it("٥ آلاف تعليق: asked 5000, planned within the job's ceiling, the reason said plainly, the topic without «آلاف»", async () => {
    const body = await ask("big_1", "٥ آلاف تعليق على تيك توك عن كرة القدم خلال الشهر الماضي");
    const quote = body.planQuote;
    expect(quote.askedVolumeMax).toBe(5000);
    // the service's own ceiling (1,000 comments) limits this plan: at 0.275 points a comment its reserve is 317, well inside the cap of 600
    expect(quote.targetVolumeMax).toBe(1000);
    expect(quote.pointsCapConstrained).toBe(false);
    expect(quote.quotedPoints).toBe(317);
    expect(quote.quotedPoints).toBeLessThanOrEqual(600);
    expect(quote.items[0].params.query).toBe("كرة القدم");
    expect(body.contentAr).toContain("طلبت ٥٠٠٠");
    expect(body.contentAr).not.toContain("لأنك لم تحدد عددًا");
  });

  it("ثلاثين تعليق: the plan is for 30, not the default of 500", async () => {
    const body = await ask("big_2", "ثلاثين تعليق على تيك توك عن كرة القدم خلال الشهر الماضي");
    const quote = body.planQuote;
    expect(quote.targetVolumeMax).toBe(30);
    expect(quote.items[0].params.query).toBe("كرة القدم");
    expect(body.contentAr).not.toContain("قيمة افتراضية لأنك لم تحدد عددًا");
    expect(quote.quotedPoints).toBeLessThan(300);
  });

  it("a count in digits is unchanged: ٣٠ تعليق plans 30", async () => {
    const body = await ask("big_3", "٣٠ تعليق على تيك توك عن كرة القدم خلال الشهر الماضي");
    expect(body.planQuote.targetVolumeMax).toBe(30);
  });

  it("with no count at all the default is still shown as a default", async () => {
    const body = await ask("big_4", "تعليقات على تيك توك عن كرة القدم خلال الشهر الماضي");
    expect(body.contentAr).toContain("قيمة افتراضية لأنك لم تحدد عددًا");
  });
});
