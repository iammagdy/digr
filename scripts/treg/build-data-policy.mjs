#!/usr/bin/env node
/**
 * Builds data/treg/data_policy.json: the DATA CATEGORY of every TREG endpoint, from its id, capability, name and summary.
 *
 *   node scripts/treg/build-data-policy.mjs            writes data/treg/data_policy.json and docs/proposals/agent-loop/DATA_POLICY_LISTS.md
 *   node scripts/treg/build-data-policy.mjs --check    exits 1 when either file is out of date (the tests run this check)
 *
 * Categories (owner decision, enforced by code, never by the model):
 *   public       public posts, comments, public profiles, companies, search, reviews, products, markets, AI generation, everything else that returns data
 *   b2b_contact  work email, office or direct business phone, professional profile (the people.* contact finders and their providers)
 *   sensitive    personal email or phone finders, reverse lookups (who is behind this phone or email), mobile advertising ids and email hashes,
 *                personality analysis, home addresses: only the admin and accounts the admin marked "verified business"
 *   blocked      write actions, own-account endpoints, private-messaging deep links, the paused providers (apollo, datagma): never offered, sampled or executed
 *
 * The first rule that matches wins, in the order written below (blocked, then sensitive, then b2b_contact, then public), so a doubtful endpoint always lands in
 * the stricter category. Every non-public endpoint carries the id of the rule that put it there.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SNAPSHOT = path.join(ROOT, "data/treg/treg_catalog_sellable.json");
const WRITES = path.join(ROOT, "data/treg/treg_write_actions.json");
const OUT = path.join(ROOT, "data/treg/data_policy.json");
const LISTS = path.join(ROOT, "docs/proposals/agent-loop/DATA_POLICY_LISTS.md");

export const PAUSED_PROVIDERS = ["apollo", "datagma"];

/** A token of an id: separated by dot, dash or underscore, never inside a longer word («personalized» is not «personal»). */
const tok = (word) => new RegExp(`(?<![a-z0-9])${word}(?![a-z0-9])`, "i");

/** Ordered rules. `test(e)` sees { id, provider, platform, capability, name, summary, scope }. */
export const RULES = [
  // ---------------------------------------------------------------- blocked
  { id: "B1_write_action", category: "blocked", note: "write actions (data/treg/treg_write_actions.json)", test: (e, ctx) => ctx.writeIds.has(e.id) },
  { id: "B2_own_account", category: "blocked", note: "acts on or reads the caller's own connected account", test: (e) => String(e.scope || "").toLowerCase() === "own_account" },
  { id: "B3_private_message_deep_link", category: "blocked", note: "private-messaging deep links", test: (e) => /open-[a-z0-9-]+-app-to-send-private-message/i.test(e.id) || (/deep link/i.test(e.name || "") && /private message/i.test(`${e.name} ${e.summary}`)) },
  { id: "B4_paused_provider", category: "blocked", note: "paused providers", test: (e) => PAUSED_PROVIDERS.includes(String(e.provider || e.id.split(".")[0]).toLowerCase()) },

  // -------------------------------------------------------------- sensitive
  { id: "S1_personal_contact", category: "sensitive", note: "personal email or phone finders", test: (e) => tok("personal").test(e.id) || /\.personal(\.|$)/.test(e.capability || "") || /personal[_-]?(email|phone)/i.test(e.id) },
  { id: "S2_reverse_lookup", category: "sensitive", note: "reverse lookups: who is behind this phone or email", test: (e) => tok("reverse").test(e.id) || /reverse (email|phone)/i.test(`${e.name} ${e.summary}`) },
  { id: "S3_identity_resolve", category: "sensitive", note: "identity resolution from an email or phone", test: (e) => /identity[._-](resolve|from)/i.test(e.id) || /^people\.identity\.resolve/.test(e.capability || "") || /from[_-]email/i.test(e.id) },
  { id: "S4_person_lookup", category: "sensitive", note: "people.lookup and professional-profile-by-email lookups", test: (e) => /(^|\.)(people|person)\.lookup(_bulk)?(\.|$)/.test(e.id) || /b2b-profile($|[^-])/.test(e.id) || /\.profile\.lookup/.test(e.capability || "") },
  { id: "S5_enrich_by_email", category: "sensitive", note: "enrichment that starts from an email address or a phone number", test: (e) => /(enrich[._-]by[._-]email|retrieve-by-email|creators\.enrich\.email|people\.enrich\.email|people\.email\.enrich|search_profiles_email|people\.phone\.lookup|email\.sources)/i.test(e.id) },
  { id: "S6_advertising_ids", category: "sensitive", note: "mobile advertising ids and email hashes", test: (e) => /audiences?[._-](maid|hashes|sha256|email[_-]hash|resolve)/i.test(e.id) || /^people\.audience/.test(e.capability || "") },
  { id: "S7_personality", category: "sensitive", note: "personality analysis of a person", test: (e) => /personality/i.test(e.id) || /personality/i.test(e.capability || "") },
  { id: "S8_home_address_family", category: "sensitive", note: "home address and family data", test: (e) => /(^|\.)people\.address(\.|$)/.test(e.id) || /\b(relatives|family members|household)\b/i.test(`${e.name} ${e.summary}`) },

  // ------------------------------------------------------------ b2b_contact
  { id: "C1_people_contact_finders", category: "b2b_contact", note: "work email, business phone and email verification (people.*)", test: (e) => /^people\.(email|phone)\./.test(e.capability || "") || /(^|\.)people\.(email|phone)\./.test(e.id) },
  { id: "C2_work_email", category: "b2b_contact", note: "work email of a person or of a domain", test: (e) => /(work[_-]email|email\.work|\.people\.work)/i.test(e.id) || /^companies\.emails/.test(e.capability || "") || /\.companies\.emails(\.|$)/.test(e.id) || /email_pattern/.test(e.id) || /email-count/.test(e.id) || /\.user\.profile\.email$/.test(e.id) || /b2b-profile-email/.test(e.id) },
  { id: "C3_professional_profile", category: "b2b_contact", note: "professional profiles and people search / enrichment (platform people)", test: (e) => String(e.platform || "").toLowerCase() === "people" },
];

export const CATEGORIES = ["public", "b2b_contact", "sensitive", "blocked"];

export function classify(endpoint, ctx) {
  for (const rule of RULES) {
    if (rule.test(endpoint, ctx)) return { category: rule.category, rule: rule.id };
  }
  return { category: "public", rule: null };
}

export function build() {
  const snapshotText = readFileSync(SNAPSHOT);
  const snapshot = JSON.parse(snapshotText.toString("utf-8"));
  const writes = JSON.parse(readFileSync(WRITES, "utf-8"));
  const writeIds = new Set(writes.map((w) => w.id));
  const ctx = { writeIds };
  const endpoints = {};
  const rules = {};
  const counts = { public: 0, b2b_contact: 0, sensitive: 0, blocked: 0 };
  const ruleCounts = {};
  const add = (e) => {
    const { category, rule } = classify(e, ctx);
    endpoints[e.id] = category;
    if (rule) { rules[e.id] = rule; ruleCounts[rule] = (ruleCounts[rule] || 0) + 1; }
    counts[category] += 1;
  };
  for (const e of snapshot.endpoints) add(e);
  // The write actions are not in the sellable snapshot: they are classified by name so a model-made id of one is refused with its reason.
  for (const w of writes) if (!(w.id in endpoints)) add({ id: w.id, provider: w.id.split(".")[0], platform: w.platform, capability: null, name: w.name, summary: null, scope: w.scope });
  const sortedKeys = Object.keys(endpoints).sort();
  const sortObject = (o) => Object.fromEntries(sortedKeys.filter((k) => k in o).map((k) => [k, o[k]]));
  return {
    version: 1,
    generatedBy: "scripts/treg/build-data-policy.mjs",
    snapshot: { file: "treg_catalog_sellable.json", sha256: createHash("sha256").update(snapshotText).digest("hex"), endpoints: snapshot.endpoints.length, writeActions: writes.length },
    categories: {
      public: "Public data: available to every customer, priced by code from real cost.",
      b2b_contact: "Work email, business phone, professional profile: available to every customer, priced by code from real cost.",
      sensitive: "Personal contact, reverse lookups, advertising ids, personality: only the admin and verified business accounts, with a purpose and an audit row.",
      blocked: "Never offered, sampled or executed.",
    },
    pausedProviders: PAUSED_PROVIDERS,
    rules: RULES.map((r) => ({ id: r.id, category: r.category, note: r.note })),
    counts,
    ruleCounts: Object.fromEntries(Object.entries(ruleCounts).sort()),
    rule: sortObject(rules),
    endpoints: sortObject(endpoints),
  };
}

export function listsMarkdown(policy, snapshot) {
  const byId = new Map(snapshot.endpoints.map((e) => [e.id, e]));
  const lines = [];
  lines.push("# Data category policy: the lists");
  lines.push("");
  lines.push("Generated by `node scripts/treg/build-data-policy.mjs` from `data/treg/treg_catalog_sellable.json` and `data/treg/treg_write_actions.json`. Do not edit by hand.");
  lines.push("");
  lines.push("| Category | Endpoints |");
  lines.push("|---|---|");
  for (const c of CATEGORIES) lines.push(`| ${c} | ${policy.counts[c]} |`);
  lines.push(`| total | ${Object.keys(policy.endpoints).length} |`);
  lines.push("");
  lines.push("## Rules (first match wins)");
  lines.push("");
  lines.push("| Rule | Category | Meaning | Endpoints |");
  lines.push("|---|---|---|---|");
  for (const r of policy.rules) lines.push(`| ${r.id} | ${r.category} | ${r.note} | ${policy.ruleCounts[r.id] || 0} |`);
  const section = (title, category, withRule = true) => {
    const ids = Object.keys(policy.endpoints).filter((id) => policy.endpoints[id] === category);
    lines.push("");
    lines.push(`## ${title} (${ids.length})`);
    lines.push("");
    lines.push("| id | rule | name | cost USD |");
    lines.push("|---|---|---|---|");
    for (const id of ids) {
      const e = byId.get(id);
      lines.push(`| \`${id}\` | ${withRule ? policy.rule[id] || "" : ""} | ${String(e?.name || "").replace(/\|/g, "/")} | ${e?.cost?.usd ?? ""} |`);
    }
  };
  section("Sensitive", "sensitive");
  section("Blocked", "blocked");
  section("B2B contact", "b2b_contact");
  lines.push("");
  lines.push("## Public");
  lines.push("");
  lines.push(`All other ${policy.counts.public} endpoints of the snapshot (ids in \`data/treg/data_policy.json\`).`);
  lines.push("");
  return lines.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const policy = build();
  const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf-8"));
  const json = `${JSON.stringify(policy, null, 1)}\n`;
  const md = listsMarkdown(policy, snapshot);
  if (process.argv.includes("--check")) {
    const same = (file, text) => { try { return readFileSync(file, "utf-8") === text; } catch { return false; } };
    if (!same(OUT, json) || !same(LISTS, md)) { console.error("data policy files are out of date: run node scripts/treg/build-data-policy.mjs"); process.exit(1); }
    console.log("data policy files are up to date");
  } else {
    mkdirSync(path.dirname(LISTS), { recursive: true });
    writeFileSync(OUT, json);
    writeFileSync(LISTS, md);
    console.log(JSON.stringify({ counts: policy.counts, ruleCounts: policy.ruleCounts }));
  }
}
