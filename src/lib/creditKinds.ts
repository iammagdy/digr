/**
 * What a credit row is, for history, finance and support. Real Instapay income, promotional credit and manual
 * admin credit are different things and must never be merged in any report.
 */
export type CreditKind = "topup_instapay" | "promo_code" | "admin_grant" | "reserve" | "charge" | "release";

export const CREDIT_KINDS: readonly CreditKind[] = ["topup_instapay", "promo_code", "admin_grant", "reserve", "charge", "release"];

export const CREDIT_KIND_LABEL_AR: Record<CreditKind, string> = {
  topup_instapay: "شحن عبر انستاباي",
  promo_code: "رصيد ترويجي",
  admin_grant: "هدية من الإدارة",
  reserve: "حجز مؤقت",
  charge: "خصم التسليم",
  release: "حجز مؤقت مُحرَّر",
};

export interface LedgerKindInput {
  type?: string | null;
  kind?: string | null;
}

/**
 * Same rule as the database view `credit_ledger_typed`: a recorded kind wins; otherwise topup rows are Instapay
 * top-ups, grant / goodwill rows are admin credit, and reserve / charge / release keep their own type. Used when the
 * view is not installed yet, so every screen keeps working before and after the migration.
 */
export function classifyLedgerRow(row: LedgerKindInput): CreditKind {
  const recorded = String(row.kind ?? "");
  if ((CREDIT_KINDS as readonly string[]).includes(recorded)) return recorded as CreditKind;
  switch (row.type) {
    case "topup": return "topup_instapay";
    case "grant":
    case "goodwill": return "admin_grant";
    case "reserve": return "reserve";
    case "charge": return "charge";
    case "release": return "release";
    default: return "admin_grant";
  }
}

/** Only approved Instapay top-ups are income. Promotional and admin credit are never revenue. */
export function isRealIncomeKind(kind: CreditKind): boolean {
  return kind === "topup_instapay";
}

export function isPromotionalKind(kind: CreditKind): boolean {
  return kind === "promo_code";
}

/** Credit that adds points without payment. */
export function isFreeCreditKind(kind: CreditKind): boolean {
  return kind === "promo_code" || kind === "admin_grant";
}
