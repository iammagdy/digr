import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BarList, Card, EmptyState, ErrorState, Meter, StatTile, TrendBars, deltaAr, meterPercent, trendStep } from "../src/components/admin/ui";
import { ConfirmDialog, confirmEnabled, trapFocusIndex } from "../src/components/admin/ConfirmDialog";

/** DT-20261118-06 phase 0: the shared admin pieces. The environment is node (no DOM), so behaviour lives in small pure helpers and the markup is checked as rendered HTML. */
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
const noop = () => {};
const dialog = (over: Record<string, unknown> = {}) => html(createElement(ConfirmDialog, { open: true, title: "تأكيد إضافة الرصيد", body: "ستُضاف ١٠٠ نقطة.", confirmLabel: "أؤكد الإضافة", onConfirm: noop, onCancel: noop, ...over }));
const buttonOf = (h: string, label: string) => h.split("<button").find((b) => b.includes(`>${label}</button>`)) ?? "";

describe("ConfirmDialog", () => {
  it("renders nothing when closed; open, it is a labelled modal dialog with 44 px buttons, the confirm button last and no emoji", () => {
    expect(dialog({ open: false })).toBe("");
    const h = dialog();
    expect(h).toMatch(/role="dialog"/);
    expect(h).toMatch(/aria-modal="true"/);
    const titleId = h.match(/aria-labelledby="([^"]+)"/)?.[1];
    expect(titleId).toBeTruthy();
    expect(h).toContain(`id="${titleId}"`);
    expect(buttonOf(h, "إلغاء")).toContain("min-h-11");
    expect(buttonOf(h, "أؤكد الإضافة")).toContain("min-h-11");
    expect(h.lastIndexOf(">أؤكد الإضافة<")).toBeGreaterThan(h.lastIndexOf(">إلغاء<"));
    expect(h).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("the confirm button is disabled while working and until the typed text equals typeToConfirm; an error shows as an alert", () => {
    expect(buttonOf(dialog(), "أؤكد الإضافة")).not.toContain('disabled=""');
    expect(buttonOf(dialog({ working: true }), "أؤكد الإضافة")).toContain('disabled=""');
    const typed = dialog({ typeToConfirm: "١٢٠" });
    expect(buttonOf(typed, "أؤكد الإضافة")).toContain('disabled=""');
    expect(typed).toMatch(/<input[^>]*inputMode="numeric"/);
    expect(dialog({ error: "تعذّرت الإضافة" })).toMatch(/role="alert"[^>]*>تعذّرت الإضافة</);
  });

  it.each([
    [{ typed: "", typeToConfirm: undefined, working: false }, true],
    [{ typed: "", typeToConfirm: undefined, working: true }, false],
    [{ typed: "١٢٠", typeToConfirm: "120", working: false }, true],
    [{ typed: " 1٬200 ", typeToConfirm: "١٢٠٠", working: false }, true],
    [{ typed: "12", typeToConfirm: "120", working: false }, false],
    [{ typed: "١٢٠", typeToConfirm: "120", working: true }, false],
  ])("confirmEnabled(%j) is %s (Arabic-Indic digits and group separators normalised)", (input, expected) => {
    expect(confirmEnabled(input)).toBe(expected);
  });

  it("the focus trap wraps forwards and backwards and enters from outside", () => {
    expect([trapFocusIndex(2, 3, false), trapFocusIndex(0, 3, true), trapFocusIndex(-1, 3, false), trapFocusIndex(-1, 3, true), trapFocusIndex(0, 0, false)]).toEqual([0, 2, 0, 2, -1]);
  });
});

describe("TrendBars", () => {
  const series = [{ label: "١/١١", value: 3, detail: "١/١١: ٣ زيارات" }, { label: "٢/١١", value: 0, detail: "٢/١١: لا زيارات" }, { label: "٣/١١", value: 9, detail: "٣/١١: ٩ زيارات" }];

  it("time runs right to left (oldest first in the DOM, no forced ltr); arrows move in the reading direction; Home/End jump", () => {
    const h = html(createElement(TrendBars, { label: "الزيارات", series, selected: null, onSelect: noop }));
    expect(h).not.toContain('dir="ltr"');
    expect(h.indexOf("١/١١: ٣ زيارات")).toBeLessThan(h.indexOf("٣/١١: ٩ زيارات"));
    expect([trendStep("ArrowLeft", 0, 3), trendStep("ArrowRight", 2, 3), trendStep("ArrowRight", 0, 3), trendStep("ArrowLeft", 2, 3), trendStep("Home", 2, 3), trendStep("End", 0, 3), trendStep("Enter", 1, 3), trendStep("ArrowLeft", 0, 0)]).toEqual([1, 1, 0, 2, 0, 2, null, null]);
  });

  it("a selected bar is pressed and its value is printed in the strip; with nothing selected the strip says how to select; an empty series says so", () => {
    const sel = html(createElement(TrendBars, { label: "الزيارات", series, selected: 2, onSelect: noop }));
    expect(sel).toMatch(/aria-pressed="true"[^>]*aria-label="٣\/١١: ٩ زيارات"/);
    expect(sel.split('data-testid="trend-strip"')[1].split("</p>")[0]).toContain("٣/١١: ٩ زيارات");
    expect(html(createElement(TrendBars, { label: "الزيارات", series, selected: null, onSelect: noop }))).toContain("اضغط عمودًا لرؤية اليوم");
    const empty = html(createElement(TrendBars, { label: "الزيارات", series: [], selected: null, onSelect: noop, emptyText: "لا زيارات مسجّلة في هذه الفترة." }));
    expect(empty).toContain("لا زيارات مسجّلة في هذه الفترة.");
    expect(empty).not.toContain("<button");
  });
});

describe("Meter, StatTile, BarList, Card, EmptyState, ErrorState", () => {
  it("Meter is a progressbar whose number is always printed; the fill is clamped", () => {
    expect([meterPercent(50, 200), meterPercent(500, 200), meterPercent(5, 0), meterPercent(-3, 10)]).toEqual([25, 100, 0, 0]);
    const h = html(createElement(Meter, { value: 87, max: 100, level: "ok", label: "نسبة النجاح" }));
    expect(h).toMatch(/role="progressbar"[^>]*aria-valuenow="87"/);
    expect(h).toContain("٨٧٪");
    expect(h).toContain("width:87%");
  });

  it("StatTile prints «—» for a missing value, steps the font down for long numbers, links when given an address; deltas use Arabic-Indic digits", () => {
    expect(html(createElement(StatTile, { label: "زيارات اليوم", value: null }))).toContain(">—<");
    expect(html(createElement(StatTile, { label: "بيعت", value: "١٬٢٣٤٬٥٦٧" }))).toContain("text-[24px]");
    expect(html(createElement(StatTile, { label: "بيعت", value: "٤٨" }))).toContain("text-[30px]");
    expect(html(createElement(StatTile, { label: "طلبات شحن معلّقة", value: "٣", href: "/admin/topups" }))).toMatch(/<a[^>]*href="\/admin\/topups"/);
    expect([deltaAr(3.24), deltaAr(-12), deltaAr(0)]).toEqual(["▲ ٣٫٢٪", "▼ ١٢٪", "▲ ٠٪"]);
  });

  it("BarList shows a sentence when empty and keeps a long label readable through its title", () => {
    expect(html(createElement(BarList, { rows: [], emptyText: "لا توجد بيانات في هذه الفترة." }))).toContain("لا توجد بيانات في هذه الفترة.");
    const h = html(createElement(BarList, { rows: [{ label: "دخول مباشر", value: 40 }, { label: "بحث", value: 10 }], emptyText: "—" }));
    expect(h).toContain('title="دخول مباشر"');
    expect(h).toContain("٤٠");
    expect(h).toContain("width:100%");
    expect(h).toContain("width:25%");
  });

  it("Card has a heading and an action; EmptyState is a sentence; ErrorState is an alert with a 44 px retry", () => {
    const c = html(createElement(Card, { title: "المهام", action: createElement("a", { href: "/admin/agent" }, "الوكيل") }, "x"));
    expect(c).toContain(">المهام</h2>");
    expect(c).toContain('href="/admin/agent"');
    expect(html(createElement(EmptyState, { title: "لا مهام في هذه الفترة." }))).toContain("لا مهام في هذه الفترة.");
    const e = html(createElement(ErrorState, { onRetry: noop }));
    expect(e).toMatch(/role="alert"/);
    expect(e).toContain("تعذّر تحميل هذه البطاقة.");
    expect(buttonOf(e, "أعد المحاولة")).toContain("min-h-11");
  });

  it("the new code uses logical properties only (no physical left/right classes or styles)", () => {
    for (const f of ["src/components/admin/ui.tsx", "src/components/admin/ConfirmDialog.tsx"]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/\b(ml|mr|pl|pr|left|right)-[\w[]|text-(left|right)\b|\b(marginLeft|marginRight|paddingLeft|paddingRight)\b|[{,]\s*(left|right):/);
    }
  });
});
