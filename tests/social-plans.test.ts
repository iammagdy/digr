import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/functions/shared/catalogClient")>()),
  searchCatalog: vi.fn(async () => []),
  getCachedCatalogEndpoints: vi.fn(() => []),
}));

import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";

function makeMockTables() {
  const store = new Map<string, Map<string, any>>();
  const table = (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
  };
  const parseEqual = (q: string): [string, string[]] | null => {
    const m = /^equal\("([^"]+)",\s*(\[.*\]|".*")\)$/.exec(q.trim());
    if (!m) return null;
    try {
      const parsed = JSON.parse(m[2]);
      return [m[1], (Array.isArray(parsed) ? parsed : [parsed]).map(String)];
    } catch {
      return null;
    }
  };
  const parseLimit = (q: string): number | null => {
    const m = /^limit\((\d+)\)$/.exec(q.trim());
    return m ? parseInt(m[1], 10) : null;
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
      for (const q of queries) {
        const eq = typeof q === "string" ? parseEqual(q) : null;
        if (eq) {
          rows = rows.filter((r) => eq[1].includes(String(r[eq[0]])));
          continue;
        }
        const l = typeof q === "string" ? parseLimit(q) : null;
        if (l !== null) limit = l;
      }
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
  };
}

const ask = async (message: string) => {
  const res: any = await new ChatHandler(makeMockTables() as any).handleUserMessage({ userId: "u_social", message, userBalance: 20000 });
  return { res, item: res.planQuote?.items?.[0] as any, question: res.clarificationItems?.[0] as any };
};

const PROVIDER_WORDS = /tikhub|crawl4ai|scrapecreators|anyapi|brightdata|treg|usd|\$/i;

describe("a researcher's social request becomes the right plan or the one missing question", () => {
  beforeEach(() => clearBriefCacheForTesting());

  it("comments of a YouTube link: the verified capability, the link, the stated count, priced per comment", async () => {
    const { res, item } = await ask("هات ٢٠ كومنت من https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(res.outputType).toBe("propose_plan");
    expect(item.capabilitySlug).toBe("social-youtube-comments");
    expect(item.params).toEqual({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    expect(item.targetVolumeMax).toBe(20);
    expect(res.planQuote.expectedPoints).toBe(res.planQuote.unitPricePoints * 20);
    expect(res.planQuote.quotedPoints).toBe(Math.ceil(res.planQuote.expectedPoints * 1.15));
  });

  it("comments of a Facebook post link", async () => {
    const { res, item } = await ask("اسحب ١٠ تعليقات من https://www.facebook.com/nasa/posts/123456");
    expect(res.outputType).toBe("propose_plan");
    expect(item.capabilitySlug).toBe("social-facebook-comments");
    expect(item.params.url).toBe("https://www.facebook.com/nasa/posts/123456");
    expect(item.targetVolumeMax).toBe(10);
  });

  it("'كومنتس' with no link asks only for the link (the case that used to pick a 364-point post search)", async () => {
    for (const text of ["عايز كومنتس بوست على فيسبوك", "كومنتس فيديو تيك توك", "هات كومنتات فيديو يوتيوب"]) {
      const { res, question } = await ask(text);
      expect(res.outputType, text).toBe("ask_clarification");
      expect(question.id, text).toBe("social_comment_target_required");
      expect(res.planQuote, text).toBeUndefined();
    }
  });

  it("trending asks the country (with options) and never assumes one", async () => {
    const { res, question } = await ask("الفيديوهات الستراندنج على تيك توك");
    expect(res.outputType).toBe("ask_clarification");
    expect(question.id).toBe("social_trending_region_required");
    expect(question.options).toContain("مصر");
  });

  it("trending videos in a named country: the country becomes the region of the verified capability", async () => {
    const { res, item } = await ask("عايز ٢٠ فيديو ترند في مصر على تيك توك");
    expect(res.outputType).toBe("propose_plan");
    expect(item.capabilitySlug).toBe("social-tiktok-videos");
    expect(item.params).toEqual({ trending: true, region: "EG" });
    expect(item.targetVolumeMax).toBe(20);
  });

  it("trending videos with their comments is one plan on the comments capability", async () => {
    const { res, item } = await ask("عايز ٣٠ كومنت من فيديوهات ترند في مصر على تيك توك");
    expect(res.outputType).toBe("propose_plan");
    expect(item.capabilitySlug).toBe("social-tiktok-comments");
    expect(item.params).toEqual({ trending: true, region: "EG" });
    expect(item.targetVolumeMax).toBe(30);
    expect(res.contentAr).toContain("الفيديوهات الرائجة");
  });

  it("a channel's videos", async () => {
    const { res, item } = await ask("هات ١٠ فيديوهات من قناة @zachking على تيك توك");
    expect(res.outputType).toBe("propose_plan");
    expect(item.capabilitySlug).toBe("social-tiktok-videos");
    expect(item.params).toEqual({ channel: "@zachking" });
  });

  it("comments of videos about a subject: the subject, not the whole sentence, is searched", async () => {
    const { res, item } = await ask("عايز ١٠٠ كومنت من فيديوهات عن القهوة على يوتيوب");
    expect(res.outputType).toBe("propose_plan");
    expect(item.capabilitySlug).toBe("social-youtube-comments");
    expect(item.params).toEqual({ query: "القهوة" });
    expect(item.targetVolumeMax).toBe(57);
    expect(res.contentAr).toContain("٥٧");
    expect(res.contentAr).toContain("«القهوة»");
  });

  it("a period the customer did not ask for is never added (it would silently discard older comments)", async () => {
    for (const text of ["هات ٢٠ كومنت من https://www.youtube.com/watch?v=dQw4w9WgXcQ", "عايز ٣٠ كومنت من فيديوهات ترند في مصر على تيك توك"]) {
      const { item } = await ask(text);
      expect(item.params, text).not.toHaveProperty("dateFrom");
      expect(item.params, text).not.toHaveProperty("dateTo");
    }
  });

  it("a period the customer did ask for is applied", async () => {
    const { item } = await ask("هات ٢٠ كومنت من https://www.youtube.com/watch?v=dQw4w9WgXcQ خلال آخر ٣ شهور");
    expect(item.params.dateFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(item.params.dateTo).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("trending on a platform with no verified trending feed is said plainly with the two that have one", async () => {
    const { res, question } = await ask("ترند فيسبوك");
    expect(res.outputType).toBe("ask_clarification");
    expect(question.id).toBe("social_trending_platform_required");
    expect(question.options).toEqual(["تيك توك", "يوتيوب"]);
  });

  it("a count above what the sources can return is brought down to it, not refused", async () => {
    const { item } = await ask("هات ٥٠٠ فيديو من قناة @veritasium على يوتيوب");
    expect(item.capabilitySlug).toBe("social-youtube-videos");
    expect(item.targetVolumeMax).toBeLessThanOrEqual(48);
  });

  it("customer-facing text is Arabic only and names no provider, endpoint or dollar amount", async () => {
    for (const text of [
      "هات ٢٠ كومنت من https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "عايز ٣٠ كومنت من فيديوهات ترند في مصر على تيك توك",
      "هات ١٠ فيديوهات من قناة @zachking على تيك توك",
    ]) {
      const { res } = await ask(text);
      expect(res.contentAr, text).not.toMatch(PROVIDER_WORDS);
      expect(res.contentAr.replace(/https?:\/\/\S+/g, ""), text).not.toMatch(/[A-Za-z]/);
    }
  });
});
