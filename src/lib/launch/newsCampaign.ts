import { resolveDisplayName } from "../server/sendPlatformEmail";

/**
 * The consent-based launch announcement: WHO may receive it and the guarded runner. Nothing here talks to a network: every dependency (the user
 * listing, the re-read, the mark, the sender, the clock, the log) is injected, so the tests use fakes and the production wiring lives in
 * src/lib/launch/newsCampaignWiring.ts and src/app/api/admin/launch-email/route.ts.
 *
 * Principles (docs/launch/LAUNCH-EMAIL-AR.md §4-§6):
 *  - the ONLY consent is `user_metadata.prefs.notif.news === true` (the customer's own opt-in). A registered account is not an opt-in; a Resend contact is not consent.
 *  - the address must be confirmed by the sign-in SERVICE (`email_confirmed_at`), never by `user_metadata.email_verified` (the customer can write that).
 *  - a dry run (the default) touches nothing; a real send needs `dryRun === false` AND the exact confirmation text.
 *  - per recipient: re-read, re-check, CLAIM the mark, THEN send (a crash under-sends, never double-sends); a definite failure removes the claim.
 *  - results and logs hold counts and user ids only: never an address or a body.
 */

/** No run may send more than this, whatever the caller asks. */
export const LAUNCH_HARD_CAP = 500;
export const NEWS_PAGE_SIZE = 200;
const MAX_PAGES = 5000;
const MAX_CONSECUTIVE_FAILURES = 2;
/** Wall-clock budget of one real run. The admin route's maxDuration is 60 s; this leaves room for the last re-read, claim, send (7 s timeout) and audit. */
export const LAUNCH_TIME_BUDGET_MS = 45_000;

export interface NewsUser {
  id: string;
  email?: string | null;
  email_confirmed_at?: string | null;
  user_metadata?: Record<string, any> | null;
  app_metadata?: Record<string, any> | null;
  /** ISO time until which the sign-in service bars the account; in the future = banned. */
  banned_until?: string | null;
}

export type SkipReason =
  | "guest"
  | "unconfirmed"
  | "banned"
  | "invalid_address"
  | "not_opted_in"
  | "test_account"
  | "suppressed"
  | "not_selected"
  | "already_sent"
  | "unreadable"
  | "claim_failed";

export interface EligibilityContext {
  /** Ids of test accounts (never mailed). */
  testAccountIds?: ReadonlySet<string>;
  /** Extra classifier for test accounts that are known by address (the admin route passes the shared test-account rule). */
  isTestAccount?: (user: NewsUser) => boolean;
  /** Lower-case addresses that must never be mailed (bounced, complained, suppressed). */
  suppressed?: ReadonlySet<string>;
  /** A bounded test send: when given, ONLY these user ids may be mailed (every other check still applies). */
  onlyUserIds?: ReadonlySet<string>;
  /** Clock for the ban check (default Date.now). */
  now?: () => number;
}

const GUEST_ADDRESS = /^guest_[0-9a-f]{32}@diger\.tech$/i;
const ADDRESS = /^[^\s@<>"',;()]+@[^\s@<>"',;()]+\.[^\s@<>"',;()]+$/;

/** A guest session account: marked in its metadata or recognisable by its generated address. (Local rule: the shared guest helper is not on this base.) */
export function isGuestAccount(user: NewsUser): boolean {
  if (user.user_metadata?.is_guest === true) return true;
  return GUEST_ADDRESS.test(String(user.email ?? "").trim());
}

export function isValidNewsAddress(email: unknown): boolean {
  if (typeof email !== "string") return false;
  const e = email.trim();
  return e.length > 0 && e.length <= 254 && ADDRESS.test(e);
}

/** The first reason this user must NOT get the announcement, or null when they may. Pure. */
export function newsSkipReason(user: NewsUser, ctx: EligibilityContext = {}): SkipReason | null {
  if (!user || typeof user.id !== "string" || !user.id) return "unreadable";
  if (ctx.onlyUserIds && !ctx.onlyUserIds.has(user.id)) return "not_selected";
  if (isGuestAccount(user)) return "guest";
  // the sign-in service's own confirmation time; `user_metadata.email_verified` is customer-writable and proves nothing
  if (!user.email_confirmed_at) return "unconfirmed";
  // a barred account is not mailed; an unreadable ban time counts as barred (fail closed)
  if (user.banned_until) {
    const until = Date.parse(user.banned_until);
    if (Number.isNaN(until) || until > (ctx.now ?? Date.now)()) return "banned";
  }
  if (!isValidNewsAddress(user.email)) return "invalid_address";
  if (user.user_metadata?.prefs?.notif?.news !== true) return "not_opted_in";
  if (ctx.testAccountIds?.has(user.id) || ctx.isTestAccount?.(user)) return "test_account";
  if (ctx.suppressed?.has(String(user.email).trim().toLowerCase())) return "suppressed";
  return null;
}

export function isEligibleForNews(user: NewsUser, ctx: EligibilityContext = {}): boolean {
  return newsSkipReason(user, ctx) === null;
}

/** Batch sizes for n recipients in batches of at most `size` (default 500): planBatches(1200) = [500, 500, 200]. */
export function planBatches(n: number, size: number = LAUNCH_HARD_CAP): number[] {
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(size) || size < 1) return [];
  const total = Math.floor(n);
  const step = Math.floor(size);
  const out: number[] = [];
  for (let left = total; left > 0; left -= step) out.push(Math.min(step, left));
  return out;
}

/** Whether the service-owned mark `app_metadata.campaigns[campaign]` is set. (app_metadata cannot be written by the customer.) */
export function isCampaignMarked(user: NewsUser, campaign: string): boolean {
  return Boolean(user.app_metadata?.campaigns?.[campaign]);
}

export interface SendOutcome { ok: boolean; reason?: string }

export interface NewsCampaignDeps {
  /** One page of users (1-based); an empty page ends the listing. */
  listUsers: (page: number) => Promise<NewsUser[]>;
  /** Fresh read of one user right before sending; null when unreadable. */
  getUserById: (id: string) => Promise<NewsUser | null>;
  /** Whether the user already carries the campaign mark. */
  isSent: (user: NewsUser, campaign: string) => boolean;
  /** CLAIM the mark (service-owned app_metadata). false = the mark could not be taken: nothing is sent. */
  markSent: (userId: string, campaign: string, at: string) => Promise<boolean>;
  /** Remove a claim after a definite failure. */
  unmarkSent: (userId: string, campaign: string) => Promise<void>;
  /** Send one e-mail. Must never throw (sendPlatformEmail never does); a throw counts as an ambiguous network failure. */
  send: (input: { userId: string; to: string; vars: Record<string, string>; idempotencyKey: string; unsubscribeUrl: string }) => Promise<SendOutcome>;
  /** The words of the announcement for a display name; null when there is nothing live to announce. */
  compose: (name: string) => Record<string, string> | null;
  /** The signed one-click unsubscribe URL of a user. */
  unsubscribeUrl: (userId: string) => string;
  now: () => number;
  /** Fixed codes and ids only: never an address or a body. */
  log: (event: string, fields: Record<string, string | number>) => void;
  testAccountIds?: ReadonlySet<string>;
  isTestAccount?: (user: NewsUser) => boolean;
  suppressed?: ReadonlySet<string>;
  onlyUserIds?: ReadonlySet<string>;
}

export interface NewsCampaignOptions {
  campaign: string;
  cap: number;
  /** DEFAULT true. Only `false` sends. */
  dryRun?: boolean;
  confirm?: string;
  /** Wall-clock budget of a real run in ms (default LAUNCH_TIME_BUDGET_MS); on expiry the run stops cleanly with stopped = "time_budget". */
  budgetMs?: number;
}

export type NewsStop = "end_of_list" | "cap_reached" | "time_budget" | "consecutive_failures" | "unauthorized" | "resend_not_configured" | "list_failed";
export type NewsRefusal = "invalid_campaign" | "invalid_cap" | "confirm_mismatch" | "nothing_to_announce";

export interface NewsCampaignResult {
  mode: "dry_run" | "send" | "refused";
  refused?: NewsRefusal;
  campaign: string;
  /** min(requested cap, LAUNCH_HARD_CAP). */
  cap: number;
  /** false when no flag-gated feature is live (the announcement has nothing to say). */
  hasContent: boolean;
  scanned: number;
  /** Passed every check and not yet marked. */
  eligible: number;
  wouldSend: number;
  sent: number;
  /** Sends that failed ambiguously (timeout, network): the mail MAY have gone out, so each counts toward the cap. */
  ambiguous: number;
  failed: number;
  skipped: Partial<Record<SkipReason, number>>;
  sentUserIds: string[];
  failedUserIds: string[];
  stopped?: NewsStop;
}

const CAMPAIGN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** The exact text a real send needs: it names the campaign and the cap, so a copied command for another run cannot fire this one. */
export const confirmationFor = (campaign: string, cap: number): string => `SEND ${campaign} ${cap}`;

/** Failures after which the mail MAY have gone out: the claim stays (an under-send is safe, a double send is not). */
const AMBIGUOUS = new Set(["timeout", "network_error", "function_unavailable"]);

export async function runNewsCampaign(deps: NewsCampaignDeps, opts: NewsCampaignOptions): Promise<NewsCampaignResult> {
  const dryRun = opts.dryRun !== false;
  const cap = Number.isInteger(opts.cap) && opts.cap > 0 ? Math.min(opts.cap, LAUNCH_HARD_CAP) : 0;
  const result: NewsCampaignResult = {
    mode: dryRun ? "dry_run" : "send", campaign: String(opts.campaign ?? ""), cap, hasContent: deps.compose("") !== null,
    scanned: 0, eligible: 0, wouldSend: 0, sent: 0, ambiguous: 0, failed: 0, skipped: {}, sentUserIds: [], failedUserIds: [],
  };
  const refuse = (refused: NewsRefusal): NewsCampaignResult => ({ ...result, mode: "refused", refused });
  const skip = (reason: SkipReason) => { result.skipped[reason] = (result.skipped[reason] ?? 0) + 1; };

  if (!CAMPAIGN_RE.test(result.campaign)) return refuse("invalid_campaign");
  if (cap === 0) return refuse("invalid_cap");
  if (!dryRun) {
    if (opts.confirm !== confirmationFor(result.campaign, opts.cap)) return refuse("confirm_mismatch");
    if (!result.hasContent) return refuse("nothing_to_announce");
  }

  const ctx: EligibilityContext = { testAccountIds: deps.testAccountIds, isTestAccount: deps.isTestAccount, suppressed: deps.suppressed, onlyUserIds: deps.onlyUserIds, now: deps.now };
  const budget = Number.isFinite(opts.budgetMs) && (opts.budgetMs as number) > 0 ? (opts.budgetMs as number) : LAUNCH_TIME_BUDGET_MS;
  const startedAt = deps.now();
  const outOfTime = () => deps.now() - startedAt >= budget;
  const seen = new Set<string>();
  let consecutiveFailures = 0;
  deps.log("campaign_start", { campaign: result.campaign, mode: result.mode, cap });

  pages:
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (!dryRun && outOfTime()) { result.stopped = "time_budget"; break; }
    let users: NewsUser[];
    try {
      users = await deps.listUsers(page);
    } catch {
      result.stopped = "list_failed";
      break;
    }
    if (!users || users.length === 0) { result.stopped = "end_of_list"; break; }

    for (const listed of users) {
      if (!listed || typeof listed.id !== "string" || seen.has(listed.id)) continue;
      seen.add(listed.id);
      result.scanned += 1;

      const listedReason = newsSkipReason(listed, ctx);
      if (listedReason) { skip(listedReason); continue; }
      if (deps.isSent(listed, result.campaign)) { skip("already_sent"); continue; }
      result.eligible += 1;
      if (dryRun) continue;

      // ----- a real send: stop cleanly when the time is up (claims already made stay), else re-read and re-check immediately before this recipient -----
      if (outOfTime()) { result.stopped = "time_budget"; break pages; }
      let fresh: NewsUser | null = null;
      try { fresh = await deps.getUserById(listed.id); } catch { fresh = null; }
      if (!fresh) { skip("unreadable"); continue; }
      const reason = newsSkipReason(fresh, ctx);
      if (reason) { skip(reason); continue; }
      if (deps.isSent(fresh, result.campaign)) { skip("already_sent"); continue; }

      // CLAIM first, send second: a crash between the two loses one e-mail, never sends one twice
      const claimed = await deps.markSent(fresh.id, result.campaign, new Date(deps.now()).toISOString());
      if (!claimed) {
        skip("claim_failed");
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) { result.stopped = "consecutive_failures"; break pages; }
        continue;
      }
      const key = `${result.campaign}:${fresh.id}`;
      const vars = deps.compose(resolveDisplayName(fresh));
      let outcome: SendOutcome;
      try {
        outcome = vars
          ? await deps.send({ userId: fresh.id, to: String(fresh.email).trim(), vars, idempotencyKey: key, unsubscribeUrl: deps.unsubscribeUrl(fresh.id) })
          : { ok: false, reason: "invalid_request" };
      } catch {
        outcome = { ok: false, reason: "network_error" };
      }

      if (outcome.ok) {
        result.sent += 1;
        result.sentUserIds.push(fresh.id);
        consecutiveFailures = 0;
        deps.log("sent", { userId: fresh.id, key, result: "ok" });
        if (result.sent + result.ambiguous >= cap) { result.stopped = "cap_reached"; break pages; }
        continue;
      }

      const code = String(outcome.reason ?? "unknown");
      result.failed += 1;
      result.failedUserIds.push(fresh.id);
      consecutiveFailures += 1;
      if (AMBIGUOUS.has(code)) {
        // the mail may have been delivered: it counts toward the cap, so ambiguous/ok alternation can never exceed it
        result.ambiguous += 1;
      } else {
        try { await deps.unmarkSent(fresh.id, result.campaign); } catch { /* the claim stays: an under-send is the safe side */ }
      }
      deps.log("failed", { userId: fresh.id, key, result: code });
      if (code === "unauthorized" || code === "resend_not_configured") { result.stopped = code; break pages; }
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) { result.stopped = "consecutive_failures"; break pages; }
      if (result.sent + result.ambiguous >= cap) { result.stopped = "cap_reached"; break pages; }
    }
  }

  result.wouldSend = dryRun ? Math.min(result.eligible, cap) : 0;
  deps.log("campaign_end", { campaign: result.campaign, mode: result.mode, eligible: result.eligible, sent: result.sent, ambiguous: result.ambiguous, failed: result.failed, stopped: result.stopped ?? "none" });
  return result;
}
