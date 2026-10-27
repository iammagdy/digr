import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isTrueFlag, toBool, toEpochMs, toIsoTimestamp, toNumber } from "../src/lib/coerce";
import { normalizeSocialPost, toPostPublishedAt } from "../src/lib/server/socialRows";
import { normalizeRecord } from "../src/lib/server/normalizationPipeline";
import { isReplyRow } from "../src/lib/server/researchRelevanceGate";

const fixture = JSON.parse(readFileSync("tests/fixtures/replay/real-rows_anyapi.x.user.posts.json", "utf-8"));
const realRows: Array<Record<string, string>> = fixture.pages[0].rows;

describe("toBool: a flag as a provider sends it", () => {
  it.each([
    [true, true], [false, false], [1, true], [0, false],
    ["true", true], ["True", true], ["TRUE", true], [" true ", true], ["1", true], ["yes", true],
    ["false", false], ["False", false], ["FALSE", false], [" False ", false], ["0", false], ["no", false],
  ])("reads %j as %j", (input, expected) => {
    expect(toBool(input)).toBe(expected);
  });

  it.each([[undefined], [null], [""], ["maybe"], [2], [-1], [{}], [[]], ["نعم"]])("never guesses from %j", (input) => {
    expect(toBool(input as any)).toBeUndefined();
  });

  it("isTrueFlag is true only for a value that reads as true: «False» is not a reply", () => {
    expect(isTrueFlag("False")).toBe(false);
    expect(isTrueFlag("True")).toBe(true);
    expect(isTrueFlag(undefined)).toBe(false);
    expect(Boolean("False")).toBe(true); // the old reading, kept here as the thing that must never be used for a flag
  });
});

describe("numbers and Unix seconds as text", () => {
  it("reads numbers written as text, with Arabic-Indic digits and separators", () => {
    expect(toNumber("1792308962")).toBe(1792308962);
    expect(toNumber("١٢٥٠")).toBe(1250);
    expect(toNumber("1,250")).toBe(1250);
    expect(toNumber("abc")).toBeUndefined();
    expect(toNumber(NaN)).toBeUndefined();
  });

  it("reads Unix seconds as a number or as text, and milliseconds, and nothing else as a date", () => {
    const ms = Date.UTC(2026, 9, 18, 7, 36, 2);
    expect(toEpochMs("1792308962")).toBe(ms);
    expect(toEpochMs(1792308962)).toBe(ms);
    expect(toEpochMs(String(ms))).toBe(ms);
    expect(toEpochMs("2101118004087886212")).toBeUndefined(); // a tweet id is not a date
    expect(toEpochMs("12")).toBeUndefined();
    expect(toIsoTimestamp("1792308962")).toBe("2026-10-18T07:36:02Z");
    expect(toIsoTimestamp("2026-10-18T07:36:02Z")).toBe("2026-10-18T07:36:02Z");
    expect(toIsoTimestamp("soon")).toBeUndefined();
  });
});

describe("the real anyapi.x.user.posts row shape (all strings, «True»/«False», Unix seconds as text)", () => {
  it("the fixture is the real shape", () => {
    expect(realRows).toHaveLength(10);
    for (const row of realRows) {
      expect(Object.values(row).every((v) => typeof v === "string")).toBe(true);
      expect(["True", "False"]).toContain(row.isReply);
    }
  });

  it("the gate reads a reply by the text «True» and an own post by the text «False»", () => {
    expect(realRows.filter(isReplyRow).map((r) => r.id)).toEqual(["301", "304", "305", "306", "308"]);
  });

  it("the export keeps the reply column right: «False» is false (it was blank), «True» is true", () => {
    const own = normalizeSocialPost(realRows[0]);
    const reply = normalizeSocialPost(realRows[1]);
    expect(own.is_reply).toBe(false);
    expect(reply.is_reply).toBe(true);
  });

  it("the other normaliser no longer turns the text «False» into true", () => {
    expect(normalizeRecord({ isReply: "False", text: "x" }, 0).is_reply).toBe(false);
    expect(normalizeRecord({ isReply: "True", text: "x" }, 0).is_reply).toBe(true);
    expect(normalizeRecord({ is_reply: false, text: "x" }, 0).is_reply).toBe(false);
  });

  it("the post row reads the author without «@», the counts as numbers and the time as date and time (UTC)", () => {
    const row = normalizeSocialPost(realRows[0]);
    expect(row.username).toBe("@elonmusk");
    expect(row.likes_count).toBe(10);
    expect(row.views_count).toBe(100);
    expect(row.published_at).toBe("2026-10-18 07:36");
    expect(row.source_id).toBe("300");
  });
});

describe("the publication moment of a post: date and time when the source gave a time", () => {
  it.each([
    ["1792308962", "2026-10-18 07:36"],
    [1792308962, "2026-10-18 07:36"],
    ["2026-10-18T07:36:02Z", "2026-10-18 07:36"],
    ["2026-10-18T10:36:02+03:00", "2026-10-18 07:36"],
    ["2026-10-18 07:36:02", "2026-10-18 07:36"],
    ["2026-10-18", "2026-10-18"],
  ])("%j → %j", (input, expected) => {
    expect(toPostPublishedAt(input)).toBe(expected);
  });

  it("is empty for what cannot be told", () => {
    expect(toPostPublishedAt("3 years ago")).toBeUndefined();
    expect(toPostPublishedAt("")).toBeUndefined();
    expect(toPostPublishedAt(undefined)).toBeUndefined();
  });
});
