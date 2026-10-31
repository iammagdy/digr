import { describe, expect, it } from "vitest";
import { sourceLabelAr } from "../agent/src/methodology";
import { checkCustomerText } from "../src/lib/agentMission/text";

/**
 * LIVE RETEST 2026-10-31 (A1, A2): the methodology row «المنصات والمصادر المستخدمة» said «غير مسجّل» for both missions: the label was read from a PLATFORM word in the source's name («إكس», «يوتيوب»), and a company, people or e-mail database names no
 * platform. The row now says what KIND of data each source gave, in customer-safe Arabic: never the source's name, never a provider, never «غير مسجّل» for a stage that has a source.
 */
describe("sourceLabelAr", () => {
  it.each([
    ["tomba.companies.search.reveal", "قاعدة بيانات الشركات"],
    ["parallel.companies.search", "قاعدة بيانات الشركات"],
    ["aviato.companies.employees", "مصدر بيانات الموظفين والمسؤولين"],
    ["blitzapi.people.employee-finder", "مصدر بيانات الموظفين والمسؤولين"],
    ["tomba.companies.emails.list", "مصدر عناوين البريد الإلكتروني للعمل"],
    ["blitzapi.people.email.find", "مصدر عناوين البريد الإلكتروني للعمل"],
    ["quickenrich.people.phone.find", "مصدر أرقام الهواتف"],
    ["crawl4ai.instagram.user.posts", "إنستغرام"],
    ["crawl4ai.youtube.search.videos", "يوتيوب"],
    ["anyapi.linkedin.company.people", "لينكد إن"],
    ["acme.something.unknown", "مصدر بيانات متخصص"],
  ])("%s → %s", (id, label) => {
    expect(sourceLabelAr(id)).toBe(label);
  });
  it("nothing for a stage with no source; never a provider name, a digit or an English letter in a label", () => {
    expect(sourceLabelAr(null)).toBeNull();
    for (const id of ["tomba.companies.search.reveal", "aviato.companies.employees", "blitzapi.people.employee-finder", "tomba.companies.emails.list", "quickenrich.people.phone.find", "acme.something.unknown", "parallel.companies.search"]) {
      const label = sourceLabelAr(id)!;
      expect(label).not.toMatch(/tomba|aviato|blitz|quickenrich|parallel|acme|[A-Za-z0-9]/i);
      expect(checkCustomerText(label, { maxChars: 200 }).issues, label).toEqual([]);
    }
  });
});
