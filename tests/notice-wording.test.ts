import { describe, expect, it } from "vitest";
import { buildMissionNotice, type MissionNoticeFacts } from "../src/lib/agentMission/notices";
import { checkCustomerText } from "../src/lib/agentMission/text";

/**
 * LIVE INCIDENT 2026-10-31 15:48 (Cairo): the e-mail of a failed mission said «لا يمكن تنفيذ «T» بدقة الآن» as its heading and «لم نجد مصدرًا يخدم طلبك «T» بدقة الآن.» as its lead (the same sentence twice; the subject said it a third time), and
 * it told the customer that no source serves the request when the fault was ours. Four wordings now, one per truth; in each the subject, the heading and the lead say different things.
 */
const T = "شركات مصريه";
const base: MissionNoticeFacts = { delivered: 0, planned: 5, chargedPoints: 0, releasedPoints: 200, reservedPoints: 200, hasJob: true };

const CASES: Array<[string, Parameters<typeof buildMissionNotice>[0], Partial<MissionNoticeFacts>]> = [
  ["ours (a fault of ours stopped the run)", "failed", { cause: "internal" }],
  ["empty (we searched, nothing matched)", "unserved", { cause: "empty" }],
  ["no source (nothing serves this kind of request)", "unserved", {}],
  ["stopped (the run did not finish)", "failed", {}],
];

const sentencesOf = (text: string): string[] => text.split(/[.؟!—:؛]/).map((x) => x.replace(T, "").replace(/[«»]/g, "").trim()).filter((x) => x.length > 6);
const gramsOf = (text: string): Set<string> => {
  const words = text.replace(T, " ").replace(/[«»،.؟!:—؛]/g, " ").split(/\s+/).filter(Boolean);
  return new Set(words.slice(0, -3).map((_, i) => words.slice(i, i + 4).join(" ")));
};

describe.each(CASES)("%s", (_name, kind, facts) => {
  const n = buildMissionNotice(kind, { ...base, ...facts }, T);
  const e = n.email!;
  it("the subject, the heading and the lead each say something different: no sentence repeated, no four words in a row shared", () => {
    // the e-mail shows subject, heading, lead and the money line together; the in-site notice shows its title and its body together: each set is checked on its own
    for (const parts of [{ subject: e.subject, heading: e.heading, lead: e.lead, money: e.detail1 }, { title: n.title, body: n.body.replace(e.lead, "") }] as Array<Record<string, string>>) {
      const keys = Object.keys(parts);
      for (const a of keys) for (const b of keys) {
        if (a >= b) continue;
        const shared = [...gramsOf(parts[a])].filter((g) => gramsOf(parts[b]).has(g));
        expect(shared, `${a} / ${b}`).toEqual([]);
        expect(sentencesOf(parts[a]).filter((s) => sentencesOf(parts[b]).includes(s)), `${a} / ${b}`).toEqual([]);
      }
    }
    expect(n.body.startsWith(e.lead)).toBe(true);
    expect(n.body.includes(n.title)).toBe(false);
  });
  it("customer text: Arabic, Arabic-Indic digits only, no emoji, no provider, endpoint, dollar amount or model vendor", () => {
    for (const text of [n.title, n.body, e.subject, e.heading, e.lead, e.detail1, e.preheader]) {
      expect(checkCustomerText(text, { maxChars: 600 }).issues, text).toEqual([]);
      expect(text).not.toMatch(/[0-9]/);
      expect(text).not.toMatch(/USD|\$|دولار|claude|anthropic|openai|treg|aiark|tomba|endpoint|haiku|http/i);
    }
  });
  it("the preview line says nothing was charged; the heading and the lead do not repeat it", () => {
    expect(e.preheader).toBe("لم يُخصم منك شيء، وعاد الحجز المؤقت كاملًا.");
    expect(e.heading).not.toContain("يُخصم");
    expect(e.lead).not.toContain("يُخصم");
  });
});

describe("ours and no source are told differently", () => {
  const ours = buildMissionNotice("failed", { ...base, cause: "internal" }, T);
  const none = buildMissionNotice("unserved", base, T);
  it("a fault of ours says so and never says that no source serves the request", () => {
    expect(ours.email!.lead).toContain("بسبب خلل من جانبنا");
    expect(ours.email!.lead).toContain("وليس لأن المصادر خالية من النتائج");
    expect(JSON.stringify(ours)).not.toMatch(/لا يوجد بين مصادرنا|لم نجد مصدرًا|خارج مصادرنا|بدقة الآن/);
  });
  it("no source says that and never blames a fault", () => {
    expect(none.email!.lead).toContain("لا يوجد بين مصادرنا ما يخدم طلبك");
    expect(JSON.stringify(none)).not.toMatch(/عطل|خلل/);
  });
  it("the wordings, verbatim (the owner's mission «شركات مصريه»)", () => {
    expect(ours.email).toMatchObject({
      subject: "شركات مصريه: خلل من جانبنا ولم يُخصم شيء",
      heading: "توقفت مهمة «شركات مصريه» قبل أن تُسلَّم",
      lead: "تعذّر تنفيذ مهمتك «شركات مصريه» بسبب خلل من جانبنا، وليس لأن المصادر خالية من النتائج؛ لم نسلّمك شيئًا وأبلغنا فريقنا ليصلحه. يمكنك إعادة إرسال الطلب بعد قليل.",
    });
    expect(none.email).toMatchObject({
      subject: "شركات مصريه: لا يوجد مصدر يخدمه",
      heading: "«شركات مصريه» خارج مصادرنا الآن",
      lead: "لا يوجد بين مصادرنا ما يخدم طلبك «شركات مصريه» بالدقة التي يحتاجها، لذلك لم نبدأ تنفيذه. يمكنك تعديل الطلب أو كتابته بصيغة أخرى.",
    });
  });
});

describe("completed and partial notices are untouched", () => {
  it("a completed mission still says what was delivered and the money line", () => {
    const n = buildMissionNotice("completed", { ...base, delivered: 5, chargedPoints: 200, releasedPoints: 0 }, T);
    expect(n.kind).toBe("completed");
    expect(n.email!.heading).toContain("جاهزة للتحميل");
  });
});
