import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AttentionCard, attentionItems } from "../src/components/admin/AttentionCard";

/** DT-20261118-06 phase 1A: «يحتاج انتباهك», the first card of the overview. The items are a pure function of the shell's alerts and providers and the overview's live numbers. */
const hOk = { ok: true, reason: "ok", httpStatus: 200, statusClass: "2xx", latencyMs: 10, checkedAt: "2026-11-18T09:00:00Z" };
const providers = (treg: Record<string, unknown> = {}, limits?: Record<string, unknown>) => ({
  llm: { enabled: true, provider: "anthropic", model: "m", keyEnv: "K", modelEnv: "M", keyConfigured: true, keyLast4: "abcd", health: hOk, lastUsage: null, fallbackReason: null, callsToday: 0, costTodayEgp: 0 },
  treg: { live: true, tokenConfigured: true, tokenLast4: "1234", health: hOk, baseUrl: "https://treg.to", lastCall: null, callsToday: 0, balance: { available: true, balanceUsd: 80, checkedAt: "2026-11-18T09:00:00Z" }, thresholdUsd: 25, lowBalance: false, ...treg },
  ...(limits ? { limits: { level: "ok", percent: 10, llmLevel: "ok", llmPercent: 5, ...limits } } : {}),
});
const alerts = (pendingTotal: number) => ({ pendingTotal });
const live = (stalled: number, stalledMinMinutes: number | null) => ({ live: { stalled, stalledMinMinutes } });
const LOW = "رصيد مزود البيانات منخفض: متبقٍ ١٢٫٤٠ دولار والحد المنبّه ٢٥ دولار.";

describe("attentionItems", () => {
  it("a TREG balance below its threshold gives the gold sentence, by the flag or by the numbers; a healthy balance gives nothing", () => {
    expect(attentionItems({ alerts: alerts(0), providers: providers({ balance: { available: true, balanceUsd: 12.4, checkedAt: "x" }, lowBalance: true }) as any, overview: live(0, null) }))
      .toEqual([{ level: "warn", text: LOW, actionLabel: "فتح", href: "/admin/providers" }]);
    expect(attentionItems({ alerts: null, providers: providers({ balance: { available: true, balanceUsd: 12.4, checkedAt: "x" }, lowBalance: undefined }) as any, overview: null }).map((i) => i.text)).toEqual([LOW]);
    expect(attentionItems({ alerts: alerts(0), providers: providers() as any, overview: live(0, null) })).toEqual([]);
    // an unknown balance is never reported as low
    expect(attentionItems({ alerts: null, providers: providers({ balance: { available: false, checkedAt: "x" }, lowBalance: false }) as any, overview: null })).toEqual([]);
  });

  it.each([
    [{ alerts: alerts(3), providers: null, overview: null }, [{ level: "warn", text: "٣ طلبات شحن بانتظار مراجعتك", actionLabel: "فتح", href: "/admin/topups" }]],
    [{ alerts: null, providers: providers({}, { level: "warn", percent: 56.4 }), overview: null }, [{ level: "warn", text: "بلغ الإنفاق اليومي ٥٦٪ من الحد المسموح.", actionLabel: "فتح", href: "/admin/providers" }]],
    [{ alerts: null, providers: providers({}, { level: "reached", percent: 100 }), overview: null }, [{ level: "bad", text: "بلغ الإنفاق اليومي ١٠٠٪ من الحد المسموح.", actionLabel: "فتح", href: "/admin/providers" }]],
    [{ alerts: null, providers: providers({}, { level: "ok", percent: 40 }), overview: null }, []],
    [{ alerts: null, providers: null, overview: live(2, 12) }, [{ level: "bad", text: "٢ مهام متوقفة منذ أكثر من ١٢ دقيقة.", actionLabel: "فتح", href: "/admin/operations" }]],
    [{ alerts: alerts(0), providers: null, overview: live(0, null) }, []],
  ])("pending top-ups, daily spend and stalled missions: %#", (input, expected) => {
    expect(attentionItems(input as any)).toEqual(expected);
  });

  it("the red items come first, then the gold ones", () => {
    const items = attentionItems({ alerts: alerts(1), providers: providers({ balance: { available: true, balanceUsd: 12.4, checkedAt: "x" }, lowBalance: true }) as any, overview: live(1, 15) });
    expect(items.map((i) => i.level)).toEqual(["bad", "warn", "warn"]);
  });
});

describe("AttentionCard", () => {
  const html = (items: Parameters<typeof AttentionCard>[0]["items"]) => renderToStaticMarkup(createElement(AttentionCard, { items }));

  it("empty: one calm sentence", () => {
    const h = html([]);
    expect(h).toContain("يحتاج انتباهك");
    expect(h).toContain("لا شيء يحتاج انتباهك الآن.");
  });

  it("an item is a sentence in its level's style with a 44 px link; gold for warn, red for bad; no emoji, no physical sides", () => {
    const h = html([{ level: "warn", text: LOW, actionLabel: "فتح", href: "/admin/providers" }, { level: "bad", text: "٢ مهام متوقفة منذ أكثر من ١٢ دقيقة.", actionLabel: "فتح", href: "/admin/operations" }]);
    expect(h).not.toContain("لا شيء يحتاج انتباهك الآن.");
    expect(h).toMatch(new RegExp(`data-level="warn"[^]*?text-goldT[^>]*>${LOW}<`));
    expect(h).toMatch(/data-level="bad"[^]*?text-bad[^>]*>٢ مهام متوقفة/);
    expect(h).toMatch(/<a[^>]*href="\/admin\/providers"[^>]*min-h-11|<a[^>]*min-h-11[^>]*href="\/admin\/providers"/);
    expect(h).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(h).not.toMatch(/\b(?:ml|mr|pl|pr)-|\b(?:left|right)-\d|text-(?:left|right)/);
  });
});
