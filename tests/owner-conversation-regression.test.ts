import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/functions/shared/catalogClient", () => ({
  searchCatalog: vi.fn(async () => []),
  getCachedCatalogEndpoints: vi.fn(() => []),
}));

import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { postApprovalMessageAr } from "../src/lib/postApproval";

/** In-memory tables that honour the equal / orderDesc / limit queries the handler uses for history. */
function makeTables() {
  const store = new Map<string, Map<string, any>>();
  const table = (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
  };
  return {
    async createRow({ tableId, rowId, data }: any) {
      const id = rowId || `row_${Math.random().toString(36).slice(2)}`;
      const doc = { $id: id, ...data };
      table(tableId).set(id, doc);
      return doc;
    },
    async getRow({ tableId, rowId }: any) {
      const doc = table(tableId).get(rowId);
      if (!doc) throw new Error("row not found");
      return doc;
    },
    async listRows({ tableId, queries = [] }: any) {
      let rows = [...table(tableId).values()];
      let limit: number | null = null;
      let desc: string | null = null;
      for (const q of queries as string[]) {
        const eq = /^equal\("([^"]+)",\s*(.*)\)$/.exec(q.trim());
        if (eq) {
          const parsed = JSON.parse(eq[2]);
          const values = (Array.isArray(parsed) ? parsed : [parsed]).map(String);
          rows = rows.filter((row) => values.includes(String(row[eq[1]])));
          continue;
        }
        const ord = /^orderDesc\("([^"]+)"\)$/.exec(q.trim());
        if (ord) desc = ord[1];
        const lim = /^limit\((\d+)\)$/.exec(q.trim());
        if (lim) limit = Number(lim[1]);
      }
      if (desc) rows.sort((a, b) => String(b[desc!]).localeCompare(String(a[desc!])));
      if (limit !== null) rows = rows.slice(0, limit);
      return { total: rows.length, rows };
    },
    async updateRow({ tableId, rowId, data }: any) {
      const prev = table(tableId).get(rowId);
      if (!prev) throw new Error("row not found");
      const doc = { ...prev, ...data };
      table(tableId).set(rowId, doc);
      return doc;
    },
    __rows: (name: string) => [...table(name).values()],
  };
}

const PROFILE = { name: "سلمى" };
const STARTED = /جاري سحب البيانات/;
const nextTick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("A6: the owner's exact conversation, offline", () => {
  beforeEach(() => clearBriefCacheForTesting());
  afterEach(() => clearBriefCacheForTesting());

  it("plan card, approval, completion, then the email question gets a conversational offer instead of a second card", async () => {
    const tables = makeTables();
    const handler = new ChatHandler(tables as any);

    // 1. The request: a plan card, priced by the code, Excel only, no «started» wording.
    const first: any = await handler.handleUserMessage({
      userId: "owner_test_user",
      message: "عايز ٣ شركات كهرباء في مصر",
      userBalance: 692,
      personaProfile: PROFILE,
    });
    expect(first.outputType).toBe("propose_plan");
    expect(first.planQuote).toBeDefined();
    expect(first.planQuote.outputFormats).toEqual(["xlsx"]);
    expect(first.planQuote.items[0].capabilitySlug).toBe("icypeas-companies-search");
    // 3 company records at 3.168 points (measured cost 0.000576 USD x 5,500): charge 10, reserve 11 (the live ledger of the old whole-point price was 9 and 11).
    expect(first.planQuote.quotedPoints).toBe(11);
    expect(first.contentAr).toContain("التكلفة المتوقعة: ١٠ نقطة");
    expect(first.contentAr).not.toMatch(STARTED);
    expect(JSON.stringify(first.planQuote)).not.toMatch(STARTED);

    // 2. Approval (accept-quote succeeds): the page appends the started message, then the worker's completion line.
    const conversationId = first.conversationId;
    const userRow = tables.__rows("messages").find((row: any) => row.role === "user" && row.conversationId === conversationId);
    await tables.updateRow({ tableId: "messages", rowId: userRow.$id, data: { requestStatus: "accepted", requestQuoteId: first.planQuote.quoteId } });
    await nextTick();
    await tables.createRow({
      tableId: "messages",
      data: { conversationId, userId: "owner_test_user", role: "assistant", content: postApprovalMessageAr("tab"), status: "ready", createdAt: new Date().toISOString() },
    });
    await nextTick();
    await tables.createRow({
      tableId: "messages",
      data: { conversationId, userId: "owner_test_user", role: "assistant", content: "تم إكمال استخراج ٣ سجل بنجاح وحفظ ملفات النتائج.", status: "ready", createdAt: new Date().toISOString() },
    });
    await nextTick();

    // 3. The follow-up in the owner's own words.
    const reply: any = await handler.handleUserMessage({
      userId: "owner_test_user",
      conversationId,
      message: "فين الايميلات بتاعت الشركات دي؟",
      userBalance: 692,
      personaProfile: PROFILE,
    });

    // A conversational answer, not a card.
    expect(reply.outputType).toBe("answer_question");
    expect(reply.planQuote).toBeUndefined();
    expect(reply.clarificationQuestions).toBeUndefined();
    expect(reply.contentAr).not.toContain("أعددت لك خطة الاستخراج");
    expect(reply.contentAr).not.toBe(first.contentAr);

    // The decision-makers offer, with the code's numbers: 579 expected, 600 reserved.
    expect(reply.contentAr).toContain("بحث الشركات يعرض بيانات الشركة، ولا يشمل بريد الأشخاص");
    expect(reply.contentAr).toContain("صناع قرار");
    expect(reply.contentAr).toContain("السعر المتوقع ٥٧٩ نقطة");
    expect(reply.contentAr).toContain("الحجز المتوقع ٦٦٦ نقطة");
    expect(reply.contentAr).toContain("لا يُحجز رصيد قبل موافقتك");

    // Exactly one yes/no question, and it is the last sentence.
    expect((reply.contentAr.match(/؟/g) || []).length).toBe(1);
    expect(reply.contentAr.trim().endsWith("هل تريد أن أجهز الخطة؟")).toBe(true);

    // Arabic only: no English words, emoji, or provider wording.
    expect(reply.contentAr).not.toMatch(/[A-Za-z]/);
    expect(reply.contentAr).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(reply.contentAr).not.toMatch(/icypeas|tikhub|scrapecreators|anyapi|endpoint/i);

    // No repeated card across the whole conversation, and «started» never preceded the approval.
    const assistantRows = tables.__rows("messages")
      .filter((row: any) => row.conversationId === conversationId && row.role === "assistant")
      .sort((a: any, b: any) => String(a.createdAt).localeCompare(String(b.createdAt)));
    expect(assistantRows.filter((row: any) => row.quote?.quoteId).length).toBeLessThanOrEqual(1);
    const startedAt = assistantRows.findIndex((row: any) => STARTED.test(String(row.content)));
    const planAt = assistantRows.findIndex((row: any) => String(row.content).includes("أعددت لك خطة الاستخراج"));
    expect(planAt).toBeGreaterThanOrEqual(0);
    expect(startedAt).toBeGreaterThan(planAt);
    expect(assistantRows.slice(0, startedAt).some((row: any) => STARTED.test(String(row.content)))).toBe(false);
    expect(STARTED.test(reply.contentAr)).toBe(false);
  });

  it("the same follow-up asked while the plan is still pending also gets the offer and no second card", async () => {
    const tables = makeTables();
    const handler = new ChatHandler(tables as any);
    const first: any = await handler.handleUserMessage({
      userId: "owner_test_user_2",
      message: "عايز ٣ شركات كهرباء في مصر",
      userBalance: 692,
      personaProfile: PROFILE,
    });
    await nextTick();
    const reply: any = await handler.handleUserMessage({
      userId: "owner_test_user_2",
      conversationId: first.conversationId,
      message: "فين الايميلات بتاعت الشركات دي؟",
      userBalance: 692,
      personaProfile: PROFILE,
    });
    expect(reply.outputType).toBe("answer_question");
    expect(reply.planQuote).toBeUndefined();
    expect(reply.contentAr).toContain("السعر المتوقع ٥٧٩ نقطة");
    expect(reply.contentAr).toContain("الحجز المتوقع ٦٦٦ نقطة");
    expect((reply.contentAr.match(/؟/g) || []).length).toBe(1);
  });
});

describe("A2: «جاري سحب البيانات» appears only after an explicit approval", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
    });

  it("the sentence has exactly one source and exactly one place that shows it", () => {
    const users = walk("src").filter((file) => readFileSync(file, "utf8").includes("postApprovalMessageAr"));
    expect(users.map((file) => file.replaceAll("\\", "/")).sort()).toEqual([
      "src/app/dashboard/chat/page.tsx",
      "src/lib/postApproval.ts",
    ]);
    // No server code, plan text, system prompt or other component spells the phrase out.
    const spelledOut = walk("src").filter((file) => /جاري سحب البيانات/.test(readFileSync(file, "utf8")));
    expect(spelledOut.map((file) => file.replaceAll("\\", "/"))).toEqual(["src/lib/postApproval.ts"]);
  });

  it("it is shown only inside the approval handler, after accept-quote succeeded, and that handler runs only from the plan card's approve button", () => {
    const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    const handler = page.slice(page.indexOf("async function handleStartExecution("), page.indexOf("// Download File Handler"));
    expect(handler).toContain('fetch("/api/chat/accept-quote"');
    expect(handler).toContain("explicitApproval: true");
    const accepted = handler.indexOf("if (!res.ok || !data.success)");
    expect(accepted).toBeGreaterThan(-1);
    expect(handler.indexOf("content: postApprovalMessageAr(data.driverMode)")).toBeGreaterThan(accepted);
    // The throw on failure comes first, so a refused approval never reaches the message.
    expect(handler.slice(accepted, accepted + 160)).toContain("throw new Error");
    // The only use in the page, and the only caller of the handler is the card's onStart.
    expect(page.match(/postApprovalMessageAr/g)!.length).toBe(2); // import + the one push
    expect(page.match(/handleStartExecution/g)!.length).toBe(2); // definition + onStart wiring
    expect(page).toContain("onStart={handleStartExecution}");
    const card = readFileSync("src/app/dashboard/chat/components/PlanQuoteCard.tsx", "utf8");
    expect(card.match(/onStart\(quote/g)!.length).toBe(1);
    // the approve click also carries the customer's own confirmation of a reserve above 600 points (a tick), never an inferred one
    expect(card).toContain("onClick={() => onStart(quote, { confirmedLargeReserve: !needsLargeConfirm || largeReserveConfirmed })}");
  });

  it("the accept-quote route refuses a request that is not an explicit approval", () => {
    const route = readFileSync("src/app/api/chat/accept-quote/route.ts", "utf8");
    const guard = route.indexOf("if (!hasExplicitQuoteApproval(body))");
    expect(guard).toBeGreaterThan(-1);
    // The refusal returns before anything is accepted, reserved or dispatched.
    expect(route.slice(guard, guard + 220)).toContain("status: 400");
    expect(guard).toBeLessThan(route.indexOf("acceptQuoteSupabase("));
    expect(guard).toBeLessThan(route.indexOf("dispatchWorkerChunk("));
  });
});
