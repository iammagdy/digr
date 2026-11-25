import { describe, expect, it } from "vitest";
import { PROVIDER_LABELS, withoutProviderHosts } from "../src/lib/agentMission/providerLabels";

const HISTORICAL_PROVIDER_LABELS: readonly string[] = [
  "adyntel", "aiark", "akta", "anyapi", "apify", "aviato", "blitzapi", "bounceban", "branddev", "brightdata",
  "cloro", "coingecko", "companyenrich", "contactout", "context", "contextdev", "coresignal", "crawl4ai",
  "crunchbase", "crustdata", "dataforseo", "diffbot", "dropleads", "enrichlayer", "eodhd", "fetchinio",
  "fiber-ai", "financialdatasets", "findymail", "finnhub", "firecrawl", "fishaudio", "getleadsio", "google-ai",
  "google-search-console", "harvestapi", "hlrlookup", "hunter", "icypeas", "influencersclub", "justoneapi",
  "keenable", "leadmagic", "leadsforge", "limadata", "linkup", "litescrape", "lusha", "majestic", "marketstack",
  "meta-ad-library", "millionverifier", "minimax", "moltsets", "oceanio", "octen", "olostep", "openmart",
  "openrouter", "parallel", "perplexity", "piapi", "polygon", "predictleads", "prospeo", "quickenrich", "reapi",
  "replicate", "scrapecreators", "scrapegraphai", "scrubby", "search1api", "semrush", "seranking", "serpapi",
  "serper", "serpstat", "sixtyfour", "spidercloud", "spyfu", "sumble", "tavily", "thecompaniesapi", "tiingo",
  "tikhub", "tinyfish", "tomba", "treg", "trestleiq", "trykitt", "twelvedata", "valyu", "village", "wiza", "zerobounce",
];

describe("Provider labels parity and withoutProviderHosts stripping", () => {
  it("covers 100% of historical provider labels without any missing", () => {
    const set = new Set(PROVIDER_LABELS);
    const missing = HISTORICAL_PROVIDER_LABELS.filter((p) => !set.has(p));
    expect(missing).toEqual([]);
    expect(PROVIDER_LABELS.length).toBeGreaterThanOrEqual(HISTORICAL_PROVIDER_LABELS.length);
  });

  it("strips provider URLs and bare domains for all historical providers", () => {
    for (const p of HISTORICAL_PROVIDER_LABELS) {
      const url = `https://api.${p}.com/v1/data`;
      expect(withoutProviderHosts(url)).toBe("");

      const text = `انظر الرابط https://${p}.io/test للتفاصيل`;
      expect(withoutProviderHosts(text)).toBe("انظر الرابط للتفاصيل");

      const bare = `بيانات من api.${p}.org/v2 هنا`;
      expect(withoutProviderHosts(bare)).toBe("بيانات من هنا");
    }
  });

  it("preserves non-provider domains and social platform links", () => {
    const keepLinks = [
      "https://www.tiktok.com/@user/video/123",
      "https://www.instagram.com/p/abc123xyz/",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.linkedin.com/company/example-corp/",
      "https://example.org/about",
      "https://company.co/careers",
    ];
    for (const link of keepLinks) {
      expect(withoutProviderHosts(link)).toBe(link);
    }
  });
});
