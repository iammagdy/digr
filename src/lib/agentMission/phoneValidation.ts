import { registrableDomain, sameCompanyName, type CompanyIdentity } from "./companyIdentity";
import { countriesOfCallingDigits, countryOfHostSuffix, countryOfIso3, countryOfValue, iso3OfCountry } from "./places";
import { verifyContactValue } from "./contacts";

/**
 * PHONES: WHOSE NUMBER IT IS, AND WHETHER IT IS REAL AND LOCAL (live test A1, 2026-11-01). A person row carried a US number (+1 858 254 9559) marked «موثّق» for an Egyptian company. Owner direction (benchmark: 0 of 10 personal phones exist in the sources; the company's head-office phone
 * was found and validated as an Egyptian landline for 10 of 10):
 *   - the personal phone is looked up first; when there is none, the COMPANY's phone goes in the person's row labelled «رقم الشركة» (the column «نوع الرقم»: «شخصي» / «رقم الشركة»);
 *   - every phone is validated; a number whose country is not the company's country is delivered as «رقم من دولة أخرى», never as «موثّق»; «موثّق» only when validation passes.
 * Pure: values in, a verdict out.
 */
export const PHONE_STATUS_VERIFIED_AR = "موثّق";
export const PHONE_STATUS_UNVERIFIED_AR = "غير موثّق";
export const PHONE_STATUS_OTHER_COUNTRY_AR = "رقم من دولة أخرى";
export const PHONE_TYPE_PERSONAL_AR = "شخصي";
export const PHONE_TYPE_COMPANY_AR = "رقم الشركة";
export const PHONE_TYPE_COLUMN_AR = "نوع الرقم";
export const phoneTypeKeyOf = (columnKey: string): string => `${columnKey}_type`;

const text = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "").replace(/[​-‏‪-‮⁦-⁩﻿]/g, " ").replace(/\s+/g, " ").trim();

// ------------------------------------------------------------------------------------------------ the company's country
const COUNTRY_KEY = /(^|_)(country|country_code|country_name|nation|countrycode|hq_country|headquarters_country)$/i;
const PLACE_KEY = /(^|_)(headquarters|hq|headquarter|location|address|city|region|state)$/i;

/**
 * The country a company is in (ISO 3166 alpha-2), from the evidence it carries, strongest first: a country field of its row (a code or a name), the country the customer's request names (the place filter of its stage), a place text of its row (a city, an address), the suffix
 * of its website. Null when nothing says (the phone is then validated for being real, not for being local).
 */
export function companyCountryOf(input: { row?: Record<string, unknown> | null; requestPlaces?: ReadonlyArray<string>; domain?: string | null }): string | null {
  const row = input.row ?? {};
  for (const [k, v] of Object.entries(row)) if (COUNTRY_KEY.test(k)) { const c = countryOfValue(text(v)); if (c) return c; }
  for (const p of input.requestPlaces ?? []) { const c = countryOfValue(p.includes(":") ? p.split(":")[0] : p); if (c) return c; }
  for (const [k, v] of Object.entries(row)) if (PLACE_KEY.test(k)) { const c = countryOfValue(text(v)); if (c) return c; }
  return input.domain ? countryOfHostSuffix(input.domain) : null;
}

// ------------------------------------------------------------------------------------------------ the number
/** The digits of a number written in international form (+20…, 0020…), without the prefix; null for a national number. */
export function internationalDigits(raw: string): string | null {
  const t = text(raw).replace(/[\s().-]/g, "");
  const m = /^(?:\+|00)(\d{6,15})$/.exec(t);
  return m ? m[1] : null;
}

/** The countries a number can belong to by its calling code (several for «1»), empty for a national number or an unknown code. */
export const countriesOfNumber = (raw: string): string[] => { const d = internationalDigits(raw); return d ? countriesOfCallingDigits(d) : []; };

/** What a phone validator is given for a number: the digits (with «+» for a validator that reads E.164), and for a NATIONAL number the company's country as the format hint (a national number sent with none can be read as another country's: a charged mistake). */
export function phoneInputFor(raw: string, companyCountry: string | null): { digits: string; international: boolean; country: string | null } {
  const intl = internationalDigits(raw);
  if (intl) return { digits: intl, international: true, country: null };
  const digits = text(raw).replace(/\D/g, "");
  return { digits, international: false, country: companyCountry };
}

/** The parameters of a phone validator for a number, or null when the validator needs something else. */
export function validatorParamsFor(validator: { inputs: ReadonlyArray<{ name: string; required: boolean }> }, raw: string, companyCountry: string | null): Record<string, string> | null {
  const input = phoneInputFor(raw, companyCountry);
  if (input.digits.length < 6) return null;
  const params: Record<string, string> = {};
  for (const i of validator.inputs) {
    if (/^(telephone_number|phone_number|msisdn)$/i.test(i.name)) params[i.name] = input.digits;
    else if (/^(phone|number)$/i.test(i.name)) params[i.name] = input.international ? `+${input.digits}` : input.digits;
    else if (/^input_format$/i.test(i.name)) { if (!input.international && input.country) { const iso3 = iso3OfCountry(input.country); if (iso3) params[i.name] = iso3; } }
    else if (/^(country_code|phone\.country_hint|country_hint|region)$/i.test(i.name)) { if (!input.international && input.country) params[i.name] = input.country; }
    else if (i.required) return null;
  }
  return Object.keys(params).length > 0 ? params : null;
}

export interface PhoneVerdict {
  /** True: the validator says it is a real number. False: it says it is not. Null: the answer does not say. */
  valid: boolean | null;
  /** The countries the validator places the number in (ISO 3166 alpha-2). */
  countries: string[];
}

/**
 * What a validator's answer says (hlrlookup.people.phone.validate: `results[0]` with `error`, `detected_telephone_number`, `telephone_number_type`, `original_network_details.country_iso3` / `country_prefix`; other validators: a `valid` flag, a `country_code`). Found by
 * walking the answer. An error other than «NONE», a false valid flag or a type of «INVALID» is not valid; a detected number, or a type that is a line type, is.
 */
export function phoneVerdictIn(page: unknown): PhoneVerdict {
  let valid: boolean | null = null;
  const countries: string[] = [];
  const addCountry = (c: string | null) => { if (c && !countries.includes(c)) countries.push(c); };
  const walk = (node: unknown, depth: number): void => {
    if (depth > 5 || node === null || node === undefined) return;
    if (Array.isArray(node)) { for (const x of node.slice(0, 3)) walk(x, depth + 1); return; }
    if (typeof node !== "object") return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const s = typeof v === "string" ? v.trim() : "";
      if (k === "error") { if (s !== "" && !/^none$/i.test(s)) valid = false; }
      else if (/^(valid|is_?valid|isvalid|phone_?valid)$/i.test(k) && (typeof v === "boolean" || /^(true|false)$/i.test(s))) { const b = v === true || /^true$/i.test(s); valid = b ? valid ?? true : false; }
      else if (/^(telephone_number_type|number_type|line_type|type)$/i.test(k) && s) { if (/invalid|not_?valid/i.test(s)) valid = false; else if (/^(mobile|landline|fixed|fixed_line|voip|toll_?free|premium|pager|personal|shared_cost|unknown|other)/i.test(s) && valid === null) valid = true; }
      else if (/^(detected_telephone_number|formatted_telephone_number|e164|international_format)$/i.test(k) && s && valid === null) valid = true;
      else if (/^country_iso3$/i.test(k) && s) addCountry(countryOfIso3(s));
      else if (/^(country_code|country_iso2|country_iso)$/i.test(k) && /^[A-Za-z]{2}$/.test(s)) addCountry(s.toUpperCase());
      else if (/^country_prefix$/i.test(k) && (s || typeof v === "number")) for (const c of countriesOfCallingDigits(String(v).replace(/\D/g, ""))) addCountry(c);
      else if (typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(page, 0);
  return { valid, countries };
}

/**
 * The status of a phone: «رقم من دولة أخرى» when the number's country (the validator's, else the calling code's) is known and is not the company's country (the company's country known); «موثّق» only when the validator says the number is valid; «غير موثّق» in every other case
 * (no validator answered, the answer did not say, it said invalid). A number is kept in every case.
 */
export function phoneStatusOf(input: { number: string; verdict: PhoneVerdict | null; companyCountry: string | null }): "verified" | "unverified" | "other_country" {
  const placed = input.verdict && input.verdict.countries.length > 0 ? input.verdict.countries : countriesOfNumber(input.number);
  if (input.companyCountry && placed.length > 0 && !placed.includes(input.companyCountry)) return "other_country";
  return input.verdict?.valid === true ? "verified" : "unverified";
}

export function phoneStatusAr(status: "verified" | "unverified" | "other_country"): string {
  return status === "verified" ? PHONE_STATUS_VERIFIED_AR : status === "other_country" ? PHONE_STATUS_OTHER_COUNTRY_AR : PHONE_STATUS_UNVERIFIED_AR;
}

// ------------------------------------------------------------------------------------------------ the company's phone
const PHONE_FIELD = /(^|_)(phone|tel|telephone|mobile|phone_?number|international_phone_number|formatted_phone_number|contact_number)$/i;

/** The company's own phone from its row (the mapped company data), when it carries one that has at least seven digits. */
export function companyPhoneOfRow(row: Record<string, unknown> | null | undefined): string | null {
  if (!row) return null;
  for (const [k, v] of Object.entries(row)) if (PHONE_FIELD.test(k)) { const t = text(v); if (t && verifyContactValue("phone", t)) return t; }
  return null;
}

const PLACE_NAME_KEYS = ["title", "name", "business_name", "place_name", "displayName"] as const;
const PLACE_SITE_KEYS = ["website", "url", "site", "domain", "web_url", "websiteUri"] as const;

/**
 * The phone of the place a map search found FOR THIS COMPANY: among the places of the answer, the first that carries a phone and is the company (its website's domain is the company's domain, or its name is the company's name). A place that is some other business is not the
 * company's phone, and an answer with no such place gives none.
 */
export function placePhoneIn(page: unknown, company: CompanyIdentity): string | null {
  const places: Array<Record<string, unknown>> = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > 5 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const x of node.slice(0, 20)) walk(x, depth + 1); return; }
    const o = node as Record<string, unknown>;
    if (Object.keys(o).some((k) => PHONE_FIELD.test(k) && text(o[k]) !== "")) places.push(o);
    for (const v of Object.values(o)) if (typeof v === "object") walk(v, depth + 1);
  };
  walk(page, 0);
  for (const p of places) {
    const phoneKey = Object.keys(p).find((k) => PHONE_FIELD.test(k) && text(p[k]) !== "");
    const phone = phoneKey ? text(p[phoneKey]) : "";
    if (!phone || !verifyContactValue("phone", phone)) continue;
    const site = PLACE_SITE_KEYS.map((k) => registrableDomain(text(p[k]))).find((d) => d !== null) ?? null;
    const name = PLACE_NAME_KEYS.map((k) => text(p[k])).find((n) => n !== "") ?? "";
    if ((site && company.domain && site === company.domain) || (name && company.names.some((n) => sameCompanyName(n, name)))) return phone;
  }
  return null;
}

/** The parameters of a map search helper for a company: the query (its name and city), and the country or location when the helper asks for one; null when the helper needs anything else. */
export function mapsParamsFor(helper: { inputs: ReadonlyArray<{ name: string; required: boolean }> }, company: { name: string; city: string | null; country: string | null }): Record<string, string> | null {
  const query = [company.name, company.city].filter(Boolean).join(" ").trim();
  if (!query) return null;
  const params: Record<string, string> = {};
  let usedQuery = false;
  for (const i of helper.inputs) {
    if (/^(q|query|keyword)$/i.test(i.name)) { params[i.name] = query; usedQuery = true; }
    else if (/^(country|gl)$/i.test(i.name)) { if (company.country) params[i.name] = company.country.toLowerCase(); }
    else if (/^location$/i.test(i.name)) { const where = [company.city, company.country].filter(Boolean).join(", "); if (where) params[i.name] = where; else if (i.required) return null; }
    else if (i.required) return null;
  }
  return usedQuery ? params : null;
}
