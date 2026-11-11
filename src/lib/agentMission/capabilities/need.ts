import { normalizeDigits } from "../../arabicDigits";
import { requestWantsContacts } from "../contacts";
import { privacyRefusalAr } from "../guardRules";
import { countedQuantities } from "../quantity";
import { buildRequestContract, platformsNamedIn } from "../requestContract";
import type { ResearchBrief } from "../researchBrief";
import type { SocialPlatform } from "../redesignFlagTypes";
import type { InputClass, Operation, OutputClass } from "./registry";

/**
 * WHAT THE CUSTOMER NEEDS, AS DATA OPERATIONS (docs/UNIFIED-CAPABILITY-DISCOVERY.md). Read by code from the customer's own words (the mission's request and answer, or the validated research brief's consolidated request and fields): which kind of
 * data, from which platform(s), which child steps (comments, replies, contacts, reviews), how many, and which conditions (period, country, language). The model's brief may ADD platforms and contents it understood, but only after
 * `validateBrief` checked them against the customer's words; nothing here invents a platform or a number.
 *
 * Then the CHAIN: the ordered stages that would carry the request out, each with its operation, its parent and what it needs from the parent's rows (a comments stage needs a post reference or link; a reviews stage a place reference or link;
 * a contacts stage a company's website or domain). Pure; never throws.
 */
export type NeedKind = "social" | "companies" | "places" | "web" | "people" | "unknown";

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
}

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
  brief?: Pick<ResearchBrief, "platforms" | "content" | "count"> | null;
  semantic?: boolean;
}

export function researchNeedOf(input: NeedInput): ResearchNeed {
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

/** What the parent's rows give that the child stage can take as its input (null: nothing links them; the chain cannot be built). */
export function linkOf(parentOutputs: ReadonlyArray<OutputClass>, childTakes: ReadonlyArray<InputClass>): { from: OutputClass; to: InputClass } | null {
  const pairs: Array<[OutputClass, InputClass]> = [["place_ref", "place_ref"], ["url", "url"], ["id", "post_ref"], ["id", "comment_ref"], ["website", "domain"], ["website", "url"]];
  for (const [from, to] of pairs) if (parentOutputs.includes(from) && childTakes.includes(to)) return { from, to };
  return null;
}
