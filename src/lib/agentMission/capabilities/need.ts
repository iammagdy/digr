import { normalizeDigits } from "../../arabicDigits";
import { requestWantsContacts } from "../contacts";
import { privacyRefusalAr } from "../guardRules";
import { countedQuantities } from "../quantity";
import { buildRequestContract, platformsNamedIn } from "../requestContract";
import { isServedPlatform, type BriefObjective, type ResearchBrief } from "../researchBrief";
import type { SocialPlatform } from "../redesignFlagTypes";
import type { InputClass, Operation, OutputClass } from "./registry";

/**
 * WHAT THE CUSTOMER NEEDS, AS DATA OPERATIONS (docs/UNIFIED-CAPABILITY-DISCOVERY.md, docs/LLM-FIRST-OBJECTIVES.md).
 *
 * PRIMARY (LLM-first): the research OBJECTIVES the chat model proposed in the brief, after `validateBrief` checked them (structure, grounding, nothing dropped) and the worker checked them again against the mission's own words: each objective
 * is an operation of the registry, so the need is the objectives themselves (every one kept, several kinds in one request included). A goal the model could not map to an operation, or a platform no provider serves, is kept as UNRESOLVED:
 * the customer is asked, never told «unsupported» because a keyword was missing.
 *
 * FALLBACK (no validated objectives: brief mode off, an old brief, a request typed without the brief): read by code from the customer's own words (the mission's request and answer, or the validated research brief's consolidated request and fields): which kind of
 * data, from which platform(s), which child steps (comments, replies, contacts, reviews), how many, and which conditions (period, country, language). The model's brief may ADD platforms and contents it understood, but only after
 * `validateBrief` checked them against the customer's words; nothing here invents a platform or a number.
 *
 * Then the CHAIN: the ordered stages that would carry the request out, each with its operation, its parent and what it needs from the parent's rows (a comments stage needs a post reference or link; a reviews stage a place reference or link;
 * a contacts stage a company's website or domain). Pure; never throws.
 */
export type NeedKind = "social" | "companies" | "places" | "web" | "people" | "mixed" | "unknown";

export interface ResearchNeed {
  kind: NeedKind;
  /** The social platforms (one chain each); empty for any other kind. */
  platforms: SocialPlatform[];
  comments: boolean;
  replies: boolean;
  /** Places: the reviews of each place. */
  reviews: boolean;
  /** Companies: their websites (a column, and the input of a contacts stage). */
  websites: boolean;
  /** Companies: their PUBLIC business contacts (a work e-mail or the company's phone written on its own public pages). Never a private person's. */
  contacts: { email: boolean; phone: boolean };
  /** Companies: the PUBLIC professionals of each company (decision makers), from public professional profiles. */
  people: boolean;
  /** The customer's number of top-level items, or null. */
  count: number | null;
  conditions: { period: boolean; country: boolean; language: boolean };
  /** The request asks for private personal data (the same rule as the chat's privacy guard): no capability may be planned for it. */
  privacy: "ok" | "blocked";
  /** A platform the customer named that no provider serves (e.g. Snapchat). */
  unsupportedPlatform: string | null;
  topic: string | null;
  /** How the need was read: from the model's validated objectives, or from the words (fallback). */
  source: "objectives" | "words";
  /** The executable objectives (objective reading only), in order. Every one becomes at least one stage. */
  objectives?: NeedObjective[];
  /** What the model understood that no operation or served platform can do (objective reading only): asked before any mission or plan, never dropped silently. */
  unresolved?: Array<{ operation: BriefObjective["operation"]; platform: string | null }>;
}

/** An executable objective (an operation of the registry, a served platform for social data). */
export interface NeedObjective { id: string; operation: Exclude<BriefObjective["operation"], "unsupported">; platform: SocialPlatform | null; parent: string | null; contacts: Array<"email" | "phone"> }

const fold = (raw: string): string => normalizeDigits(String(raw ?? "")).replace(/[ً-ٰٟـ]/g, "").replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").toLowerCase();
const COMPANY_WORDS = /شركا?ت|شركه|مكاتب|وكالات|وكاله|مصانع|مصنع|موردين|businesses|companies|company|agencies|firms|suppliers/;
const PLACE_WORDS = /فنادق|فندق|مطاعم|مطعم|كافيهات|كافيه|اماكن|محلات|عيادات|مستشفيات|صيدليات|منتجعات|معالم|hotels?|restaurants?|cafes?|places|clinics|resorts|attractions/;
const REVIEW_WORDS = /تقييمات|تقييم|ريفيوهات|ريفيو|مراجعات|اراء\s+(?:الزوار|النزلاء|العملاء)|reviews?|ratings?/;
const WEBSITE_WORDS = /مواقعهم|مواقعها|موقعهم|مواقع\s*(?:ال)?(?:شركات|الكترونيه|ويب)|ويب\s*سايت|websites?|domains?|روابط\s*(?:ال)?مواقع/;
const PEOPLE_WORDS = /مديرين|مدراء|مسؤولين|صناع\s*(?:ال)?قرار|موظفين|decision\s*makers|managers|executives|ceos?/;
const WEB_WORDS = /اخبار|مقالات|مدونات|منتديات|مواقع\s*(?:ال)?اخبار|صحف|جرايد|news|articles|blogs|forums|web\s*pages|اراء\s*(?:ال)?ناس|اراء/;
const COMMENT_WORDS = /تعليق|كومنت|comments?/;
const REPLY_WORDS = /ردود|الرد(?:ود)?|ريبلاي|replies/;
/** Platforms no provider of the registry serves (the five social platforms, the web, maps and companies are served). */
const UNSUPPORTED_PLATFORMS: ReadonlyArray<[string, RegExp]> = [["snapchat", /سناب\s*شات|سناب(?![ء-ي])|snapchat/], ["clubhouse", /كلوب\s*هاوس|clubhouse/], ["discord", /ديسكورد|discord/]];

export interface NeedInput {
  request: string;
  answer?: string | null;
  /** The validated research brief of the chat (brief mode), when there is one: its platforms and contents were checked against the customer's words. */
  brief?: Pick<ResearchBrief, "platforms" | "content" | "count" | "objectives"> | null;
  semantic?: boolean;
}

const KIND_OF_ROOT: Record<NeedObjective["operation"], NeedKind> = {
  "social.parents": "social", "social.comments": "social", "social.replies": "social",
  "companies.discover": "companies", "company.contacts": "companies", "places.discover": "places", "places.reviews": "places", "web.search": "web", "web.read": "web", "people.discover": "people",
};

/** The need read from validated objectives (see the header). The count, the conditions, the topic and privacy are still read by the trusted contract from the words (numbers are never the model's). */
function needOfObjectives(objectives: ReadonlyArray<BriefObjective>, text: string, input: NeedInput): ResearchNeed {
  const contract = buildRequestContract(input.request, input.answer ?? undefined, { semantic: input.semantic === true });
  const executable: NeedObjective[] = [];
  const unresolved: NonNullable<ResearchNeed["unresolved"]> = [];
  const dropped = new Set<string>();
  for (const o of objectives) {
    const social = o.operation.startsWith("social.");
    if (o.operation === "unsupported" || (social && !isServedPlatform(o.platform)) || (o.parent !== null && dropped.has(o.parent))) {
      dropped.add(o.id);
      unresolved.push({ operation: o.operation, platform: o.platform });
      continue;
    }
    executable.push({ id: o.id, operation: o.operation as NeedObjective["operation"], platform: social ? (o.platform as SocialPlatform) : null, parent: o.parent, contacts: [...o.contacts] });
  }
  const ops = new Set(executable.map((o) => o.operation));
  const rootKinds = new Set(executable.filter((o) => o.parent === null).map((o) => KIND_OF_ROOT[o.operation]));
  const kinds = new Set(executable.map((o) => KIND_OF_ROOT[o.operation]));
  // people of companies are part of the companies kind; a first people search is its own kind
  const kind: NeedKind = executable.length === 0 ? "unknown" : rootKinds.size > 1 ? "mixed" : ([...rootKinds][0] ?? [...kinds][0]);
  const contacts = { email: executable.some((o) => o.operation === "company.contacts" && o.contacts.includes("email")), phone: executable.some((o) => o.operation === "company.contacts" && o.contacts.includes("phone")) };
  return {
    kind,
    platforms: [...new Set(executable.map((o) => o.platform).filter((p): p is SocialPlatform => p !== null))].sort(),
    comments: ops.has("social.comments"),
    replies: ops.has("social.replies"),
    reviews: ops.has("places.reviews"),
    websites: contacts.email || contacts.phone,
    contacts,
    people: executable.some((o) => o.operation === "people.discover" && o.parent !== null),
    count: contract.count ?? input.brief?.count ?? countedQuantities(text)[0]?.value ?? null,
    conditions: { period: contract.period, country: contract.country, language: contract.language },
    privacy: privacyRefusalAr(text) ? "blocked" : "ok",
    unsupportedPlatform: unresolved.find((u) => u.platform !== null && !isServedPlatform(u.platform))?.platform ?? null,
    topic: contract.topic,
    source: "objectives",
    objectives: executable,
    unresolved,
  };
}

export function researchNeedOf(input: NeedInput): ResearchNeed {
  const objectives = input.brief?.objectives ?? [];
  if (objectives.length > 0) return needOfObjectives(objectives, `${String(input.request ?? "")} ${String(input.answer ?? "")}`.replace(/\s+/g, " ").trim(), input);
  const text = `${String(input.request ?? "")} ${String(input.answer ?? "")}`.replace(/\s+/g, " ").trim();
  const t = fold(text);
  const contract = buildRequestContract(input.request, input.answer ?? undefined, { semantic: input.semantic === true });
  const brief = input.brief ?? null;
  const platforms = [...new Set<SocialPlatform>([...platformsNamedIn(text), ...(contract.platform ? [contract.platform] : []), ...((brief?.platforms ?? []) as SocialPlatform[])])].sort();
  const content = new Set<string>(brief?.content ?? []);
  const contacts = requestWantsContacts(text);
  const unsupported = UNSUPPORTED_PLATFORMS.find(([, re]) => re.test(t))?.[0] ?? null;
  const companies = content.has("companies") || COMPANY_WORDS.test(t);
  const places = content.has("places") || PLACE_WORDS.test(t);
  const reviews = content.has("reviews") || REVIEW_WORDS.test(t);
  const people = content.has("people") || PEOPLE_WORDS.test(t);
  let kind: NeedKind = "unknown";
  if (platforms.length > 0) kind = "social";
  else if (places && (reviews || !companies)) kind = "places";
  else if (companies) kind = "companies";
  else if (people) kind = "people";
  else if (WEB_WORDS.test(t) || unsupported) kind = "web";
  const comments = kind === "social" && (contract.comments !== "none" || content.has("comments") || COMMENT_WORDS.test(t));
  const replies = kind === "social" && (contract.replies !== "none" || content.has("replies") || REPLY_WORDS.test(t));
  return {
    kind,
    platforms: kind === "social" ? platforms : [],
    comments,
    replies,
    reviews: kind === "places" && reviews,
    websites: kind === "companies" && (WEBSITE_WORDS.test(t) || contacts.email || contacts.phone),
    contacts: kind === "companies" ? contacts : { email: false, phone: false },
    people: kind === "companies" && people,
    count: contract.count ?? brief?.count ?? countedQuantities(text)[0]?.value ?? null,
    conditions: { period: contract.period, country: contract.country, language: contract.language },
    privacy: privacyRefusalAr(text) ? "blocked" : "ok",
    unsupportedPlatform: unsupported,
    topic: contract.topic,
    source: "words",
  };
}

/** One stage of the chain the request needs. */
export interface StageNeed {
  key: string;
  operation: Operation;
  /** The platform the capability must serve (a social platform), or null. */
  platform: string | null;
  parentKey: string | null;
  /** The output classes the stage's rows MUST carry (for the file and for the next stage). */
  requires: OutputClass[];
  /** The output classes worth having (ranked, never required). */
  prefers: OutputClass[];
  /** The input class(es) the stage may be fed with; `query` only for a stage without a parent. */
  accepts: InputClass[];
  /** The rows the stage must reach when the customer gave a number for it (top-level items), else null. */
  volume: number | null;
  /** Whether the customer will receive this stage's rows. */
  deliver: boolean;
}

/** The chain of stages that carries the need out (empty when the need is unknown or blocked). */
export function stagesOfNeed(need: ResearchNeed): StageNeed[] {
  if (need.privacy === "blocked" || need.kind === "unknown") return [];
  if (need.objectives && need.objectives.length > 0) return stagesOfObjectives(need, need.objectives);
  const out: StageNeed[] = [];
  if (need.kind === "social") {
    for (const p of need.platforms) {
      const parents = `${p}_parents`;
      const childAsked = need.comments || need.replies;
      out.push({ key: parents, operation: "social.parents", platform: p, parentKey: null, requires: childAsked ? ["id", "url"] : ["url", "text"], prefers: ["text", "date", "author", "comment_count"], accepts: ["query"], volume: childAsked ? null : need.count, deliver: true });
      if (need.comments || need.replies) {
        out.push({ key: `${p}_comments`, operation: "social.comments", platform: p, parentKey: parents, requires: ["id", "text"], prefers: ["date", "author"], accepts: ["post_ref", "url"], volume: need.count, deliver: true });
      }
      // on X a reply to a post IS its comment (the contract reads «تعليقات إكس» as the replies of the posts): no separate replies stage
      if (need.replies && p !== "x") out.push({ key: `${p}_replies`, operation: "social.replies", platform: p, parentKey: `${p}_comments`, requires: ["id", "text"], prefers: ["date", "author"], accepts: ["comment_ref"], volume: null, deliver: true });
    }
    return out;
  }
  if (need.kind === "companies") {
    out.push({ key: "companies", operation: "companies.discover", platform: null, parentKey: null, requires: need.websites ? ["name", "website"] : ["name"], prefers: ["website", "phone", "url"], accepts: ["query"], volume: need.count, deliver: true });
    // the company's PUBLIC business contacts, one stage per kind asked (a source of e-mails is not a source of phones): fed by the company's website or domain
    if (need.contacts.email) out.push({ key: "company_emails", operation: "company.contacts", platform: null, parentKey: "companies", requires: ["email"], prefers: [], accepts: ["domain", "url"], volume: null, deliver: true });
    if (need.contacts.phone) out.push({ key: "company_phones", operation: "company.contacts", platform: null, parentKey: "companies", requires: ["phone"], prefers: [], accepts: ["domain", "url"], volume: null, deliver: true });
    if (need.people) out.push({ key: "company_people", operation: "people.discover", platform: null, parentKey: "companies", requires: ["name"], prefers: ["title", "company", "url"], accepts: ["domain", "url", "query"], volume: null, deliver: true });
    return out;
  }
  if (need.kind === "places") {
    out.push({ key: "places", operation: "places.discover", platform: null, parentKey: null, requires: need.reviews ? ["name", "place_ref"] : ["name"], prefers: ["rating", "website", "phone", "url"], accepts: ["query"], volume: need.reviews ? null : need.count, deliver: true });
    if (need.reviews) out.push({ key: "place_reviews", operation: "places.reviews", platform: null, parentKey: "places", requires: ["text", "rating"], prefers: ["date", "author", "url"], accepts: ["place_ref", "url"], volume: need.count, deliver: true });
    return out;
  }
  if (need.kind === "people") {
    out.push({ key: "people", operation: "people.discover", platform: null, parentKey: null, requires: ["name"], prefers: ["title", "company", "url"], accepts: ["query"], volume: need.count, deliver: true });
    return out;
  }
  // the public web: the pages a search finds, then each page read
  out.push({ key: "web_results", operation: "web.search", platform: null, parentKey: null, requires: ["url"], prefers: ["name", "text"], accepts: ["query"], volume: need.count, deliver: true });
  out.push({ key: "web_pages", operation: "web.read", platform: null, parentKey: "web_results", requires: ["text"], prefers: ["url"], accepts: ["url"], volume: null, deliver: true });
  return out;
}

/** What each operation's stage must give, is worth having, and can be fed with (the same definitions as the reading from the words). */
function stageShape(op: NeedObjective["operation"], hasChild: boolean, isRoot: boolean): Pick<StageNeed, "requires" | "prefers" | "accepts"> {
  switch (op) {
    case "social.parents": return { requires: hasChild ? ["id", "url"] : ["url", "text"], prefers: ["text", "date", "author", "comment_count"], accepts: ["query"] };
    case "social.comments": return { requires: ["id", "text"], prefers: ["date", "author"], accepts: ["post_ref", "url"] };
    case "social.replies": return { requires: ["id", "text"], prefers: ["date", "author"], accepts: ["comment_ref"] };
    case "companies.discover": return { requires: hasChild ? ["name", "website"] : ["name"], prefers: ["website", "phone", "url"], accepts: ["query"] };
    case "company.contacts": return { requires: [], prefers: [], accepts: ["domain", "url"] };
    case "places.discover": return { requires: hasChild ? ["name", "place_ref"] : ["name"], prefers: ["rating", "website", "phone", "url"], accepts: ["query"] };
    case "places.reviews": return { requires: ["text", "rating"], prefers: ["date", "author", "url"], accepts: ["place_ref", "url"] };
    case "web.search": return { requires: ["url"], prefers: ["name", "text"], accepts: ["query"] };
    case "web.read": return { requires: ["text"], prefers: ["url"], accepts: ["url"] };
    case "people.discover": return { requires: ["name"], prefers: ["title", "company", "url"], accepts: isRoot ? ["query"] : ["domain", "url", "query"] };
  }
}
/** The step an objective needs before it when the model wrote it alone (comments are read from posts, reviews from places …): added by code, as the chain requires, never a new goal. */
const IMPLIED_PARENT: Partial<Record<NeedObjective["operation"], NeedObjective["operation"]>> = { "social.comments": "social.parents", "social.replies": "social.comments", "company.contacts": "companies.discover", "places.reviews": "places.discover", "web.read": "web.search" };
const BASE_KEY: Record<NeedObjective["operation"], (o: NeedObjective, rootChild: boolean) => string> = {
  "social.parents": (o) => `${o.platform}_parents`, "social.comments": (o) => `${o.platform}_comments`, "social.replies": (o) => `${o.platform}_replies`,
  "companies.discover": () => "companies", "company.contacts": () => "company_contacts", "places.discover": () => "places", "places.reviews": () => "place_reviews",
  "web.search": () => "web_results", "web.read": () => "web_pages", "people.discover": (_o, child) => (child ? "company_people" : "people"),
};

/**
 * THE CHAIN OF THE OBJECTIVES: one stage per objective (one per contact kind for company contacts: a source of e-mails is not a source of phones), its parent the stage of its parent objective, the step the chain needs added by code when the
 * model wrote a child alone. On X a reply to a post IS its comment: an X replies objective is the X comments stage. The customer's count binds the deepest stage of the FIRST objective's chain (the items they counted), as the reading from
 * the words does; the other chains carry no volume (the planner states theirs on the card, with the price, before approval).
 */
function stagesOfObjectives(need: ResearchNeed, objectivesIn: ReadonlyArray<NeedObjective>): StageNeed[] {
  // X: the replies of a post ARE its comments; an X replies objective is the X comments objective (merged into one when both were written)
  const remap = new Map<string, string>();
  const normalized: NeedObjective[] = [];
  for (const o of objectivesIn) {
    if (o.operation === "social.replies" && o.platform === "x") {
      const comments = normalized.find((x) => x.operation === "social.comments" && x.platform === "x");
      if (comments) { remap.set(o.id, comments.id); continue; }
      normalized.push({ ...o, operation: "social.comments", parent: o.parent && objectivesIn.find((x) => x.id === o.parent)?.operation === "social.comments" ? null : o.parent });
      continue;
    }
    normalized.push({ ...o, parent: o.parent ? remap.get(o.parent) ?? o.parent : null });
  }
  // complete the chains (implied parents), keep the model's order otherwise
  const objectives: NeedObjective[] = [];
  const byId = new Map<string, NeedObjective>();
  let implied = 0;
  const add = (o: NeedObjective): NeedObjective => {
    const parentOp = IMPLIED_PARENT[o.operation];
    let parent = o.parent ? byId.get(o.parent) ?? null : null;
    if (!parent && parentOp) {
      const existing = objectives.find((x) => x.operation === parentOp && x.platform === o.platform);
      parent = existing ?? add({ id: `_implied${(implied += 1)}`, operation: parentOp, platform: o.platform, parent: null, contacts: [] });
    }
    // replies are read from the comments of the posts: replies written directly under the posts get the comments step between them
    if (parent && o.operation === "social.replies" && parent.operation === "social.parents") {
      const under = parent;
      parent = objectives.find((x) => x.operation === "social.comments" && x.parent === under.id) ?? add({ id: `_implied${(implied += 1)}`, operation: "social.comments", platform: o.platform, parent: under.id, contacts: [] });
    }
    const placed = { ...o, parent: parent ? parent.id : null };
    objectives.push(placed);
    byId.set(placed.id, placed);
    return placed;
  };
  for (const o of normalized) if (!byId.has(o.id)) add(o);

  const out: StageNeed[] = [];
  const keyOf = new Map<string, string[]>();
  const used = new Set<string>();
  const uniqueKey = (base: string): string => { let k = base; let n = 1; while (used.has(k)) { n += 1; k = `${base}_${n}`; } used.add(k); return k; };
  const hasChild = (o: NeedObjective) => objectives.some((x) => x.parent === o.id);
  for (const o of objectives) {
    const parentKey = o.parent ? (keyOf.get(o.parent) ?? [])[0] ?? null : null;
    const shape = stageShape(o.operation, hasChild(o), parentKey === null);
    if (o.operation === "company.contacts") {
      const keys: string[] = [];
      for (const kind of o.contacts) {
        const key = uniqueKey(kind === "email" ? "company_emails" : "company_phones");
        out.push({ key, operation: o.operation, platform: null, parentKey, requires: [kind], prefers: [], accepts: shape.accepts, volume: null, deliver: true });
        keys.push(key);
      }
      keyOf.set(o.id, keys);
      continue;
    }
    const key = uniqueKey(BASE_KEY[o.operation](o, parentKey !== null));
    out.push({ key, operation: o.operation, platform: o.platform, parentKey, ...shape, volume: null, deliver: true });
    keyOf.set(o.id, [key]);
  }
  // the customer's count: the items they counted, the deepest «counted» stage (comments, reviews) of the FIRST chain, else its first stage
  if (need.count !== null && out.length > 0) {
    let target = out[0];
    for (;;) { const child = out.find((s) => s.parentKey === target.key && (s.operation === "social.comments" || s.operation === "places.reviews")); if (!child) break; target = child; }
    target.volume = need.count;
  }
  return out;
}

/** What the parent's rows give that the child stage can take as its input (null: nothing links them; the chain cannot be built). */
export function linkOf(parentOutputs: ReadonlyArray<OutputClass>, childTakes: ReadonlyArray<InputClass>): { from: OutputClass; to: InputClass } | null {
  const pairs: Array<[OutputClass, InputClass]> = [["place_ref", "place_ref"], ["url", "url"], ["id", "post_ref"], ["id", "comment_ref"], ["website", "domain"], ["website", "url"]];
  for (const [from, to] of pairs) if (parentOutputs.includes(from) && childTakes.includes(to)) return { from, to };
  return null;
}
