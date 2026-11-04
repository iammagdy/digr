/**
 * THE DATA PROVIDERS' HOST LABELS, as a plain list (round 32). The customer's CSV is written on the server of the site, where the 10 MB catalog that `providerContext()` is built from is NOT shipped, so the CSV takes its last look from this list.
 * It is the same set: `tests/round32-customer-csv.test.ts` fails when a provider of the catalog is missing from it (a new seller is added here, in the same change as the catalog). An address whose host has one of these labels is taken out of a cell,
 * the words around it stay; every other address (the platforms' own links, a company's website) is untouched.
 */
export const PROVIDER_LABELS: readonly string[] = ["adyntel", "aiark", "akta", "anyapi", "apify", "aviato", "blitzapi", "bounceban", "branddev", "brightdata", "cloro", "coingecko", "companyenrich", "contactout", "context", "contextdev", "coresignal", "crawl4ai", "crunchbase", "crustdata", "dataforseo", "diffbot", "dropleads", "enrichlayer", "eodhd", "fetchinio", "fiber-ai", "financialdatasets", "findymail", "finnhub", "firecrawl", "fishaudio", "getleadsio", "google-ai", "google-search-console", "harvestapi", "hlrlookup", "hunter", "icypeas", "influencersclub", "justoneapi", "keenable", "leadmagic", "leadsforge", "limadata", "linkup", "litescrape", "lusha", "majestic", "marketstack", "meta-ad-library", "millionverifier", "minimax", "moltsets", "oceanio", "octen", "olostep", "openmart", "openrouter", "parallel", "perplexity", "piapi", "polygon", "predictleads", "prospeo", "quickenrich", "reapi", "replicate", "scrapecreators", "scrapegraphai", "scrubby", "search1api", "semrush", "seranking", "serpapi", "serper", "serpstat", "sixtyfour", "spidercloud", "spyfu", "sumble", "tavily", "thecompaniesapi", "tiingo", "tikhub", "tinyfish", "tomba", "treg", "trestleiq", "trykitt", "twelvedata", "valyu", "village", "wiza", "zerobounce"];

const LABELS = new Set<string>(PROVIDER_LABELS);
const URL_IN_TEXT = /https?:\/\/[^\s"'<>)\]،]+/gi;
const BARE_DOMAIN_IN_TEXT = /(?<![\w@./-])(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s"'<>)\]،]*)?/gi;

function isProviderAddress(address: string): boolean {
  const t = address.replace(/[.,;:!?]+$/, "");
  let host = "";
  try { host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`).hostname.toLowerCase(); } catch { return false; }
  return host.split(".").filter(Boolean).slice(0, -1).some((l) => LABELS.has(l));
}

/** The text with every address of a data provider taken out (the address itself, not the words around it); the same text when there is none. */
export function withoutProviderHosts(text: string): string {
  if (!text) return text;
  const out = text.replace(URL_IN_TEXT, (m) => (isProviderAddress(m) ? "" : m)).replace(BARE_DOMAIN_IN_TEXT, (m) => (isProviderAddress(m) ? "" : m));
  return out === text ? text : out.replace(/[ \t]{2,}/g, " ").trim();
}
