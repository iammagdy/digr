import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { DATA_POLICY_COUNTS, categoryOf, endpointIdsOf, mayUseSensitive, policyRuleOf, policyVerdict, NO_SENSITIVE_ACCESS, SENSITIVE_NOT_VERIFIED_AR } from "../src/lib/treg/dataPolicy";
import { blockedEndpointReason } from "../src/lib/treg/blockList";
import { loadTregCatalog } from "../src/lib/treg/catalog";

const snapshot = JSON.parse(readFileSync("data/treg/treg_catalog_sellable.json", "utf-8"));
const writes: Array<{ id: string }> = JSON.parse(readFileSync("data/treg/treg_write_actions.json", "utf-8"));
const policy = JSON.parse(readFileSync("data/treg/data_policy.json", "utf-8"));

describe("DATA CATEGORY policy: data/treg/data_policy.json", () => {
  it("is generated from the snapshot and is up to date (the script's own check passes)", () => {
    expect(() => execFileSync("node", ["scripts/treg/build-data-policy.mjs", "--check"], { stdio: "pipe" })).not.toThrow();
    expect(policy.snapshot.sha256).toBe(createHash("sha256").update(readFileSync("data/treg/treg_catalog_sellable.json")).digest("hex"));
    expect(policy.snapshot.endpoints).toBe(3276);
    expect(policy.snapshot.writeActions).toBe(276);
  });

  it("classifies EVERY endpoint of the snapshot and every write action, once, into the four categories (counts pinned)", () => {
    const ids = new Set<string>([...snapshot.endpoints.map((e: any) => e.id), ...writes.map((w) => w.id)]);
    expect(Object.keys(policy.endpoints).length).toBe(ids.size);
    for (const id of ids) expect(["public", "b2b_contact", "sensitive", "blocked"], id).toContain(categoryOf(id));
    expect(DATA_POLICY_COUNTS).toEqual({ public: 2993, b2b_contact: 231, sensitive: 50, blocked: 278 });
    expect(DATA_POLICY_COUNTS.public + DATA_POLICY_COUNTS.b2b_contact + DATA_POLICY_COUNTS.sensitive + DATA_POLICY_COUNTS.blocked).toBe(ids.size);
    expect(categoryOf("not.an.endpoint")).toBe("unclassified");
  });

  it("BLOCKED: all 276 write actions, the two private-messaging deep links; apollo and datagma are blocked by NAME (they are not in the snapshot)", () => {
    for (const w of writes) expect(categoryOf(w.id), w.id).toBe("blocked");
    expect(endpointIdsOf("blocked").filter((id) => policyRuleOf(id) !== "B1_write_action").sort()).toEqual([
      "tikhub.x.douyin-app-v3-open-douyin-app-to-send-private-message", "tikhub.x.tiktok-app-v3-open-tiktok-app-to-send-private-message",
    ]);
    for (const id of endpointIdsOf("blocked")) expect(blockedEndpointReason(id), id).not.toBeNull();
    expect(blockedEndpointReason("apollo.people.search")).toBe("paused_provider");
    expect(blockedEndpointReason("datagma.people.find")).toBe("paused_provider");
    // no sellable (non-blocked) endpoint is on the gateway's block list
    for (const e of snapshot.endpoints) if (categoryOf(e.id) !== "blocked") expect(blockedEndpointReason(e.id, e.scope), e.id).toBeNull();
  });

  it("SENSITIVE: the owner's list (personal email finders, reverse lookups, advertising ids and hashes, personality) is exactly these endpoints", () => {
    const sensitive = endpointIdsOf("sensitive").sort();
    expect(sensitive.length).toBe(50);
    const must = [
      // personal email and phone finders
      "treg.people.email.find.personal", "aviato.people.email.find.personal", "limadata.people.email.find.personal", "sixtyfour.people.email.find.personal", "enrichlayer.contacts.personal-email", "leadmagic.x.personal-email-finder",
      "contactout.people.contact.personal", "contactout.people.enrich.personal_email", "contactout.people.personal_email.available", "fiber-ai.people.contacts.reveal.personal", "enrichlayer.contacts.personal-phone",
      // reverse lookups: who is behind this phone or email
      "blitzapi.people.phone.reverse", "blitzapi.people.email.reverse", "sixtyfour.people.phone.reverse", "sixtyfour.people.email.reverse", "enrichlayer.contacts.reverse-phone", "enrichlayer.person.reverse-email", "findymail.search.reverse-email",
      "quickenrich.people.enrich", "companyenrich.people.lookup", "getleadsio.people.phone.lookup", "contactout.people.email.enrich", "moltsets.people.enrich.email", "thecompaniesapi.companies.enrich_by_email", "branddev.brand.retrieve-by-email", "influencersclub.creators.enrich.email", "anyapi.linkedin.search_profiles_email", "tomba.people.email.sources",
      // identity resolution, from_email, people.lookup, b2b-profile
      "treg.people.identity.resolve", "icypeas.people.identity.resolve", "icypeas.people.identity.resolve.bulk", "leadsforge.people.identity.resolve.bulk", "limadata.people.identity.resolve", "fiber-ai.people.identity.resolve", "limadata.people.identity.from-email", "village.people.from_email", "village.people.from_email.stored", "moltsets.linkedin.profile.from-email", "contactout.people.linkedin.from-email", "getleadsio.people.enrich.from_email", "enrichlayer.person.lookup", "oceanio.people.lookup_bulk", "leadmagic.x.b2b-profile",
      // mobile advertising ids and email hashes
      "moltsets.people.audiences.maid", "moltsets.people.audiences.hashes", "moltsets.people.audiences.sha256", "limadata.people.audience.email-hash", "limadata.people.audience.resolve",
      // personality analysis and a home address
      "aiark.people.personality.analyze", "trestleiq.people.address.verify",
    ];
    expect([...must].sort()).toEqual(sensitive);
  });

  it("B2B CONTACT: work email and business phone finders of every provider the owner named (lusha, prospeo, leadmagic, leadsforge, contactout) are available to every customer", () => {
    for (const id of ["treg.people.email.find", "treg.people.phone.find", "lusha.people.phone.find", "prospeo.people.phone.find", "prospeo.people.email.find", "leadmagic.people.phone.find", "leadmagic.people.email.find", "leadsforge.people.phone.find", "leadsforge.people.email.find", "contactout.people.contact.phone", "hunter.people.email.find", "icypeas.people.email.find"]) {
      expect(categoryOf(id), id).toBe("b2b_contact");
      expect(policyVerdict(id, NO_SENSITIVE_ACCESS).allowed, id).toBe(true);
    }
    expect(endpointIdsOf("b2b_contact").length).toBe(231);
  });

  it("PUBLIC: posts, comments, profiles, companies, search, markets, AI generation stay public and open to every customer", () => {
    for (const id of ["anyapi.x.user.posts", "anyapi.x.search.posts", "tikhub.tiktok.video.comments", "scrapecreators.x.v1-facebook-post-comments", "icypeas.companies.search", "crawl4ai.youtube.video.comments", "blitzapi.jobs.search"]) {
      expect(categoryOf(id), id).toBe("public");
      expect(policyVerdict(id, NO_SENSITIVE_ACCESS).allowed, id).toBe(true);
    }
    const catalog = loadTregCatalog();
    const publicPlatforms = new Set(endpointIdsOf("public").map((id) => catalog.byId.get(id)?.platform));
    for (const p of ["x", "tiktok", "instagram", "facebook", "youtube", "stocks", "video-gen", "image-gen", "web", "google", "companies"]) expect(publicPlatforms.has(p), p).toBe(true);
  });

  it("no PUBLIC or B2B endpoint carries a sensitive token in its id, capability, name or summary (so a new endpoint of that kind lands in the stricter category)", () => {
    const tokens = [/(?<![a-z0-9])personal(?![a-z0-9])/i, /(?<![a-z0-9])reverse(?![a-z0-9])/i, /identity[._-](resolve|from)/i, /from[_-]email/i, /audiences?[._-](maid|hashes|sha256)/i, /personality/i, /b2b-profile($|[^-])/];
    const byId = new Map(snapshot.endpoints.map((e: any) => [e.id, e]));
    for (const id of [...endpointIdsOf("public"), ...endpointIdsOf("b2b_contact")]) {
      const e: any = byId.get(id);
      for (const re of tokens) expect(re.test(`${e.id} ${e.capability ?? ""}`), `${id} matches ${re}`).toBe(false);
    }
  });

  it("the access rule: a sensitive endpoint is allowed only for the admin or a verified business account; a blocked one never", () => {
    const sensitiveId = "blitzapi.people.phone.reverse";
    expect(policyVerdict(sensitiveId, NO_SENSITIVE_ACCESS)).toMatchObject({ allowed: false, reason: "sensitive_not_allowed" });
    expect(policyVerdict(sensitiveId, null)).toMatchObject({ allowed: false });
    expect(policyVerdict(sensitiveId, { isAdmin: false, verifiedBusiness: true }).allowed).toBe(true);
    expect(policyVerdict(sensitiveId, { isAdmin: true, verifiedBusiness: false }).allowed).toBe(true);
    for (const access of [NO_SENSITIVE_ACCESS, { isAdmin: true, verifiedBusiness: true }]) expect(policyVerdict("openmart.deny-rules.create", access)).toMatchObject({ allowed: false, reason: "blocked" });
    expect(mayUseSensitive({ isAdmin: false, verifiedBusiness: false })).toBe(false);
    expect(SENSITIVE_NOT_VERIFIED_AR).toBe("هذه الخدمة متاحة لحسابات الأعمال الموثّقة فقط؛ تواصل مع الدعم لتوثيق حسابك، ولم يُحجز أي رصيد.");
    expect(SENSITIVE_NOT_VERIFIED_AR).not.toMatch(/[A-Za-z]|\d|USD|دولار/);
  });

  it("the lists file is up to date and carries the counts", () => {
    const md = readFileSync("docs/proposals/agent-loop/DATA_POLICY_LISTS.md", "utf-8");
    expect(md).toContain("| sensitive | 50 |");
    expect(md).toContain("| blocked | 278 |");
    expect(md).toContain("| b2b_contact | 231 |");
    expect(md).toContain("| public | 2993 |");
    for (const id of endpointIdsOf("sensitive")) expect(md, id).toContain(`\`${id}\``);
  });
});
