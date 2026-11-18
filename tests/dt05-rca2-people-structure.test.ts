import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { understoodPeopleOf } from "../src/lib/agentMission/childSources";
import * as run from "../agent/src/llmPlanner/run";
import * as view from "../agent/src/llmPlanner/catalogView";
import { NOT_ADMIN } from "./helpers/agentHarness";

/**
 * DT-20261118-05 RCA2 (live 19 Nov, chat 44cdc7a9…): the planner's understanding of «شركتين + مسؤولي الإدارة + أرقامهم الشخصية» carried no usable people step,
 * because every check read the PLATFORM KEY the model wrote («people» under «companies»), while the catalog files its people-of-company tools under «companies» (companies.employees),
 * «linkedin» (linkedin.company.people) and «people». A people step is known by what its TOOL is.
 */
const company = { key: "co", title_ar: "الشركات", parent: null as string | null, platform: "companies", capability: "companies.businesses.search", count: { per_parent: null as number | null } };
const step = (platform: string, capability: string, per: number | null = null) => ({ key: "pp", title_ar: "مسؤولو الإدارة", parent: "co", platform, capability, count: { per_parent: per } });

describe("the people of the companies are known by the capability of their tool, not by the platform key the model wrote", () => {
  it.each([
    ["people.decision_makers under a companies step", step("people", "people.decision_makers")],
    ["companies.employees", step("companies", "companies.employees")],
    ["linkedin.company.people", step("linkedin", "linkedin.company.people", 2)],
  ])("%s is the people step under the companies", (_n, s) => {
    expect(understoodPeopleOf([company, s])).toMatchObject({ noun_ar: "مسؤولو الإدارة", parent_ar: "الشركات" });
  });
  it("a companies step from a map search is still a parent; a request with no people step has none", () => {
    expect(understoodPeopleOf([{ ...company, platform: "google", capability: "google.maps.search" }, step("linkedin", "linkedin.company.people")])).not.toBeNull();
    expect(understoodPeopleOf([company])).toBeNull();
    expect(understoodPeopleOf([company, { ...step("linkedin", "linkedin.user.posts"), capability: "linkedin.user.posts" }])).toBeNull();
  });
  it("the request goes to the company-and-people path whenever a step's tool is a people-of-company capability, whatever platform key it has", () => {
    expect(run.handsOverToB2B({ steps: [{ platform: "google", capability: "google.maps.search" }, { platform: "linkedin", capability: "linkedin.company.people" }] })).toBe(true);
    expect(run.handsOverToB2B({ steps: [{ platform: "companies", capability: "companies.businesses.search" }] })).toBe(true);
    expect(run.handsOverToB2B({ steps: [{ platform: "x", capability: "x.posts" }] })).toBe(false);
  });
});
describe("the planner is told, from the catalog's structure, that the people of companies and their contact finders exist", () => {
  const catalog = loadTregCatalog();
  it("the hint names the real people-of-company capabilities and the finder kinds, and no endpoint or vendor id", () => {
    const hint = view.peopleOfCompanyHint(catalog, NOT_ADMIN);
    expect(hint).toContain("companies.employees");
    expect(hint).toContain("linkedin.company.people");
    expect(hint).toContain("phone finders exist");
    expect(hint).toContain("e-mail finders exist");
    expect(hint).not.toMatch(/blitzapi|aiark|tomba|aviato|icypeas|quickenrich/i);
  });
});
