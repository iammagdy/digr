import { classifyLedgerRow, type CreditKind } from "../creditKinds";

export interface TypedLedgerRow {
  id: string;
  userId: string;
  delta: number;
  type: string;
  kind: CreditKind;
  jobId: string | null;
  topupId: string | null;
  note: string;
  createdAt: string;
  actorId: string | null;
}

const PAGE = 1000;

function isMissingRelation(error: any): boolean {
  const text = `${error?.code || ""} ${error?.message || ""}`;
  return /42P01|PGRST205|credit_ledger_typed/i.test(text) && /42P01|PGRST205|does not exist|schema cache|could not find/i.test(text);
}

function toRow(raw: any): TypedLedgerRow {
  return {
    id: String(raw.id),
    userId: String(raw.user_id),
    delta: Number(raw.delta) || 0,
    type: String(raw.type || ""),
    kind: classifyLedgerRow({ type: raw.type, kind: raw.kind }),
    jobId: raw.job_id ?? null,
    topupId: raw.topup_id ?? null,
    note: String(raw.note || ""),
    createdAt: String(raw.created_at || ""),
    actorId: raw.actor_id ?? null,
  };
}

export interface LedgerFilter {
  userId?: string;
  /** inclusive ISO lower bound */
  from?: string;
  /** exclusive ISO upper bound */
  to?: string;
}

async function readAll(client: any, table: string, filter: LedgerFilter, cap: number): Promise<{ rows: any[]; error: any }> {
  const rows: any[] = [];
  for (let from = 0; from < cap; from += PAGE) {
    let query = client.from(table).select("*");
    if (filter.userId) query = query.eq("user_id", filter.userId);
    if (filter.from) query = query.gte("created_at", filter.from);
    if (filter.to) query = query.lt("created_at", filter.to);
    const { data, error } = await query.order("created_at", { ascending: true }).order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (error) return { rows, error };
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return { rows, error: null };
}

/**
 * Every ledger row with its kind, oldest first. Reads the typed view; when the view is not installed yet it reads the
 * ledger itself and classifies by row type (the same rule), so history and finance work before and after the migration.
 */
export async function fetchTypedLedger(client: any, filter: LedgerFilter = {}, cap = 20000): Promise<TypedLedgerRow[]> {
  const viaView = await readAll(client, "credit_ledger_typed", filter, cap);
  if (!viaView.error) return viaView.rows.map(toRow);
  if (!isMissingRelation(viaView.error)) throw new Error("ledger_read_failed");
  console.warn("[money:credit_ledger_typed_unavailable] migration not applied; classifying by row type");
  const direct = await readAll(client, "credit_ledger", filter, cap);
  if (direct.error) throw new Error("ledger_read_failed");
  return direct.rows.map(toRow);
}

/**
 * The newest rows of one customer's ledger, newest first, in ONE bounded read (never more than `limit`, at most 1000): what the
 * wallet history shows. The history used to read up to five thousand rows to show five hundred.
 */
export async function fetchNewestLedgerRows(client: any, filter: LedgerFilter, limit = 500): Promise<TypedLedgerRow[]> {
  const size = Math.max(1, Math.min(PAGE, Math.floor(limit)));
  const read = async (table: string) => {
    let query = client.from(table).select("*");
    if (filter.userId) query = query.eq("user_id", filter.userId);
    return query.order("created_at", { ascending: false }).order("id", { ascending: false }).range(0, size - 1);
  };
  const viaView = await read("credit_ledger_typed");
  if (!viaView.error) return (viaView.data || []).map(toRow);
  if (!isMissingRelation(viaView.error)) throw new Error("ledger_read_failed");
  const direct = await read("credit_ledger");
  if (direct.error) throw new Error("ledger_read_failed");
  return (direct.data || []).map(toRow);
}

export interface RowWithBalance extends TypedLedgerRow {
  runningBalance: number;
}

/** Rows must be oldest first; the running balance is the plain sum of deltas, exactly like the stored balance. */
export function withRunningBalance(rowsOldestFirst: TypedLedgerRow[], startingBalance = 0): RowWithBalance[] {
  let balance = startingBalance;
  return rowsOldestFirst.map((row) => {
    balance += row.delta;
    return { ...row, runningBalance: balance };
  });
}
