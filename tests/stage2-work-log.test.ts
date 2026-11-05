import { describe, expect, it } from "vitest";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { WORK_LOG_CODES, WORK_LOG_NOUNS, workLogFromEvents, workLogLine, type WorkLogEvent } from "../src/lib/agentMission/stage2/workLog";

/**
 * STAGE 2 (docs/STAGE-2.md), «دفتر شغل»: one Arabic line per event, from a FIXED map of event codes written in code. Arabic-Indic numerals, Cairo time, no provider, endpoint, dollar or model
 * vendor. An unknown code, or a code without the number its sentence needs, gives NOTHING (never free text).
 */
const AT = "2026-11-04T08:35:00Z"; // 10:35 in Cairo (UTC+2 in November)
const full = (code: string): WorkLogEvent => ({ code, at: AT, n: 12, total: 40, promised: 100, noun: "comments" }) as WorkLogEvent;

describe("every code renders one Arabic line", () => {
  it.each([...WORK_LOG_CODES])("%s", (code) => {
    const line = workLogLine(full(code));
    expect(line).not.toBeNull();
    expect(checkCustomerText(line!.textAr).issues).toEqual([]);
    expect(line!.timeAr).toBe("١٠:٣٥");
    expect(line!.textAr).not.toMatch(/[0-9]/);
  });
  it("the numbers are Arabic-Indic, the nouns agree with the number", () => {
    expect(workLogLine({ code: "items_saved", at: AT, n: 12, total: 40, promised: 100, noun: "comments" })!.textAr).toBe("أضفنا ١٢ تعليقًا، والمجموع الآن ٤٠ من ١٠٠.");
    expect(workLogLine({ code: "items_saved", at: AT, n: 2, total: 2, promised: 2, noun: "videos" })!.textAr).toBe("أضفنا فيديوهين، والمجموع الآن ٢ من ٢.");
    expect(workLogLine({ code: "duplicates_removed", at: AT, n: 3, noun: "tweets" })!.textAr).toBe("حذفنا ٣ تغريدات مكررة تمامًا، ولم نحذف شيئًا غيرها.");
    // S11 wording review: a hundred and up follows the last two digits («١٠٠ تعليق», never «١٠٠ تعليقًا»); «X من N» is digits only
    expect(workLogLine({ code: "items_saved", at: AT, n: 100, total: 200, promised: 300, noun: "comments" })!.textAr).toBe("أضفنا ١٠٠ تعليق، والمجموع الآن ٢٠٠ من ٣٠٠.");
    expect(workLogLine({ code: "gap_stated", at: AT, n: 40, promised: 100, noun: "comments" })!.textAr).toBe("أعطانا المصدر ٤٠ من ١٠٠ فقط، وكتبنا ذلك في الملف.");
  });
});

describe("unknown or incomplete events give nothing", () => {
  it("an unknown code gives null, whatever it carries", () => {
    expect(workLogLine({ code: "provider_timeout_tikhub", at: AT, n: 1 } as unknown as WorkLogEvent)).toBeNull();
    expect(workLogLine({ code: "", at: AT } as unknown as WorkLogEvent)).toBeNull();
    expect(workLogLine({ code: "toString", at: AT } as unknown as WorkLogEvent)).toBeNull();
  });
  it("a code whose sentence needs a number or a noun gives null without it", () => {
    expect(workLogLine({ code: "items_saved", at: AT, noun: "comments" })).toBeNull();
    expect(workLogLine({ code: "items_saved", at: AT, n: 3, total: 3 })).toBeNull();
    expect(workLogLine({ code: "stage_started", at: AT, noun: "nonsense" as never })).toBeNull();
    expect(workLogLine({ code: "items_saved", at: AT, n: -1, total: 3, noun: "comments" })).toBeNull();
  });
  it("an event with a bad time gives null", () => {
    expect(workLogLine({ code: "file_ready", at: "not a date" })).toBeNull();
  });
  it("the free words an event may carry are never shown (only the code's fixed sentence)", () => {
    const e = { code: "file_ready", at: AT, message: "tikhub returned 0.002 USD" } as unknown as WorkLogEvent;
    expect(workLogLine(e)!.textAr).toBe("الملف جاهز للتنزيل.");
  });
});

describe("no forbidden word in any line", () => {
  const catalog = loadTregCatalog();
  const providers = [...new Set([...catalog.byId.values()].map((e) => e.provider.toLowerCase()))].filter((p) => p.length >= 3);
  const vendors = ["anthropic", "claude", "openai", "gpt", "gemini", "haiku", "sonnet", "opus", "أنثروبيك", "كلود", "هايكو", "سونيت", "أوبس"];
  it("no provider name of the catalog, no endpoint id, no dollar, no model vendor, for every code, every noun and several numbers", () => {
    expect(providers.length).toBeGreaterThan(10);
    for (const code of WORK_LOG_CODES) for (const noun of WORK_LOG_NOUNS) for (const n of [0, 1, 2, 3, 11, 1500]) {
      const line = workLogLine({ code, at: AT, n, total: n, promised: n + 5, noun });
      if (!line) continue;
      const t = line.textAr.toLowerCase();
      for (const p of providers) expect(t.includes(p), `${code} ${noun} ${p}`).toBe(false);
      for (const v of vendors) expect(t.includes(v), `${code} ${v}`).toBe(false);
      expect(t).not.toMatch(/\$|usd|دولار|[a-z]{2,}|\.[a-z]+\./);
      expect(checkCustomerText(line.textAr).issues, `${code} ${noun} ${n}`).toEqual([]);
    }
  });
});

describe("the stored live events become work-log lines by their NUMBERS only (never their words)", () => {
  const plan = { stages: [{ key: "videos", title_ar: "الفيديوهات", parent_key: null, deliver: true, planned_rows: 2 }, { key: "comments", title_ar: "التعليقات", parent_key: "videos", deliver: true, planned_rows: 40 }] };
  it("a «saved» progress event and a «pages» progress event; any other event gives nothing", () => {
    const events = [
      { kind: "progress", created_at: "2026-11-04T08:30:00Z", message_ar: "يجمع الوكيل الصفحات من المصدر صفحة بعد صفحة", counts: { pages: 3, rows: 57, planned: 40 } },
      { kind: "progress", created_at: "2026-11-04T08:31:00Z", message_ar: "يحفظ الوكيل ما جمعه لمرحلة «التعليقات»", counts: { stage: 2, saved: 30, planned: 40 } },
      { kind: "call", created_at: "2026-11-04T08:32:00Z", message_ar: "anyapi.tiktok.video.comments 0.001 USD", counts: { adm_flag: 1 } },
      { kind: "progress", created_at: "2026-11-04T08:33:00Z", message_ar: "x", counts: { stage: 9, saved: 1, planned: 1 } },
    ];
    const lines = workLogFromEvents(plan, events);
    expect(lines.map((l) => [l.code, l.textAr])).toEqual([
      ["page_read", "قرأنا ٣ صفحات من المصدر حتى الآن."],
      ["items_saved", "أضفنا ٣٠ تعليقًا، والمجموع الآن ٣٠ من ٤٠."],
    ]);
    expect(lines.map((l) => l.timeAr)).toEqual(["١٠:٣٠", "١٠:٣١"]);
  });
});
