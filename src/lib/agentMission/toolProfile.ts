import type { CatalogEndpoint, CatalogInput } from "../treg/catalog";

/**
 * THE TOOL INPUT PROFILE (docs/REDESIGN.md section 3, S1 item 1.4). For one catalog endpoint: which condition classes its OWN inputs can express (date range or preset, language, country, account, count, sort, replies, cursor and the query
 * itself), with the exact field names, read from `inputs[]`, their `enum` and note, and `pagination`. Pure and catalog-driven: no I/O, no model. A field whose name matches no known class is listed in `unknown` and never used: nothing is guessed.
 * The profile is what the code-built request (toolInput.ts) writes the customer's conditions into, and what the ranking by coverage (sourceRanking.ts) and the gap statement on the plan card (plan gaps) read.
 */
export interface FieldRef {
  field: string;
  /** The allowed values when the input is an enumeration (from `enum`, else the quoted values of its note). */
  values?: string[];
  /** The field is an integer with this maximum (a page size). */
  maximum?: number;
}
export interface CountryRef extends FieldRef {
  /** False when the input's own note says it does not filter the results (it only places the request, as a proxy region does): the condition is then NOT enforced by the tool. */
  enforces: boolean;
}
export type DateFormat = "yyyy-MM-dd" | "iso" | "unix" | "unknown";
export interface DateProfile {
  /** The input that takes the first day of the range, and the one that takes the last. */
  from: string | null;
  to: string | null;
  /** A preset period input (an enumeration such as this-week, this-month). */
  preset: { field: string; values: string[] } | null;
  format: DateFormat;
}
export interface ToolProfile {
  endpointId: string;
  query: FieldRef | null;
  date: DateProfile | null;
  language: FieldRef | null;
  country: CountryRef | null;
  account: FieldRef | null;
  count: FieldRef | null;
  sort: FieldRef | null;
  replies: FieldRef | null;
  cursor: FieldRef | null;
  /** The query takes advanced-search operators (`since:`, `until:`, `lang:`, `from:`): the conditions can be written INTO the query. */
  queryOperators: boolean;
  /** Input names that match no known class. */
  unknown: string[];
}

const norm = (name: string): string => name.replace(/[_\-\s]/g, "").toLowerCase();

const RE = {
  query: /^(query|q|keyword|keywords|search|searchquery|searchterm|term|text)$/,
  from: /^(startdate|since|from|datefrom|starttime|publishedafter|after|fromdate|createdafter)$/,
  to: /^(enddate|until|to|dateto|endtime|publishedbefore|before|todate|createdbefore)$/,
  preset: /^(dateposted|period|timerange|timeframe|daterange|datefilter|publishedwithin|time)$/,
  language: /^(lang|language|hl|lr|locale|languagecode)$/,
  country: /^(country|region|gl|geo|countrycode|regioncode)$/,
  account: /^(username|user|handle|screenname|account|accountname|channelid|channel|channelurl|profile|profileurl|userid|authorid)$/,
  count: /^(limit|count|pagesize|perpage|size|num|maxresults|maxitems|n|numresults|resultsperpage)$/,
  sort: /^(sort|sortby|sortorder|order|orderby|querytype|ranking|sorting)$/,
  replies: /^(includereplies|excludereplies|replies|filterreplies|withreplies|includeretweets)$/,
};
/** The paging inputs, in the order a cursor is looked for when the endpoint's own `pagination` lists none. */
export const CURSOR_NAMES: ReadonlyArray<string> = ["cursor", "next_token", "pageToken", "pagination_token", "max_cursor", "next_max_id", "continuationToken"];

const refOf = (i: CatalogInput): FieldRef => {
  const values = valuesOf(i);
  return { field: i.name, ...(values ? { values } : {}), ...(typeof i.maximum === "number" ? { maximum: i.maximum } : {}) };
};

/** The allowed values: the declared enumeration, else the values the note names after «:» or between quotes («'Latest', 'Top'», «time (default) | relevance»). */
function valuesOf(i: CatalogInput): string[] | undefined {
  if (Array.isArray(i.enum) && i.enum.length > 0) return i.enum.map(String);
  const note = i.note ?? "";
  const quoted = [...note.matchAll(/'([^']{1,30})'/g)].map((m) => m[1]);
  if (quoted.length >= 2) return quoted;
  const piped = note.match(/^\s*([A-Za-z][\w-]*(?:\s*\([^)]*\))?(?:\s*\|\s*[A-Za-z][\w-]*(?:\s*\([^)]*\))?)+)\s*$/);
  if (piped) return piped[1].split("|").map((v) => v.replace(/\([^)]*\)/g, "").trim()).filter(Boolean);
  return undefined;
}

function formatOf(i: CatalogInput | undefined): DateFormat {
  if (!i) return "unknown";
  const hint = `${i.note ?? ""} ${String(i.example ?? "")}`;
  if (/yyyy-?MM-?dd/i.test(hint) || /^\d{4}-\d{2}-\d{2}$/.test(String(i.example ?? ""))) return "yyyy-MM-dd";
  if (/^(starttime|endtime)$/.test(norm(i.name)) || /rfc ?3339|iso ?8601|T\d{2}:\d{2}/.test(hint)) return "iso";
  if (/unix|epoch|timestamp/i.test(hint)) return "unix";
  return "unknown";
}

export function toolProfile(endpoint: CatalogEndpoint): ToolProfile {
  const inputs = endpoint.inputs ?? [];
  const find = (re: RegExp, accept: (i: CatalogInput) => boolean = () => true): CatalogInput | undefined => inputs.find((i) => re.test(norm(i.name)) && accept(i));
  const recognised = new Set<string>();
  const take = (i: CatalogInput | undefined): CatalogInput | undefined => { if (i) recognised.add(i.name); return i; };

  const query = take(find(RE.query));
  const from = take(find(RE.from));
  const to = take(find(RE.to));
  const presetInput = take(find(RE.preset, (i) => valuesOf(i) !== undefined));
  const language = take(find(RE.language));
  const country = take(find(RE.country));
  const account = take(find(RE.account));
  const count = take(find(RE.count, (i) => i.type === "integer" || i.type === "number" || i.type === null));
  const sort = take(find(RE.sort));
  const replies = take(find(RE.replies));

  // the cursor: the endpoint's own paging input first, else the first of the known paging names the inputs carry
  const declared = (endpoint.pagination ?? []).map((p) => inputs.find((i) => i.name === p)).find((i) => i && !RE.count.test(norm(i.name)));
  const byName = CURSOR_NAMES.map((n) => inputs.find((i) => i.name.toLowerCase() === n.toLowerCase())).find(Boolean);
  const cursor = take(declared ?? byName);

  const dateFormat = formatOf(from ?? to);
  const date: DateProfile | null = from || to || presetInput
    ? { from: from?.name ?? null, to: to?.name ?? null, preset: presetInput ? { field: presetInput.name, values: valuesOf(presetInput) ?? [] } : null, format: from || to ? dateFormat : "unknown" }
    : null;
  const queryNote = `${query?.note ?? ""} ${endpoint.summary ?? ""}`;
  const queryOperators = Boolean(query) && /advanced[- ]search|operators?\b|since:|until:|lang:/i.test(queryNote);
  const doesNotFilter = (i: CatalogInput | undefined): boolean => Boolean(i) && /does not filter|not filter|proxy|geo-?restr/i.test(i!.note ?? "");

  return {
    endpointId: endpoint.id,
    query: query ? refOf(query) : null,
    date,
    language: language ? refOf(language) : null,
    country: country ? { ...refOf(country), enforces: !doesNotFilter(country) } : null,
    account: account ? refOf(account) : null,
    count: count ? refOf(count) : null,
    sort: sort ? refOf(sort) : null,
    replies: replies ? refOf(replies) : null,
    cursor: cursor ? refOf(cursor) : null,
    queryOperators,
    unknown: inputs.map((i) => i.name).filter((n) => !recognised.has(n)).filter((n) => !isKnownOther(n)),
  };
}

/** Inputs that are known and carry no customer condition (they are not unknown, and not conditions): response trimming and the like. */
const isKnownOther = (name: string): boolean => /^(trim|part|textformat|format|fields|expansions)$/.test(norm(name));

/** The classes of customer condition a tool input can carry. `count` is the page size; it never counts as a gap (the delivery cap is code). */
export type ConditionClass = "date" | "language" | "country" | "account" | "count" | "sort" | "replies";
export const CONDITION_CLASSES: ReadonlyArray<ConditionClass> = ["date", "language", "country", "account", "count", "sort", "replies"];

/**
 * Can this tool EXPRESS the condition in its own inputs? A field of the right class, or (date, language, account, replies) the query's advanced-search operators (`since:`, `until:`, `lang:`, `from:`, `-filter:replies`). A country is only
 * expressed by a field that really filters (a region input that only places the request, as a proxy does, does not). A country is never written into a query.
 */
export function canExpress(profile: ToolProfile, cls: ConditionClass): boolean {
  switch (cls) {
    case "date": return profile.date !== null || profile.queryOperators;
    case "language": return profile.language !== null || profile.queryOperators;
    case "country": return profile.country !== null && profile.country.enforces;
    case "account": return profile.account !== null || profile.queryOperators;
    case "count": return profile.count !== null;
    case "sort": return profile.sort !== null;
    case "replies": return profile.replies !== null || profile.queryOperators;
  }
}
