export const NEW_ACCOUNT_WINDOW_DAYS = 7;

/** «جديد»: the account was created within 7 days before the redemption. Otherwise the account already existed. */
export function isNewAccountAtRedemption(accountCreatedAt: string | null | undefined, redeemedAt: string): boolean {
  if (!accountCreatedAt) return false;
  const created = new Date(accountCreatedAt).getTime();
  const redeemed = new Date(redeemedAt).getTime();
  if (!Number.isFinite(created) || !Number.isFinite(redeemed)) return false;
  return redeemed >= created && redeemed - created <= NEW_ACCOUNT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

export interface PromoCodeRow {
  code: string;
  points: number;
  max_redemptions: number;
  starts_at: string | null;
  expires_at: string | null;
  active: boolean;
  note: string | null;
  created_at: string;
}

export interface PromoRedemptionRow {
  code: string;
  user_id: string;
  redeemed_at: string;
}

export type PromoState = "active" | "disabled" | "not_started" | "expired" | "exhausted";

export function promoState(row: PromoCodeRow, used: number, now = Date.now()): PromoState {
  if (!row.active) return "disabled";
  if (row.starts_at && now < new Date(row.starts_at).getTime()) return "not_started";
  if (row.expires_at && now >= new Date(row.expires_at).getTime()) return "expired";
  if (used >= row.max_redemptions) return "exhausted";
  return "active";
}

export const PROMO_STATE_LABEL_AR: Record<PromoState, string> = {
  active: "فعّال",
  disabled: "معطّل",
  not_started: "لم يبدأ",
  expired: "منتهي",
  exhausted: "استُنفد",
};

export interface PromoCodeSummary {
  code: string;
  points: number;
  maxRedemptions: number;
  used: number;
  remaining: number;
  state: PromoState;
  stateAr: string;
  startsAt: string | null;
  expiresAt: string | null;
  active: boolean;
  note: string;
  createdAt: string;
  redemptions: Array<{ userId: string; redeemedAt: string; name: string; email: string; isNewAccount: boolean }>;
}

export function summarizePromoCodes(
  codes: PromoCodeRow[],
  redemptions: PromoRedemptionRow[],
  accounts: Map<string, { name: string; email: string; createdAt: string | null }>,
  now = Date.now(),
): PromoCodeSummary[] {
  return codes.map((row) => {
    const mine = redemptions.filter((r) => r.code === row.code).sort((a, b) => b.redeemed_at.localeCompare(a.redeemed_at));
    const state = promoState(row, mine.length, now);
    return {
      code: row.code,
      points: Number(row.points),
      maxRedemptions: Number(row.max_redemptions),
      used: mine.length,
      remaining: Math.max(0, Number(row.max_redemptions) - mine.length),
      state,
      stateAr: PROMO_STATE_LABEL_AR[state],
      startsAt: row.starts_at,
      expiresAt: row.expires_at,
      active: row.active,
      note: row.note || "",
      createdAt: row.created_at,
      redemptions: mine.map((r) => {
        const account = accounts.get(r.user_id);
        return {
          userId: r.user_id,
          redeemedAt: r.redeemed_at,
          name: account?.name || "",
          email: account?.email || "",
          isNewAccount: isNewAccountAtRedemption(account?.createdAt, r.redeemed_at),
        };
      }),
    };
  });
}
