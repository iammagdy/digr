import { companyMailboxIn, foundContactIn } from "../contactFinders";

/**
 * STAGE 3, THE B2B TOOL CARDS (docs/STAGE-3.md; the same idea as the social cards of `foundation/toolCards`, in a NEW type). One data record per companies / people / contact tool of the
 * TREG catalog: its role, which conditions of the B2B Ask its inputs can carry, where its list and next page are, and where each column's value is in an item (or which shared reader of
 * `contactFinders.ts` reads a lookup's one answer). A card is VERIFIED only when a stored real page in the repo maps with it (`checkB2BCardOnPage`), listed in `verifiedOn`.
 *
 * S1 (Sonnet session): the first real B2B pages are in the repo (tests/fixtures/live/missions/msn_4969a50fed8c45b37d8f and msn_7539ea17512cf58aa0e7, anonymised). SIX cards are verified on
 * them: the companies search, the people of a company (two tools), the maps search for a company's phone, and the e-mail and phone finders. A stored page does not name its tool: each page was
 * attributed to its tool by SHAPE (its top-level keys equal that endpoint's catalog example and no other endpoint has them; the maps pages by their item fields), and
 * tests/stage3-b2b-real-pages.test.ts re-derives `verifiedOn` from the pages and fails if it differs. The other cards have no stored page and stay «unverified»: `b2bCardsFor` never returns
 * one to a customer path. Guesses still standing are marked GUESS in a card's `note`. Pure data plus two pure readers.
 */
export type B2BRole = "companies.search" | "company.people" | "people.search" | "person.email" | "person.phone" | "company.emails" | "company.phone";
export type B2BCardStatus = "verified" | "unverified" | "broken";
/** The conditions of the B2B Ask an input of the tool can carry. */
export type B2BCarry = "sector" | "country" | "size" | "founded" | "title";
export type B2BField = "id" | "name" | "website" | "domain" | "activity" | "hq" | "hq_phone" | "general_email" | "employees" | "founded" | "linkedin" | "person_name" | "title" | "company" | "email" | "mobile";
export type FieldSpec = ReadonlyArray<string> | { join: ReadonlyArray<ReadonlyArray<string>> };
export type B2BReader =
  | { kind: "list"; fields: Partial<Record<B2BField, FieldSpec>> }
  /** A finder's one answer, read by `foundContactIn` (any provider's shape). */
  | { kind: "found_email" }
  | { kind: "found_phone" }
  /** A mailbox lister's answer, read by `companyMailboxIn` (the company's role mailbox: info@, contact@ ...). */
  | { kind: "company_mailbox" };

export interface B2BCard {
  endpointId: string;
  role: B2BRole;
  status: B2BCardStatus;
  carries: ReadonlyArray<B2BCarry>;
  /** What the tool needs from a row (a lookup): the company's domain or LinkedIn link, the person's name or LinkedIn link. */
  needs: ReadonlyArray<"domain" | "company_linkedin" | "person_name" | "person_linkedin" | "company_name">;
  page: { list: ReadonlyArray<string> | null; cursor: ReadonlyArray<string> | null };
  reader: B2BReader;
  /** The catalog's price (USD) and its unit. */
  costUsd: number;
  costUnit: "call" | "result" | "record" | "row";
  /** The stored real pages the card was verified on (tests/fixtures/live). Empty: unverified. */
  verifiedOn: ReadonlyArray<{ mission: string; calls: ReadonlyArray<string> }>;
  /** Why the card is not verified, and what is a guess. */
  note: string;
}

const NO_PAGE = "No stored real page of this tool is in the repo.";
const U = (c: Omit<B2BCard, "status" | "verifiedOn">): B2BCard => ({ ...c, status: "unverified", verifiedOn: [] });
/** A VERIFIED card: the stored pages it maps on are `verifiedOn` (tests/stage3-b2b-real-pages.test.ts derives the same list from the stored pages). */
const V = (c: Omit<B2BCard, "status">): B2BCard => ({ ...c, status: "verified" });
const M_A = "msn_4969a50fed8c45b37d8f";
const M_B = "msn_7539ea17512cf58aa0e7";
const calls = (...n: number[]): string[] => n.map((x) => `call_${String(x).padStart(4, "0")}`);
const BY_SHAPE = "Attributed to this tool by the page's shape (its top-level keys are this endpoint's catalog example, and no other endpoint has them).";

export const B2B_CARDS: ReadonlyArray<B2BCard> = [
  // ---------------------------------------------------------------------------------------------- companies
  U({ endpointId: "icypeas.companies.search", role: "companies.search", carries: ["sector", "country"], needs: [], page: { list: ["leads"], cursor: null }, costUsd: 0.00038, costUnit: "result",
    reader: { kind: "list", fields: { id: ["_id"], name: ["name"], website: ["website"], activity: ["industry"], hq: ["address"], hq_phone: ["phone"], employees: ["numberOfEmployees"], founded: ["foundedYear"], linkedin: ["url"] } },
    note: `${NO_PAGE} The free-text query carries the sector and the country words.` }),
  V({ endpointId: "tomba.companies.search.reveal", role: "companies.search", carries: ["sector", "country"], needs: [], page: { list: ["data", "companies"], cursor: null }, costUsd: 0.000178, costUnit: "row",
    reader: { kind: "list", fields: { id: ["website_url"], name: ["name"], website: ["website_url"], activity: ["industry"], hq: ["city"], employees: ["company_size"], founded: ["founded"], linkedin: ["linkedin_url"] } },
    verifiedOn: [{ mission: M_A, calls: calls(1, 7) }, { mission: M_B, calls: calls(1, 4) }],
    note: `${BY_SHAPE} Verified on 4 real pages of 50 companies. The live calls carried a country and an industry filter (the page echoes \`meta.filters\`); no size filter was ever seen, so size is NOT claimed (a size condition becomes a mark column). \`phone_number\` is the boolean «false» on all 200 stored companies (a flag, never a number), so this tool gives NO HQ phone and the card does not map it. \`company_size\` and \`founded\` are text.` }),
  U({ endpointId: "blitzapi.companies.search", role: "companies.search", carries: ["sector", "country", "size"], needs: [], page: { list: ["results"], cursor: null }, costUsd: 0.000495, costUnit: "record",
    reader: { kind: "list", fields: { id: ["linkedin_url"], name: ["name"], website: ["website"], domain: ["domain"], activity: ["industry"], hq: ["hq"], employees: ["size"], founded: ["founded_year"], linkedin: ["linkedin_url"] } },
    note: `${NO_PAGE} GUESS: the «company» input object carries industry, country and size.` }),
  U({ endpointId: "aviato.companies.search", role: "companies.search", carries: ["sector", "country"], needs: [], page: { list: ["items"], cursor: null }, costUsd: 0.0025, costUnit: "call",
    reader: { kind: "list", fields: { id: ["id"], name: ["name"], activity: ["industryList"], hq: ["locality"] } },
    note: `${NO_PAGE} The «dsl» query may carry more (size, founding year): not counted until a stored page shows it. No website or phone field in the catalog's item fields.` }),
  // ---------------------------------------------------------------------------------------------- the people of a company
  V({ endpointId: "aviato.companies.employees", role: "company.people", carries: [], needs: ["domain"], page: { list: ["employees"], cursor: null }, costUsd: 0.005, costUnit: "call",
    reader: { kind: "list", fields: { id: ["personID"], person_name: ["person", "fullName"], title: ["positionList", "0", "title"], company: ["companyName"] } },
    verifiedOn: [{ mission: M_A, calls: calls(3) }, { mission: M_B, calls: calls(3, 7, 8, 9, 10) }],
    note: `${BY_SHAPE} Verified on 6 real pages (5 to 10 people each): the paths person.fullName and positionList[0].title were right.` }),
  V({ endpointId: "blitzapi.people.employee-finder", role: "company.people", carries: ["country", "title"], needs: ["company_linkedin"], page: { list: ["results"], cursor: null }, costUsd: 0.000495, costUnit: "record",
    reader: { kind: "list", fields: { id: ["linkedin_url"], person_name: ["full_name"], title: ["headline"], linkedin: ["linkedin_url"] } },
    verifiedOn: [{ mission: M_A, calls: calls(6, 8, 9, 10, 11, 12, 13, 14) }],
    note: `${BY_SHAPE} Verified on 8 real pages (the page echoes the company link and \`max_results\` it was asked with); some answers are empty (no result), which is not an issue. The job level and country inputs carry the title and the country.` }),
  // ---------------------------------------------------------------------------------------------- people with no company named
  U({ endpointId: "icypeas.people.search", role: "people.search", carries: ["title", "country", "sector"], needs: [], page: { list: ["leads"], cursor: null }, costUsd: 0.00038, costUnit: "result",
    reader: { kind: "list", fields: { id: ["profileUrl"], person_name: { join: [["firstname"], ["lastname"]] }, title: ["lastJobTitle"], company: ["lastCompanyName"], website: ["lastCompanyWebsite"], linkedin: ["profileUrl"] } },
    note: NO_PAGE }),
  U({ endpointId: "treg.people.search", role: "people.search", carries: ["title", "country"], needs: [], page: { list: null, cursor: null }, costUsd: 0, costUnit: "call",
    reader: { kind: "list", fields: {} },
    note: `${NO_PAGE} The catalog has no example answer: the list path and the fields are unknown.` }),
  // ---------------------------------------------------------------------------------------------- a person's e-mail and mobile (lookups)
  V({ endpointId: "blitzapi.people.email.find", role: "person.email", carries: [], needs: ["person_linkedin"], page: { list: null, cursor: null }, costUsd: 0.000495, costUnit: "record", reader: { kind: "found_email" },
    verifiedOn: [{ mission: M_A, calls: calls(15, 17, 19, 20, 21, 22, 23, 24, 25, 26) }, { mission: M_B, calls: calls(11, 19, 26, 32, 38, 43, 47, 51) }],
    note: `${BY_SHAPE} Verified on 18 real answers: 4 found (one or two addresses) and 14 not found (\`found: false\`, \`email: null\`). The stored values are placeholders, so the value path is tested by putting a fake value at the page's own key. It takes the person's profile link.` }),
  V({ endpointId: "blitzapi.people.phone.find", role: "person.phone", carries: [], needs: ["person_linkedin"], page: { list: null, cursor: null }, costUsd: 0.000495, costUnit: "record", reader: { kind: "found_phone" },
    verifiedOn: [{ mission: M_A, calls: calls(27, 28, 29, 30, 31, 32, 33, 34, 35, 36) }, { mission: M_B, calls: calls(14, 21, 28, 34, 40, 45, 49, 53) }],
    note: `${BY_SHAPE} Verified on 18 real answers: 2 found and 16 not found. The stored values are placeholders, so the value path is tested by putting a fake value at the page's own key. It takes the person's profile link.` }),
  U({ endpointId: "treg.people.email.find", role: "person.email", carries: [], needs: ["domain", "person_name"], page: { list: null, cursor: null }, costUsd: 0.000495, costUnit: "call", reader: { kind: "found_email" }, note: NO_PAGE }),
  U({ endpointId: "tomba.people.email.find", role: "person.email", carries: [], needs: ["domain", "person_name"], page: { list: null, cursor: null }, costUsd: 0.0089, costUnit: "call", reader: { kind: "found_email" }, note: NO_PAGE }),
  U({ endpointId: "hunter.people.email.find", role: "person.email", carries: [], needs: ["domain", "person_name"], page: { list: null, cursor: null }, costUsd: 0.0245, costUnit: "call", reader: { kind: "found_email" }, note: NO_PAGE }),
  U({ endpointId: "treg.people.phone.find", role: "person.phone", carries: [], needs: ["person_linkedin"], page: { list: null, cursor: null }, costUsd: 0.000495, costUnit: "call", reader: { kind: "found_phone" }, note: NO_PAGE }),
  U({ endpointId: "aiark.people.phone.find", role: "person.phone", carries: [], needs: ["person_linkedin"], page: { list: null, cursor: null }, costUsd: 0.026335, costUnit: "call", reader: { kind: "found_phone" }, note: NO_PAGE }),
  U({ endpointId: "tomba.people.phone.find", role: "person.phone", carries: [], needs: ["person_linkedin"], page: { list: null, cursor: null }, costUsd: 0.0445, costUnit: "call", reader: { kind: "found_phone" }, note: NO_PAGE }),
  // ---------------------------------------------------------------------------------------------- the company's general e-mail and HQ phone (lookups)
  U({ endpointId: "tomba.companies.emails.list", role: "company.emails", carries: [], needs: ["domain"], page: { list: null, cursor: null }, costUsd: 0.0089, costUnit: "call", reader: { kind: "company_mailbox" }, note: NO_PAGE }),
  V({ endpointId: "crawl4ai.google.serp.maps", role: "company.phone", carries: ["country"], needs: ["company_name"], page: { list: ["rows"], cursor: null }, costUsd: 0.00015, costUnit: "call",
    reader: { kind: "list", fields: { id: ["place_id"], name: ["name"], hq_phone: ["phone"], website: ["website"], hq: ["address"] } },
    verifiedOn: [{ mission: M_B, calls: calls(17, 24, 30, 36) }],
    note: "Attributed to this tool by the page's item fields (they equal this endpoint's 15 catalog fields; the wrapper keys are shared with 84 endpoints). Verified on 4 real pages of one place each; the phone is text." }),
  U({ endpointId: "anyapi.google.serp.maps", role: "company.phone", carries: ["country"], needs: ["company_name"], page: { list: ["output", "data", "items"], cursor: null }, costUsd: 0.00175, costUnit: "call",
    reader: { kind: "list", fields: { id: ["placeId"], name: ["name"], hq_phone: ["phone"], website: ["website"], hq: ["address"] } }, note: NO_PAGE }),
];

/** The cards no stored real page verifies (docs/STAGE-3.md lists them): never offered to a customer. */
export const UNVERIFIED_B2B_CARDS: ReadonlyArray<string> = B2B_CARDS.filter((c) => c.status === "unverified").map((c) => c.endpointId);

/**
 * The cards a role may use: every VERIFIED card before any unverified one (Part A.4: a verified card always ranks above an unverified one for the same need), then cheapest first. A customer path
 * gets VERIFIED cards only. `allowUnverified` exists for tests and for a later owner decision (test accounts, like decision 7.4 of the social cards). A broken card is never returned.
 */
export function b2bCardsFor(role: B2BRole, options: { allowUnverified?: boolean; cards?: ReadonlyArray<B2BCard> } = {}): B2BCard[] {
  const rank = (c: B2BCard): number => (c.status === "verified" ? 0 : 1);
  return (options.cards ?? B2B_CARDS)
    .filter((c) => c.role === role && (c.status === "verified" || (c.status === "unverified" && options.allowUnverified === true)))
    .sort((a, b) => rank(a) - rank(b) || a.costUsd - b.costUsd || (a.endpointId < b.endpointId ? -1 : 1));
}

const at = (o: unknown, path: ReadonlyArray<string>): unknown => {
  let v: unknown = o;
  for (const k of path) { if (v === null || v === undefined || typeof v !== "object") return undefined; v = (v as Record<string, unknown>)[k]; }
  return v;
};
const valueOf = (item: unknown, spec: FieldSpec): unknown => {
  if (Array.isArray(spec)) return at(item, spec as ReadonlyArray<string>);
  const parts = (spec as { join: ReadonlyArray<ReadonlyArray<string>> }).join.map((p) => at(item, p)).filter((v) => typeof v === "string" && v.trim() !== "").map((v) => String(v).trim());
  return parts.length > 0 ? parts.join(" ") : undefined;
};
const idText = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "");

/** The rows a page gives by the card: the listed items mapped by its fields, or a lookup's one answer (`id: "answer"`). `domain` is the company's, for a mailbox lister. */
export function readB2BRows(card: B2BCard, page: unknown, ctx: { domain?: string | null } = {}): Array<Record<string, unknown>> {
  switch (card.reader.kind) {
    case "found_email": { const f = foundContactIn("email", page); return f ? [{ id: "answer", email: f.value, email_status: f.status }] : []; }
    case "found_phone": { const f = foundContactIn("phone", page); return f ? [{ id: "answer", mobile: f.value, mobile_status: f.status }] : []; }
    case "company_mailbox": { const m = companyMailboxIn(page, ctx.domain ?? null); return m ? [{ id: "answer", general_email: m }] : []; }
    case "list": {
      const list = card.page.list ? at(page, card.page.list) : undefined;
      if (!Array.isArray(list)) return [];
      const fields = card.reader.fields;
      return list.map((item) => {
        const row: Record<string, unknown> = {};
        for (const [k, spec] of Object.entries(fields) as Array<[B2BField, FieldSpec]>) { const v = valueOf(item, spec); if (v !== undefined && v !== null && v !== "") row[k] = v; }
        row.id = idText(row.id);
        return row;
      });
    }
  }
}

const CONTACT_FIELDS: ReadonlyArray<B2BField> = ["hq_phone", "general_email", "email", "mobile"];
export interface B2BCardCheck { rows: Array<Record<string, unknown>>; issues: string[] }
/** A list card checked on a page: the list is where the card says, one row per item, every row with an id. The issues name the rule, never a value of the page. */
export function checkB2BCardOnPage(card: B2BCard, page: unknown): B2BCardCheck {
  const issues: string[] = [];
  if (card.reader.kind !== "list") return { rows: readB2BRows(card, page), issues };
  const list = card.page.list ? at(page, card.page.list) : undefined;
  if (!Array.isArray(list)) return { rows: [], issues: ["no list at the card's path"] };
  const rows = readB2BRows(card, page);
  if (rows.length !== list.length) issues.push(`${rows.length} rows mapped from ${list.length} listed items`);
  if (rows.some((r) => typeof r.id !== "string" || r.id === "")) issues.push("a row without an id");
  // a contact column holds TEXT: the first real page showed a boolean «phone_number» flag mapped as the HQ phone (the card now leaves it out)
  if (rows.some((r) => CONTACT_FIELDS.some((f) => f in r && typeof r[f] !== "string"))) issues.push("a contact field holds a non-text value");
  return { rows, issues };
}
