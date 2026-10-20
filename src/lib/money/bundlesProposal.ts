/**
 * PROPOSAL (parked branch, not wired): wallet bundles with a bonus, a work-email bonus and referral rewards.
 *
 * None of these touch the existing top-up approval. A bonus is a SEPARATE append-only ledger row written by a NEW function
 * after the top-up is approved; its id is deterministic (bon_<topup id>, bon_workemail_<user id>, ref_<referral id>_<side>), so
 * a repeat can never credit twice. The base top-up row (top_<id>) is never changed.
 */
export const POINT_VALUE_EGP = 0.1;

export interface BundleTier {
  /** Whole pounds paid. */
  amountEgp: number;
  /** Bonus on top of the base points, in whole percent. */
  bonusPercent: number;
}

export const BUNDLE_TIERS: readonly BundleTier[] = [
  { amountEgp: 100, bonusPercent: 0 },
  { amountEgp: 250, bonusPercent: 5 },
  { amountEgp: 500, bonusPercent: 15 },
  { amountEgp: 1000, bonusPercent: 25 },
  { amountEgp: 2500, bonusPercent: 40 },
];

export const MIN_TOPUP_FOR_REFERRAL_EGP = 100;
export const WORK_EMAIL_BONUS_POINTS = 100;
export const MAX_WORK_EMAIL_BONUSES_PER_DOMAIN = 3;
export const REFERRER_REWARD_POINTS = 200;
export const REFEREE_REWARD_POINTS = 100;

/** The base points a top-up credits today: floor(amount / 0.10). */
export function basePointsFor(amountEgp: number): number {
  return Math.max(0, Math.floor(amountEgp / POINT_VALUE_EGP + 1e-9));
}

/** The highest tier whose amount is reached (a top-up between two tiers earns the lower tier's bonus). */
export function tierFor(amountEgp: number): BundleTier | null {
  let found: BundleTier | null = null;
  for (const tier of BUNDLE_TIERS) if (amountEgp >= tier.amountEgp) found = tier;
  return found;
}

export function bonusPointsFor(amountEgp: number): number {
  const tier = tierFor(amountEgp);
  if (!tier || tier.bonusPercent <= 0) return 0;
  return Math.floor((basePointsFor(amountEgp) * tier.bonusPercent) / 100);
}

export const bonusLedgerId = (topupId: string) => `bon_${topupId}`;
export const workEmailBonusLedgerId = (userId: string) => `bon_workemail_${userId}`;
export const referralLedgerId = (referralId: string, side: "referrer" | "referee") => `ref_${referralId}_${side}`;

/** Addresses on free mail providers never earn the work-email bonus. */
export const FREE_EMAIL_DOMAINS: readonly string[] = [
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.com.eg", "ymail.com", "hotmail.com", "outlook.com", "live.com", "msn.com",
  "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "mail.com", "zoho.com", "yandex.com",
];

export function emailDomain(email: string): string | null {
  const match = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/.exec(String(email || "").trim().toLowerCase());
  return match ? match[1] : null;
}

export function isWorkEmail(email: string): boolean {
  const domain = emailDomain(email);
  return domain !== null && !FREE_EMAIL_DOMAINS.includes(domain) && !/^(?:example|test|localhost|invalid)\./.test(domain);
}

export interface MarginImpact {
  bonusPercent: number;
  pointsPerPound: number;
  /** Pounds of revenue per point actually delivered. */
  revenuePerPointEgp: number;
  /** Gross margin on provider cost: 1 - cost/revenue, with cost = EGP per point / markup. */
  grossMargin: number;
}

/**
 * The effect of a bonus on gross margin, before payment fees and unspent points. At markup m a point costs EGP-per-point / m.
 * A bonus of b gives (1 + b) points for the same pound, so revenue per point falls to 1 / (10 x (1 + b)).
 */
export function marginImpact(bonusPercent: number, markup = 10): MarginImpact {
  const pointsPerPound = (1 + bonusPercent / 100) / POINT_VALUE_EGP;
  const revenuePerPointEgp = 1 / pointsPerPound;
  const costPerPointEgp = POINT_VALUE_EGP / markup;
  return { bonusPercent, pointsPerPound, revenuePerPointEgp, grossMargin: 1 - costPerPointEgp / revenuePerPointEgp };
}

/** What the referral and the work-email bonus give away, in points and in pounds of face value. */
export function giveawayValue(points: number): { points: number; egp: number } {
  return { points, egp: Number((points * POINT_VALUE_EGP).toFixed(2)) };
}
