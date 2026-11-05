import { describe, expect, it } from "vitest";
import { composeLaunchAnnouncement } from "../src/lib/launch/announcement";

const ALL_ON = {
  DIGER_STAGE2_LIVE_SHEET: "on", DIGER_STAGE2_ASK_CARD: "on",
  DIGER_STAGE3_COMPANIES: "on", DIGER_STAGE3_QUEUE: "on",
  DIGER_STAGE4_REVIEW: "on", DIGER_STAGE4_EDITS: "on", DIGER_STAGE4_APPROVAL: "on",
};
const items = (a: NonNullable<ReturnType<typeof composeLaunchAnnouncement>>) => [a.Item1, a.Item2, a.Item3, a.Item4, a.Item5, a.Item6].filter(Boolean);
const text = (a: any) => JSON.stringify(a);

describe("composeLaunchAnnouncement: truth table over flag modes", () => {
  it("nothing live (empty env, or every flag off) returns null: the always-true download bullet alone never justifies a send", () => {
    expect(composeLaunchAnnouncement({})).toBeNull();
    expect(composeLaunchAnnouncement(Object.fromEntries(Object.keys(ALL_ON).map((k) => [k, "off"])))).toBeNull();
  });

  it.each(["allowlist", "test", "", "true", "1", "yes", "ON!", "onn"])("a flag set to %j is NOT announced", (mode) => {
    const env = Object.fromEntries(Object.keys(ALL_ON).map((k) => [k, mode]));
    expect(composeLaunchAnnouncement(env)).toBeNull();
  });

  it("only «on» announces; each feature adds exactly its own sentence", () => {
    const sheet = composeLaunchAnnouncement({ DIGER_STAGE2_LIVE_SHEET: "on" })!;
    expect(items(sheet)[0]).toContain("جدول حيّ لنتائجك");
    expect(items(sheet).some((i) => i.includes("فهمنا طلبك"))).toBe(false);

    const ask = composeLaunchAnnouncement({ DIGER_STAGE2_ASK_CARD: "on" })!;
    expect(items(ask)[0]).toContain("فهمنا طلبك");
    expect(items(ask).some((i) => i.includes("جدول حيّ"))).toBe(false);
  });

  it("Stage 3 needs BOTH companies and queue; Stage 4 needs its flag AND approval", () => {
    expect(composeLaunchAnnouncement({ DIGER_STAGE3_COMPANIES: "on" })).toBeNull();
    expect(composeLaunchAnnouncement({ DIGER_STAGE3_QUEUE: "on" })).toBeNull();
    expect(composeLaunchAnnouncement({ DIGER_STAGE3_COMPANIES: "on", DIGER_STAGE3_QUEUE: "allowlist" })).toBeNull();
    expect(items(composeLaunchAnnouncement({ DIGER_STAGE3_COMPANIES: "on", DIGER_STAGE3_QUEUE: "on" })!)[0]).toContain("ترتيب الدور");

    expect(composeLaunchAnnouncement({ DIGER_STAGE4_REVIEW: "on" })).toBeNull();
    expect(composeLaunchAnnouncement({ DIGER_STAGE4_APPROVAL: "on" })).toBeNull();
    expect(composeLaunchAnnouncement({ DIGER_STAGE4_EDITS: "on" })).toBeNull();
    expect(composeLaunchAnnouncement({ DIGER_STAGE4_REVIEW: "on", DIGER_STAGE4_APPROVAL: "allowlist" })).toBeNull();
    expect(items(composeLaunchAnnouncement({ DIGER_STAGE4_REVIEW: "on", DIGER_STAGE4_APPROVAL: "on" })!)[0]).toContain("تقرير مراجعة");
    expect(items(composeLaunchAnnouncement({ DIGER_STAGE4_EDITS: "on", DIGER_STAGE4_APPROVAL: "on" })!)[0]).toContain("تعديلات مدعومة");
  });

  it("the money sentence appears only together with a Stage 4 sentence", () => {
    const money = "لا نحجز نقاطك إلا بعد أن تعتمد السعر";
    for (const env of [{ DIGER_STAGE2_LIVE_SHEET: "on" }, { DIGER_STAGE2_ASK_CARD: "on" }, { DIGER_STAGE3_COMPANIES: "on", DIGER_STAGE3_QUEUE: "on" }]) {
      expect(text(composeLaunchAnnouncement(env)), JSON.stringify(env)).not.toContain(money);
    }
    expect(text(composeLaunchAnnouncement({ DIGER_STAGE4_REVIEW: "on", DIGER_STAGE4_APPROVAL: "on" }))).toContain(money);
    expect(text(composeLaunchAnnouncement({ DIGER_STAGE4_EDITS: "on", DIGER_STAGE4_APPROVAL: "on" }))).toContain(money);
  });

  it("a Stage 4 sentence that is NOT on never drags in its claim: «السعر يظهر لك قبل أي حجز» is absent without the review flags", () => {
    expect(text(composeLaunchAnnouncement({ DIGER_STAGE2_LIVE_SHEET: "on", DIGER_STAGE4_REVIEW: "on", DIGER_STAGE4_APPROVAL: "test" }))).not.toContain("قبل أي حجز");
  });

  it("everything on: at most six paragraphs (the template has six slots), every feature and the money sentence present, subject = the approved long one", () => {
    const a = composeLaunchAnnouncement(ALL_ON, "منى")!;
    expect(items(a)).toHaveLength(6);
    expect(a.Name).toBe("منى");
    expect(a.Subject).toBe("جديد في ديجر: جدول حيّ لنتائجك، وتقرير مراجعة، وتعديل ملفك بعد التسليم");
    expect(text(a)).toContain("لا نخصم إلا ما سُلّم فعلًا");
    expect(a.ButtonLabel).toBe("افتح لوحتك");
  });

  it("the download sentence is added when there is room", () => {
    const a = composeLaunchAnnouncement({ DIGER_STAGE2_LIVE_SHEET: "on" })!;
    expect(items(a).at(-1)).toContain("تنزيل النتائج");
  });

  it("the subject names only what is live: the live-sheet subject needs the live sheet; otherwise a generic one", () => {
    expect(composeLaunchAnnouncement({ DIGER_STAGE2_LIVE_SHEET: "on" })!.Subject).toBe("تابع بحثك لحظة بلحظة في ديجر");
    expect(composeLaunchAnnouncement({ DIGER_STAGE2_ASK_CARD: "on" })!.Subject).toBe("جديد في ديجر: رحلة طلبك صارت أوضح");
    expect(composeLaunchAnnouncement({ DIGER_STAGE4_REVIEW: "on", DIGER_STAGE4_APPROVAL: "on" })!.Subject).not.toContain("جدول حيّ");
  });

  it("no price number, no speed or completeness claim, no unknown greeting name", () => {
    const a = composeLaunchAnnouncement(ALL_ON)!;
    expect(a.Name).toBe("عزيزنا العميل");
    const body = text(a);
    expect(body).not.toMatch(/[0-9٠-٩]+\s*(ج\.م|جنيه|نقطة|دولار)/);
    expect(body).not.toMatch(/مجانًا|أسرع|فورًا|في ثوانٍ|كل نتائج المنصة/);
  });

  it("only exactly «on» (case and spaces ignored, like the flag helpers) counts", () => {
    expect(composeLaunchAnnouncement({ DIGER_STAGE2_LIVE_SHEET: " ON " })).not.toBeNull();
    expect(composeLaunchAnnouncement({ DIGER_STAGE2_LIVE_SHEET: "allowlist" })).toBeNull();
  });
});
