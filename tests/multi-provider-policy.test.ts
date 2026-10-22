import { describe, expect, it } from "vitest";
import {
  buildContactRow, checkPublicBusinessUrl, checkRobots, companyDomain, extractEmails, extractPhones, extractProfileLink, linksFromMarkdown,
  parseDecisionMakers, parseRobots, pickContactPages, robotsAllows, rowPassesGate, sanitizeRowKeys, STATUS_UNAVAILABLE_AR, STATUS_UNVERIFIED_AR, STATUS_VERIFIED_AR,
} from "../src/lib/multiProvider/policy";

describe("data policy: public business pages only", () => {
  it("refuses login pages, accounts, social networks, private hosts and credentials in the URL", () => {
    for (const url of [
      "https://acme.com/login", "https://acme.com/my-account/orders", "https://acme.com/wp-admin", "https://acme.com/portal/home", "https://user:pw@acme.com/",
      "https://www.facebook.com/acme", "https://linkedin.com/company/acme", "https://x.com/acme", "http://127.0.0.1/contact", "http://10.0.0.5/", "https://localhost/contact", "ftp://acme.com/",
      "https://intranet.corp.internal/contact",
    ]) expect(checkPublicBusinessUrl(url).ok, url).toBe(false);
    for (const url of ["https://acme.com/", "https://www.acme.com/contact", "https://acme.co.uk/about", "https://company1.fakeco.net/contact"]) expect(checkPublicBusinessUrl(url).ok, url).toBe(true);
  });

  it("finds a company's own contact, about and team pages (English and Arabic) and nothing off its domain or behind a login", () => {
    const links = ["/contact", "/about-us", "https://other.com/contact", "/login", "/products", "/من-نحن", "https://acme.com/team#top", "mailto:a@acme.com", "/account/contact"];
    const picked = pickContactPages(links, "https://acme.com", 5);
    expect(picked).toContain("https://acme.com/contact");
    expect(picked).toContain("https://acme.com/about-us");
    expect(picked).toContain("https://acme.com/team");
    expect(picked.some((u) => u.includes("other.com"))).toBe(false);
    expect(picked.some((u) => /login|account/.test(u))).toBe(false);
    expect(picked[0]).toBe("https://acme.com/contact");
  });

  it("derives the company domain, with the two-part country suffixes", () => {
    expect(companyDomain("https://www.acme.com/x")).toBe("acme.com");
    expect(companyDomain("https://shop.acme.co.uk")).toBe("acme.co.uk");
    expect(companyDomain("https://mail.acme.com.eg/contact")).toBe("acme.com.eg");
    expect(companyDomain("http://127.0.0.1")).toBeNull();
  });
});

describe("robots rules are honoured, never bypassed", () => {
  const rules = parseRobots(`User-agent: *\nDisallow: /private/\nAllow: /private/public\nDisallow: /contact-secret\n\nUser-agent: firecrawl\nDisallow: /\n`);
  it("applies the most specific rule and a group named for the provider", () => {
    expect(robotsAllows(parseRobots("User-agent: *\nDisallow: /private/\nAllow: /private/public\n"), "/private/x")).toBe(false);
    expect(robotsAllows(parseRobots("User-agent: *\nDisallow: /private/\nAllow: /private/public\n"), "/private/public/page")).toBe(true);
    expect(robotsAllows(parseRobots("User-agent: *\nDisallow:\n"), "/anything")).toBe(true);
    expect(robotsAllows(rules, "/contact", ["firecrawl"])).toBe(false);
    expect(robotsAllows(rules, "/contact", ["diger"])).toBe(true);
    expect(robotsAllows(rules, "/contact-secret", ["diger"])).toBe(false);
  });

  it("a missing robots.txt allows; an unreadable one (server error, no answer) does NOT; a disallow blocks", async () => {
    const cache = new Map<string, any>();
    expect((await checkRobots("https://a.test/contact", async () => ({ status: 404, text: "" }), cache)).allowed).toBe(true);
    expect((await checkRobots("https://b.test/contact", async () => ({ status: 503, text: "" }), new Map())).reason).toBe("unreadable");
    expect((await checkRobots("https://c.test/contact", async () => null, new Map())).allowed).toBe(false);
    expect((await checkRobots("https://d.test/contact", async () => ({ status: 200, text: "User-agent: *\nDisallow: /contact" }), new Map())).reason).toBe("disallowed");
    let fetched = 0;
    const shared = new Map<string, any>();
    const f = async () => { fetched += 1; return { status: 200, text: "User-agent: *\nAllow: /" }; };
    await checkRobots("https://e.test/a", f, shared); await checkRobots("https://e.test/b", f, shared);
    expect(fetched).toBe(1);
  });
});

describe("extraction and verification of contact fields", () => {
  const md = "# Contact\n[Write to us](mailto:Sales@Acme.com?subject=hi)\nAlso info@acme.com and press@agency.com and person@gmail.com and logo@2x.png and x@example.com\nTel: +20 100 123 4567\nFax 02 2345 6789\nFounded 2015\nCall 0100-111-2222";
  const emails = extractEmails(md, ["mailto:Sales@Acme.com"], "acme.com");

  it("keeps a company-domain email verified, and a foreign, personal-domain or placeholder one unverified or out", () => {
    const by = Object.fromEntries(emails.map((e) => [e.value, e]));
    expect(by["sales@acme.com"]).toMatchObject({ status: "verified", evidence: "mailto" });
    expect(by["info@acme.com"]).toMatchObject({ status: "verified", evidence: "page_text" });
    expect(by["press@agency.com"]).toMatchObject({ status: "unverified", reason: "domain_differs_from_website" });
    expect(by["person@gmail.com"]).toMatchObject({ status: "unverified", reason: "personal_domain" });
    expect(by["logo@2x.png"]).toBeUndefined();
    expect(by["x@example.com"]).toBeUndefined();
  });

  it("verifies a phone from a tel link or a label, not a bare number, and never a year", () => {
    const phones = extractPhones(md, ["tel:+201001234567"]);
    expect(phones.find((p) => p.value === "+201001234567")).toMatchObject({ status: "verified", evidence: "tel_link" });
    // a fax number is not an office phone: no label of a phone, so it is not verified
    expect(phones.find((p) => p.value === "0223456789")).toMatchObject({ status: "unverified" });
    expect(phones.some((p) => p.value === "2015")).toBe(false);
    const bare = extractPhones("رقمنا الموحد 19033 والمكتب 02-2345-6789 فقط", []);
    expect(bare.every((p) => p.status === "unverified" || p.evidence === "labelled_text")).toBe(true);
  });

  it("reads a professional profile link listed on the page (company or person page), nothing else", () => {
    expect(extractProfileLink("see https://www.linkedin.com/company/acme-co/ for us", [])).toBe("https://www.linkedin.com/company/acme-co");
    expect(extractProfileLink("x", ["https://eg.linkedin.com/in/jane-doe"])).toBe("https://www.linkedin.com/in/jane-doe");
    expect(extractProfileLink("https://facebook.com/acme https://x.com/acme", [])).toBeNull();
  });

  it("decision makers keep a name and a title only, only for leadership titles, nothing with digits or emails", () => {
    const people = parseDecisionMakers({ people: [
      { name: "Mona Samir", title: "Managing Director", email: "m@acme.com", phone: "123" },
      { name: "أحمد علي", title: "المدير العام" },
      { name: "Intern Joe", title: "Marketing Intern" },
      { name: "jane@acme.com", title: "CEO" },
    ] });
    expect(people).toEqual([{ name: "Mona Samir", title: "Managing Director" }, { name: "أحمد علي", title: "المدير العام" }]);
    expect(Object.keys(people[0]).sort()).toEqual(["name", "title"]);
  });

  it("links come out of Markdown text for providers that return only text", () => {
    expect(linksFromMarkdown("[a](/contact) [b](https://x.com/y \"t\") [m](mailto:a@b.com) <tel:+2010>")).toEqual(["/contact", "https://x.com/y", "mailto:a@b.com"].concat(["tel:+2010"]));
  });
});

describe("a row carries only allowed keys and is delivered only when its required fields are verified", () => {
  it("drops private data keys and anything outside the allowed set", () => {
    const row = sanitizeRowKeys({ company_name: "A", work_email: "a@a.com", home_address: "x", family_members: "y", personal_phone: "1", spouse_name: "z", random: 1, linkedin_url: "u", private_notes: "n" });
    expect(Object.keys(row).sort()).toEqual(["company_name", "linkedin_url", "work_email"]);
  });

  it("builds Arabic statuses and gates delivery: unverified is not delivered, nothing required needs at least one verified contact", () => {
    const good = buildContactRow({ companyName: "A", website: "https://a.com", emails: [{ value: "i@a.com", status: "verified", evidence: "mailto" }], phones: [] });
    expect(good.work_email_verification_status).toBe(STATUS_VERIFIED_AR);
    expect(good.phone_verification_status).toBe(STATUS_UNAVAILABLE_AR);
    expect(rowPassesGate(good, ["work_email"])).toBe(true);
    expect(rowPassesGate(good, ["work_email", "office_phone"])).toBe(false);
    expect(rowPassesGate(good, [])).toBe(true);
    const weak = buildContactRow({ companyName: "B", website: "https://b.com", emails: [{ value: "x@gmail.com", status: "unverified", evidence: "page_text", reason: "personal_domain" }], phones: [{ value: "123456789", status: "unverified", evidence: "page_text" }] });
    expect(weak.work_email_verification_status).toBe(STATUS_UNVERIFIED_AR);
    expect(rowPassesGate(weak, ["work_email"])).toBe(false);
    expect(rowPassesGate(weak, [])).toBe(false);
    expect(rowPassesGate({ company_name: "C" }, [])).toBe(false);
  });
});
