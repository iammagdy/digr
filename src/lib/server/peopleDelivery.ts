import { detectCountryFromText } from "../planParameters";
import { industryLabelAr } from "../industryLabels";
import { localizeCityName } from "./addressParser";

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/**
 * A person as the customer receives it, in the shared people columns (`src/lib/peopleColumns.ts`): the person's name and title, the employer
 * (name, country, city, website, industry, description), the work email and the office phone each with its status, and the professional profile link.
 *
 * Built from the source's row: the person's OWN free text (a profile description, a headline, a job description) is never a column, and the
 * `description` column is the COMPANY's (the source's raw `description` is the person's biography). The keys the settlement reads
 * (`work_email`, `phone` and their statuses) keep their values untouched.
 */
export function peopleDeliveryRow(row: Record<string, any>): Record<string, any> {
  const first = (...values: unknown[]): string => values.map(text).find(Boolean) || "";
  const where = [text(row.country), text(row.location), text(row.address), text(row.company_address)].filter(Boolean);
  const country = where.map((place) => detectCountryFromText(place)?.arabicLabel).find(Boolean) || "";
  const cityRaw = first(row.city, row.location, row.address, row.company_address);
  const city = cityRaw ? localizeCityName(cityRaw, country || undefined) : "";
  return {
    contact_name: first(row.contact_name, row.full_name, row.fullName, row.name),
    job_title: first(row.job_title, row.jobTitle, row.title, row.currentJobTitle),
    company_name: first(row.company_name, row.companyName, row.company),
    country,
    // a place that is only the country (the source's «مصر» for a person with no city) is not a city
    city: city === "غير متاح" || city === country ? "" : city,
    work_email: first(row.work_email, row.workEmail, row.email),
    work_email_verification_status: row.work_email_verification_status ?? row.email_verification_status ?? "",
    phone: first(row.phone, row.phone_number, row.business_phone, row.work_phone),
    phone_verification_status: row.phone_verification_status ?? "",
    linkedin_url: first(row.linkedin_url, row.linkedin, row.profile_url),
    website: first(row.website),
    industry: industryLabelAr(row.industry) || "",
    // The source's own `description` is the person's biography; a row already in the shared columns carries the company's in `description`.
    description: row.people_source !== undefined || row.industry_description !== undefined ? text(row.industry_description) : text(row.description),
  };
}
