export interface TopupRecord {
  $id: string;
  id?: string;
  userId?: string;
  amountEgp: number;
  confirmedAmountEgp?: number | null;
  credits?: number | null;
  reference: string;
  senderName?: string | null;
  senderPhone?: string | null;
  receiptFileId?: string | null;
  status: "pending" | "approved" | "rejected";
  rejectReason?: string | null;
  createdAt: string;
  reviewedAt?: string | null;
}

export interface LedgerRow {
  $id: string;
  id?: string;
  userId?: string;
  type: "topup" | "reserve" | "release" | "charge" | "promo" | "adjust";
  delta: number;
  jobId?: string | null;
  topupId?: string | null;
  note?: string | null;
  createdAt: string;
}

export const USER_STATUS: Record<TopupRecord["status"], string> = { approved: "معتمد", pending: "قيد المراجعة", rejected: "مرفوض" };

/** Status pill colours from the design (tinted background + token foreground). */
export function statusBadge(status: TopupRecord["status"]): { bg: string; fg: string } {
  if (status === "approved") return { bg: "color-mix(in oklab, var(--ok) 14%, transparent)", fg: "var(--ok)" };
  if (status === "rejected") return { bg: "color-mix(in oklab, var(--bad) 14%, transparent)", fg: "var(--bad)" };
  return { bg: "color-mix(in oklab, var(--gold) 16%, transparent)", fg: "var(--goldT)" };
}
