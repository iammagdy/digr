import { multiProviderEnabled } from "../../multiProvider/flag";
import { PLAN_LIMITS_AR, whatWeCollectAr } from "../../multiProvider/copy";
import { CHAIN_CAPABILITY_SLUG } from "../../multiProvider/routes";
import { buildAllowedRoutes } from "../../multiProvider/router";
import type { RequiredField } from "../../multiProvider/types";
import { extractRequestIntent } from "../../requestIntent";
import { loadRouterState, normalizeRequiredFields, routeRequestFromParams } from "./planRouting";

/**
 * Plan time: a company-search or people-search plan whose request asks for CONTACT data that the existing sources do not return as a
 * verified field (a business email, a business phone, an owner or manager named on a public team page) is offered the chain instead,
 * when - and only when - the flag is on and the router lists at least one allowed route for it. Everything else keeps the plan exactly
 * as it was: with the flag off this module returns its input untouched, and with no allowed route the original plan is the fallback.
 * Code decides here; the model is consulted once, later, only to pick among allowed routes (see planRouting.ts), and never for a price.
 */

const EMAIL_RE = /إيميل|ايميل|بريد|email|e-?mail/i;
const PHONE_RE = /(?<![\p{L}])(?:و)?(?:ال)?(?:أرقام|ارقام|رقم|هاتف|هواتف|تليفون|تليفونات|موبايل|موبايلات)|phone/iu;
/**
 * Who the customer asks for. «صناع القرار» is only one of the ways: a named role («مدير المشتريات», «مسؤولي التسويق», «رئيس مجلس الإدارة», «المؤسسين»,
 * «CEO») is the same request when it is asked for from the companies' public team pages (the route needs BOTH, see TEAM_PAGES_RE).
 */
const DECISION_RE = /صان(?:ع|عي|عو)\s+(?:ال)?قرار|صناع\s+(?:ال)?قرار|أصحاب\s+(?:ال)?قرار|decision[\s-]*makers?|المدير(?:ين)?\s+(?:ال)?تنفيذي|مالك(?:ي)?\s+(?:ال)?شرك|أصحاب\s+(?:ال)?شركات|مديري\s+(?:ال)?شركات|(?<![\p{L}])(?:ال)?(?:مسؤول|مسئول)(?:ين|ي|و)?(?![\p{L}])|(?<![\p{L}])(?:ال)?(?:مدير|مديري|مديرين|مدراء)(?![\p{L}])|(?<![\p{L}])(?:ال)?(?:رئيس|رؤساء)(?![\p{L}])|(?<![\p{L}])(?:ال)?(?:مؤسس|مؤسسي|مؤسسين)(?![\p{L}])|\b(?:ceo|cto|cfo|coo|cmo)\b|\b(?:managers?|executives?|owners?|founders?|directors?)\b/iu;
const TEAM_PAGES_RE = /صفحات?\s+(?:ال)?فريق|صفحة\s+(?:ال)?إدارة|مواقع\s+(?:ال)?شركات|المنشور(?:ة|ين)?\s+(?:على|في)\s+(?:مواقع|المواقع)|team\s+pages?|public\s+team/i;
const COMPANY_SLUG_RE = /compan|b2b/i;
const PEOPLE_SLUG_RE = /people/i;

export interface ContactIntent { email: boolean; phone: boolean; decisionMaker: boolean; teamPagesNamed: boolean }

export function detectContactIntent(text: string): ContactIntent {
  const body = text || "";
  return { email: EMAIL_RE.test(body), phone: PHONE_RE.test(body), decisionMaker: DECISION_RE.test(body), teamPagesNamed: TEAM_PAGES_RE.test(body) };
}

export interface UpgradeablePlanItem {
  capabilitySlug: string;
  endpointId?: string;
  params: Record<string, any>;
  targetVolumeMin: number;
  targetVolumeMax: number;
  paginationStrategy?: "cursor" | "offset" | "page" | "none";
  stepId?: string;
}

export interface ChainUpgradeResult<T extends UpgradeablePlanItem> {
  upgraded: boolean;
  items: T[];
  /** The customer's goal line for the upgraded plan (what is collected and how many); unchanged text when not upgraded. */
  summaryAr: string;
  /** Honest limits shown on the plan card before approval; unchanged text when not upgraded. */
  methodologyNotes: string | undefined;
}

/**
 * The chain item for a request, or null when the request does not call for it. Pure: no router, no network.
 * Companies + email/phone words -> the contact fields asked for. Decision makers -> only when the customer names company team pages
 * (a plain people search keeps the existing people service, which has its own verified contact rules).
 */
export function chainItemFor<T extends UpgradeablePlanItem>(items: T[], requestText: string): { item: UpgradeablePlanItem; requiredFields: RequiredField[]; industryAr?: string; countryAr?: string } | null {
  if (items.length !== 1) return null;
  const original = items[0];
  const slug = String(original.capabilitySlug || "");
  const isCompanies = COMPANY_SLUG_RE.test(slug) && !PEOPLE_SLUG_RE.test(slug) && slug !== CHAIN_CAPABILITY_SLUG;
  const isPeople = PEOPLE_SLUG_RE.test(slug);
  if (!isCompanies && !isPeople) return null;

  const contact = detectContactIntent(requestText);
  const fields: RequiredField[] = [];
  if (isCompanies) {
    if (contact.email) fields.push("work_email");
    if (contact.phone) fields.push("office_phone");
    if (contact.decisionMaker && contact.teamPagesNamed) fields.push("decision_maker");
    if (fields.length === 0) return null;
  } else {
    // People: only when the customer asks for them from the companies' own public team pages, and asks for no email or phone that the
    // people service verifies on its own.
    if (!(contact.decisionMaker && contact.teamPagesNamed)) return null;
    fields.push("decision_maker");
    if (contact.email) fields.push("work_email");
    if (contact.phone) fields.push("office_phone");
  }

  const intent = extractRequestIntent(requestText);
  const keywords = intent.industry?.keywordsEn ?? [];
  // A request without its activity or country is not ready: the existing questions come first, so the plan is left as it is.
  if (!intent.country || keywords.length === 0) return null;

  const count = Math.max(1, Math.floor(Number(original.targetVolumeMax) || intent.count || 1));
  const requiredFields = normalizeRequiredFields(fields);
  return {
    requiredFields,
    industryAr: intent.industry?.arabic,
    countryAr: intent.country.arabic,
    item: {
      stepId: original.stepId,
      capabilitySlug: CHAIN_CAPABILITY_SLUG,
      endpointId: "mp.business.contacts",
      paginationStrategy: "cursor",
      params: {
        industry: keywords[0],
        keyword: keywords.slice(0, 3).join(" "),
        country: intent.country.english,
        ...(intent.country.iso ? { countryIso: intent.country.iso } : {}),
        ...(intent.industry?.arabic ? { industryAr: intent.industry.arabic } : {}),
        countryAr: intent.country.arabic,
        requiredFields,
      },
      targetVolumeMin: Math.min(Math.max(1, Math.floor(Number(original.targetVolumeMin) || 1)), count),
      targetVolumeMax: count,
    },
  };
}

/**
 * The upgrade. `client` is the database client used to read the router's facts (keys, health, caps). Flag off: the same items, summary
 * and notes come back untouched, with no router read at all.
 */
export async function maybeUpgradeToChainPlan<T extends UpgradeablePlanItem>(args: {
  client: any;
  items: T[];
  requestText: string;
  summaryAr: string;
  methodologyNotes?: string;
}): Promise<ChainUpgradeResult<T>> {
  const unchanged: ChainUpgradeResult<T> = { upgraded: false, items: args.items, summaryAr: args.summaryAr, methodologyNotes: args.methodologyNotes };
  if (!multiProviderEnabled()) return unchanged;
  try {
    const candidate = chainItemFor(args.items, args.requestText);
    if (!candidate) return unchanged;
    // «Is any route allowed for this request?»: answered by code alone (no model call). The model is called once, at the quote, among the allowed routes.
    const request = routeRequestFromParams(candidate.item.params, candidate.item.targetVolumeMax);
    const state = await loadRouterState(args.client);
    if (buildAllowedRoutes(request, state).allowed.length === 0) return unchanged;
    const needs = (f: RequiredField) => candidate.requiredFields.includes(f);
    return {
      upgraded: true,
      items: [candidate.item as T],
      summaryAr: whatWeCollectAr({
        count: candidate.item.targetVolumeMax,
        withEmail: needs("work_email"),
        withPhone: needs("office_phone"),
        withDecisionMaker: needs("decision_maker"),
        industry: candidate.industryAr,
        country: candidate.countryAr,
      }),
      methodologyNotes: PLAN_LIMITS_AR.join(" "),
    };
  } catch {
    // Never let the optional path break a plan: the original plan stands.
    return unchanged;
  }
}
