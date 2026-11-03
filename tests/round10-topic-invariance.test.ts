import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { topicTierOf, keyTokensOf } from "../src/lib/agentMission/foundation/pool";

/**
 * LIVE ROUND 10, item 5, «the same rule for every platform; TikTok and X must stay byte-identical on their fixtures». The new rule (key tokens, a glued «و» taken off, three fifths of a topic of four or more words) is compared here with the rule it replaces, copied from main, over EVERY string of the stored
 * TikTok and X pages (their captions are placeholders, so the strings are the structure, not the meaning) and over made-up captions with the topics of those fixtures («الذكاء الاصطناعي», «محمد صلاح», «كرة القدم», «فيلم جديد»). For a topic of one to three words the two agree on all of them: the exact diff is EMPTY.
 * The only difference of the new rule is a topic of four words or more (an event described in words) and a name with «و» glued to it: both are Facebook, Instagram and YouTube cases of this round.
 */
const norm = (s: string): string => s.replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").toLowerCase();
const HASHTAG = /#+[^\s#]*/g;
function legacyTier(text: string, ask: { topic: { text: string | null; relation: string } }): 0 | 1 | 2 {
  const words = ask.topic.text ? norm(ask.topic.text).split(/\s+/).map((w) => w.replace(/^ال/, "")).filter((w) => w.length > 1) : [];
  if (words.length === 0) return 2;
  const all = norm(text);
  if (!words.every((w) => all.includes(w))) return 0;
  const body = norm(text.replace(HASHTAG, " "));
  if (words.every((w) => body.includes(w))) return 2;
  return ask.topic.relation === "made_with" ? 2 : 1;
}
const strings = (v: unknown, out: string[] = []): string[] => { if (typeof v === "string") out.push(v); else if (Array.isArray(v)) v.forEach((x) => strings(x, out)); else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out)); return out; };
const MISSIONS = ["msn_5851abc92a1e6645a9cd", "msn_b060d3347ed7660f972e", "msn_4e68812d396bd5db0a01", "msn_9fa5ba384c05a25247e1", "msn_50e3b83c44e7ebd7f577", "msn_e3d679014c58168c3227", "msn_a254618740b9b9878126"];
const MADE_UP = ["الذكاء الاصطناعي يغير العالم", "#ذكاء_اصطناعي رقصة", "ذكاء فقط", "محمد صلاح يسجل هدفًا", "هدف رائع لمحمد صلاح #صلاح", "كرة القدم المصرية اليوم", "فيلم جديد عن الذكاء الاصطناعي", "رقصة #الذكاء_الاصطناعي", "نص عادي"];
const TOPICS = ["الذكاء الاصطناعي", "محمد صلاح", "كرة القدم", "فيلم جديد", "ذكاء اصطناعي", "الانتخابات"];

describe("the key-token rule equals the rule it replaces for a topic of one to three words (the TikTok and X fixtures)", () => {
  const pool: string[] = [...MADE_UP];
  for (const m of MISSIONS) {
    let dir: string[] = [];
    try { dir = readdirSync(new URL(`./fixtures/live/missions/${m}/raw/`, import.meta.url)); } catch { /* a mission with no raw folder */ }
    for (const f of dir) { try { pool.push(...strings(JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${m}/raw/${f}`, import.meta.url), "utf8"))).filter((x) => x.length > 1 && x.length < 400)); } catch { /* not json */ } }
  }
  it("reads real fixture strings (thousands) and every topic: not one tier differs", () => {
    expect(pool.length).toBeGreaterThan(1000);
    let compared = 0;
    for (const topic of TOPICS) for (const relation of ["about", "made_with"] as const) for (const text of pool) {
      expect(topicTierOf(text, { topic: { text: topic, relation } }), `${topic} / ${text.slice(0, 40)}`).toBe(legacyTier(text, { topic: { text: topic, relation } }));
      compared += 1;
    }
    expect(compared).toBe(TOPICS.length * 2 * pool.length);
  });
  it("the difference is only where the owner asked for it: four words or more, and a «و» glued to a name", () => {
    expect(keyTokensOf("نهائي السوبر المصري الأهلي والزمالك")).toEqual(["نهايي", "سوبر", "مصري", "اهلي", "زمالك"].map((w) => (w === "نهايي" ? keyTokensOf("نهائي")[0] : w)));
    const t = { topic: { text: "نهائي السوبر المصري الأهلي والزمالك", relation: "about" as const } };
    expect(legacyTier("زيزو رجل نهائي السوبر أمام الزمالك", t)).toBe(0);
    expect(topicTierOf("زيزو رجل نهائي السوبر أمام الزمالك", t)).toBe(2);
  });
});
