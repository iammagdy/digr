/**
 * Read-only check of the PUBLIC site. GET requests only, no cookies, no keys, no paid or provider call, nothing is written anywhere.
 *
 *   npx tsx scripts/site-health.ts [base-url]        (default https://diger.tech)
 *
 * What it checks, and nothing more:
 *  1. each public page (/, /services, /pricing, /calculator, /contact, /login, /register) answers HTTP 200;
 *  2. its HTML has no provider, endpoint or model-vendor name, and its visible text and visible attributes carry none of the English UI strings of the banned list;
 *  3. /admin/* and /api/admin/* are not public: a request without a session gets a redirect, 401, 403 or 404, never a 200 page or data.
 * It does NOT prove the pages are correct, that sign-in or any paid flow works, or that a logged-in page is clean. The exit code is 1 when any check fails.
 */

export const PUBLIC_PAGES = ["/", "/services", "/pricing", "/calculator", "/contact", "/login", "/register"] as const;

/** Paths that must not be public (a GET with no session). Real routes of the app, so a 404 here is also a fine answer. */
export const PRIVATE_PATHS = ["/admin", "/admin/jobs", "/admin/finance", "/admin/operations", "/admin/audit", "/admin/export", "/api/admin/jobs", "/api/admin/finance", "/api/admin/providers", "/api/admin/provider-keys", "/api/admin/export", "/api/admin/receipts"] as const;

/** Names that must never appear anywhere in a public page's HTML (providers, endpoints, model vendors and models). */
export const BANNED_PROVIDER_WORDS = [
  "treg", "tikhub", "scrapecreators", "icypeas", "apify", "serpapi", "anyapi", "crawl4ai", "firecrawl", "context.dev",
  "openai", "anthropic", "claude", "haiku", "sonnet", "gemini", "veo", "sora", "kling", "hailuo", "seedance", "flux", "lyria", "elevenlabs", "midjourney",
];

/** English UI strings that must not be shown to an Arabic-only customer (visible text and visible attributes only). */
export const BANNED_ENGLISH_UI = [
  "Sign in", "Sign up", "Log in", "Login", "Logout", "Log out", "Register", "Loading", "Submit", "Cancel", "Dashboard", "Home", "Welcome", "Error", "Settings",
  "Search", "Continue", "Next", "Back", "Save", "Delete", "Password", "Forgot", "Contact us", "Pricing", "Services", "Calculator", "Download", "Upload",
  "Read more", "Learn more", "Get started", "undefined", "NaN", "null", "Lorem ipsum", "Coming soon", "Not found", "Internal Server Error",
];

const escapeRe = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The text a visitor can read or hear: tags, scripts, styles and the JSON the framework embeds are dropped; placeholder, aria-label, title and alt are kept. */
export function visibleTextOf(html: string): string {
  const attributes: string[] = [];
  html.replace(/\s(?:placeholder|aria-label|title|alt)="([^"]*)"/g, (_m, value: string) => { attributes.push(value); return ""; });
  const body = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<head\b[\s\S]*?<\/head>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  return `${body} ${attributes.join(" ")}`.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ");
}

export interface PageFinding { path: string; status: number; ok: boolean; problems: string[] }

/** The pure part of the page check (the tests run it on fixtures). */
export function checkPage(path: string, status: number, html: string): PageFinding {
  const problems: string[] = [];
  if (status !== 200) problems.push(`HTTP ${status} (expected 200)`);
  if (status === 200) {
    const lower = html.toLowerCase();
    for (const word of BANNED_PROVIDER_WORDS) {
      const index = lower.search(new RegExp(`(^|[^a-z0-9])${escapeRe(word)}([^a-z0-9]|$)`));
      if (index >= 0) problems.push(`provider or model word in the HTML: «${word}»`);
    }
    const text = visibleTextOf(html);
    for (const phrase of BANNED_ENGLISH_UI) {
      if (new RegExp(`(^|[^A-Za-z])${escapeRe(phrase)}([^A-Za-z]|$)`).test(text)) problems.push(`English UI string in the visible text: «${phrase}»`);
    }
    if (!/<html[^>]*\blang="ar"/i.test(html)) problems.push("the page is not marked as Arabic (lang=\"ar\")");
  }
  return { path, status, ok: problems.length === 0, problems };
}

export interface PrivateFinding { path: string; status: number; ok: boolean; problem?: string }

/** A request with no session must not be answered with a page or with data. Redirects (to the sign-in page), 401, 403 and 404 are fine. */
export function checkPrivate(path: string, status: number, location: string | null): PrivateFinding {
  if ([301, 302, 303, 307, 308].includes(status)) {
    const target = String(location || "");
    const toSignIn = /\/(?:login|auth|register)(?:[/?#]|$)/.test(target) || target === "/" || /^https?:\/\/[^/]+\/?$/.test(target);
    return toSignIn ? { path, status, ok: true } : { path, status, ok: false, problem: `redirects to an unexpected place: ${target || "(none)"}` };
  }
  if ([401, 403, 404].includes(status)) return { path, status, ok: true };
  return { path, status, ok: false, problem: `answered HTTP ${status} to a request with no session` };
}

async function get(url: string): Promise<{ status: number; html: string; location: string | null }> {
  const response = await fetch(url, { method: "GET", redirect: "manual", headers: { "user-agent": "diger-site-health/1 (read-only GET)", accept: "text/html,application/json;q=0.9,*/*;q=0.5" } });
  const location = response.headers.get("location");
  const html = response.status === 200 ? await response.text() : "";
  return { status: response.status, html, location };
}

export async function runSiteHealth(base: string): Promise<{ pages: PageFinding[]; privates: PrivateFinding[]; ok: boolean }> {
  const root = base.replace(/\/+$/, "");
  const pages: PageFinding[] = [];
  for (const path of PUBLIC_PAGES) {
    try {
      const { status, html } = await get(`${root}${path}`);
      pages.push(checkPage(path, status, html));
    } catch (error) {
      pages.push({ path, status: 0, ok: false, problems: [`request failed: ${(error as Error).message}`] });
    }
  }
  const privates: PrivateFinding[] = [];
  for (const path of PRIVATE_PATHS) {
    try {
      const { status, location } = await get(`${root}${path}`);
      privates.push(checkPrivate(path, status, location));
    } catch (error) {
      privates.push({ path, status: 0, ok: false, problem: `request failed: ${(error as Error).message}` });
    }
  }
  return { pages, privates, ok: pages.every((page) => page.ok) && privates.every((entry) => entry.ok) };
}

if (require.main === module) {
  const base = process.argv[2] || "https://diger.tech";
  runSiteHealth(base).then((result) => {
    console.log(`Site health (read-only GET) for ${base}`);
    for (const page of result.pages) console.log(`${page.ok ? "OK  " : "FAIL"} ${page.path}  HTTP ${page.status}${page.problems.length ? `\n       ${page.problems.join("\n       ")}` : ""}`);
    for (const entry of result.privates) console.log(`${entry.ok ? "OK  " : "FAIL"} ${entry.path}  HTTP ${entry.status}${entry.problem ? `  ${entry.problem}` : ""}`);
    console.log(result.ok ? "All the checks above passed. That is all this script checks." : "At least one check failed (see above).");
    process.exit(result.ok ? 0 : 1);
  });
}
