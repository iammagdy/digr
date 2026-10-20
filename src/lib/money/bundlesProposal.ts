/**
 * PROPOSAL V2 (parked branch, not wired): wallet bundles with a bonus, the work-or-university e-mail bonus and referral rewards,
 * aligned with the numbers the owner approved.
 *
 * None of these touch the existing top-up approval (`approve_topup_atomic`). A bonus is a SEPARATE append-only ledger row written
 * by a NEW function after the top-up is approved; its id is deterministic (bon_<topup id>, bon_email_<topup id>,
 * ref_<referral id>_<side>), so a repeat can never credit twice. The base row top_<topup id> is never changed.
 */
export const POINT_VALUE_EGP = 0.1;

export type BundleLine = "social" | "companies";

export interface Bundle {
  code: string;
  line: BundleLine;
  /** Base points bought (the price is points x 0.10 EGP). */
  points: number;
  /** Bonus on the base points, in whole percent. */
  bonusPercent: number;
}

export const BUNDLES: readonly Bundle[] = [
  { code: "social_2000", line: "social", points: 2_000, bonusPercent: 10 },
  { code: "social_5000", line: "social", points: 5_000, bonusPercent: 20 },
  { code: "social_10000", line: "social", points: 10_000, bonusPercent: 30 },
  { code: "social_25000", line: "social", points: 25_000, bonusPercent: 40 },
  { code: "companies_3000", line: "companies", points: 3_000, bonusPercent: 10 },
  { code: "companies_8000", line: "companies", points: 8_000, bonusPercent: 20 },
  { code: "companies_20000", line: "companies", points: 20_000, bonusPercent: 30 },
];

/** A free amount: 0.10 EGP per point, no bonus, never less than this many pounds. */
export const FREE_AMOUNT_MIN_EGP = 100;

/** «بريد عمل أو جامعي»: percentage points added to the bundle's bonus, after the e-mail is confirmed. */
export const EMAIL_BONUS_PERCENT_POINTS = 5;
export const MAX_EMAIL_BONUS_ACCOUNTS_PER_DOMAIN = 5;

export const MIN_TOPUP_FOR_REFERRAL_EGP = 100;
export const REFERRER_REWARD_POINTS = 200;
export const REFEREE_REWARD_POINTS = 100;
export const MAX_REWARDED_REFERRALS_PER_REFERRER = 20;

export const bundleByCode = (code: string): Bundle | null => BUNDLES.find((bundle) => bundle.code === code) ?? null;
export const bundlePriceEgp = (bundle: Bundle) => Number((bundle.points * POINT_VALUE_EGP).toFixed(2));
export const bundleBonusPoints = (bundle: Bundle) => Math.floor((bundle.points * bundle.bonusPercent) / 100);
export const emailBonusPoints = (bundle: Bundle) => Math.floor((bundle.points * EMAIL_BONUS_PERCENT_POINTS) / 100);

/** The base points a top-up credits today: floor(amount / 0.10). */
export function basePointsFor(amountEgp: number): number {
  return Math.max(0, Math.floor(amountEgp / POINT_VALUE_EGP + 1e-9));
}

export type FreeAmountCheck = { ok: true; points: number } | { ok: false; reasonAr: string };

/** A free amount below the minimum is refused; above it, it buys exactly floor(amount / 0.10) points and earns no bonus. */
export function checkFreeAmount(amountEgp: number): FreeAmountCheck {
  if (!Number.isFinite(amountEgp) || amountEgp < FREE_AMOUNT_MIN_EGP) {
    return { ok: false, reasonAr: "أقل مبلغ للشحن بمبلغ حر هو ١٠٠ جنيه." };
  }
  return { ok: true, points: basePointsFor(amountEgp) };
}

export interface BundleOutcome {
  paidEgp: number;
  basePoints: number;
  bundleBonus: number;
  emailBonus: number;
  totalPoints: number;
}

/** What a bundle purchase credits: the base row, the bundle bonus row and (when eligible) the e-mail bonus row. */
export function bundleOutcome(bundle: Bundle, emailEligible: boolean): BundleOutcome {
  const bundleBonus = bundleBonusPoints(bundle);
  const emailBonus = emailEligible ? emailBonusPoints(bundle) : 0;
  return { paidEgp: bundlePriceEgp(bundle), basePoints: bundle.points, bundleBonus, emailBonus, totalPoints: bundle.points + bundleBonus + emailBonus };
}

export const bonusLedgerId = (topupId: string) => `bon_${topupId}`;
export const emailBonusLedgerId = (topupId: string) => `bon_email_${topupId}`;
export const referralLedgerId = (referralId: string, side: "referrer" | "referee") => `ref_${referralId}_${side}`;

/** Addresses on free mail providers never earn the e-mail bonus; any other confirmed domain (a company or a university) does. */
export const FREE_EMAIL_DOMAINS: readonly string[] = [
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.com.eg", "ymail.com", "hotmail.com", "outlook.com", "live.com", "msn.com",
  "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "mail.com", "zoho.com", "yandex.com",
];

export function emailDomain(email: string): string | null {
  const match = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/.exec(String(email || "").trim().toLowerCase());
  return match ? match[1] : null;
}

export function isWorkOrUniversityEmail(email: string): boolean {
  const domain = emailDomain(email);
  return domain !== null && !FREE_EMAIL_DOMAINS.includes(domain) && !/^(?:example|test|localhost|invalid)\./.test(domain);
}

export interface BundleEconomics {
  paidEgp: number;
  totalPoints: number;
  pointsPerPound: number;
  /** Pounds of revenue per point actually credited. */
  revenuePerPointEgp: number;
  /** Gross margin on provider cost: 1 - cost/revenue, with cost = EGP per point / markup (before fees and unspent points). */
  grossMargin: number;
}

export function bundleEconomics(bundle: Bundle, emailEligible: boolean, markup = 10): BundleEconomics {
  const outcome = bundleOutcome(bundle, emailEligible);
  return economicsOf(outcome.paidEgp, outcome.totalPoints, markup);
}

/** A free amount: no bonus, margin is exactly 1 - 1/markup. */
export function freeAmountEconomics(amountEgp: number, markup = 10): BundleEconomics {
  return economicsOf(amountEgp, basePointsFor(amountEgp), markup);
}

function economicsOf(paidEgp: number, totalPoints: number, markup: number): BundleEconomics {
  const revenuePerPointEgp = paidEgp / totalPoints;
  return { paidEgp, totalPoints, pointsPerPound: totalPoints / paidEgp, revenuePerPointEgp, grossMargin: 1 - POINT_VALUE_EGP / markup / revenuePerPointEgp };
}

/** The pounds a job of `points` effectively costs when its points were bought as this bundle (points are one currency). */
export function effectiveEgpFor(points: number, economics: BundleEconomics): number {
  return Number((points * economics.revenuePerPointEgp).toFixed(2));
}

/** What the referral gives away, in points and in pounds of face value. */
export function giveawayValue(points: number): { points: number; egp: number } {
  return { points, egp: Number((points * POINT_VALUE_EGP).toFixed(2)) };
}
