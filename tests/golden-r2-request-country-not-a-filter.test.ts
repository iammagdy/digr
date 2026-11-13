import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findFilterFields, resolveFilters } from "../src/lib/agentMission/filters";
import { countryOfRequestText } from "../src/lib/agentMission/places";

/**
 * GOLDEN RUN ROUND 2, G1: the country the customer's words name («شركات مصرية» -> EG, countryOfRequestText, #326 F4) is the company-phone helper's fallback location and NEVER a row rule. It is read in exactly one place (the company step of the contact engine),
 * and no filter appears from a nationality word: a place filter exists only when the planner declared one or the request names a place itself (plan.ts).
 */
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? (n === "node_modules" ? [] : walk(p)) : /\.(ts|tsx)$/.test(n) ? [p] : []; });

describe("the request-country fallback is not a row filter", () => {
  it("countryOfRequestText is used only by the company-phone step, the Stage 3 companies-search INPUT (owner decision 6, tests/stage3-b2b-plan.test.ts: no row rule), and defined in places.ts", () => {
    const users = [...walk("src"), ...walk("agent/src")].filter((f) => readFileSync(f, "utf8").includes("countryOfRequestText")).map((f) => f.replace(/\\/g, "/"));
    // ROUND 60 CHANGED: agent/src/pageReuse.ts reads it as the country of a NATIONAL phone number on a page code reads («01130755305» -> +20…), the same use as the company-phone step of
    // engine/contacts.ts: it decides how a number is written, never which rows are kept (no row rule, no filter)
    expect(users.sort()).toEqual(["agent/src/engine/contacts.ts", "agent/src/pageReuse.ts", "src/lib/agentMission/places.ts", "src/lib/agentMission/stage3/b2bRequest.ts"]);
  });

  it("the nationality word names a country for the phone helper, and a plan with no declared place filter gets none", () => {
    expect(countryOfRequestText("عايز ٥ شركات مصرية في قطاع الكهروميكانيكا")).toBe("EG");
    const fields = findFilterFields({ mappedKeys: ["name", "city", "country", "address", "website"], columnKeys: ["name", "city"] });
    const { filters } = resolveFilters([], fields, "stage «companies»");
    expect(filters.some((f) => f.kind === "place")).toBe(false);
  });
});
