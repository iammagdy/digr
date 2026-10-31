import type { BatchInput, DocStatus, DocType, DocView, LineInput, ListItem, Money, StatusEvent, Totals } from "@/lib/invoices/types";

type Row = Record<string, any>;
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const must = (v: unknown): number => Number(v ?? 0);

const minus = (a: Money, b: Money): Money => ({
  usd: a.usd - b.usd,
  points: a.points === null || b.points === null ? null : a.points - b.points,
  egp: a.egp === null || b.egp === null ? null : a.egp - b.egp,
});

/** Database rows -> the document the screens and the sheet use (camelCase, integers kept as integers). */
export function rowToDoc(row: Row, batchRows: Row[], lineRows: Row[]): DocView {
  const batches: BatchInput[] = [...batchRows].sort((a, b) => a.sort_order - b.sort_order).map((b) => ({ key: String(b.id), title: String(b.title), summaryOnly: Boolean(b.summary_only) }));
  const sortedLines = [...lineRows].sort((a, b) => a.sort_order - b.sort_order);
  const lines: LineInput[] = sortedLines.map((l) => ({
    key: String(l.id),
    batchKey: l.batch_id ? String(l.batch_id) : null,
    itemTypeId: l.item_type_id ? String(l.item_type_id) : null,
    itemTypeName: String(l.item_type_name ?? ""),
    description: String(l.description ?? ""),
    quantity: must(l.quantity),
    unitCc: must(l.unit_price_usd_centi_cents),
    hidden: Boolean(l.hidden),
    frozenPoints: num(l.line_total_points),
    frozenEgp: num(l.line_total_egp_qirsh),
  }));
  const status = row.status as DocStatus;
  let frozen: Totals | null = null;
  if (status !== "draft" && row.total_usd_cents !== null && row.total_usd_cents !== undefined) {
    const sum = (p: string): Money => ({ usd: must(row[`${p}_usd_cents`]), points: num(row[`${p}_points`]), egp: num(row[`${p}_egp_qirsh`]) });
    const subtotal = sum("subtotal");
    const discount = sum("discount");
    frozen = {
      lines: sortedLines.map((l) => ({ usd: must(l.line_total_usd_cents), points: num(l.line_total_points), egp: num(l.line_total_egp_qirsh) })),
      subtotal, discount, afterDiscount: minus(subtotal, discount), tax: sum("tax"), total: sum("total"),
    };
  }
  return {
    id: String(row.id),
    docType: row.doc_type as DocType,
    number: String(row.number ?? ""),
    status,
    revision: must(row.revision) || 1,
    client: { id: row.client_id ? String(row.client_id) : null, company: row.client_company ?? "", contact: row.client_contact ?? "", email: row.client_email ?? "", phone: row.client_phone ?? "", address: row.client_address ?? "" },
    issueDate: String(row.issue_date ?? ""),
    dueDate: row.due_date ? String(row.due_date) : null,
    show: { usd: Boolean(row.show_usd), points: Boolean(row.show_points), egp: Boolean(row.show_egp) },
    rateE4: num(row.rate_egp_per_usd_e4),
    creditValueE4: must(row.credit_value_e4) || 1000,
    discountKind: row.discount_kind,
    discountValue: must(row.discount_value),
    taxEnabled: Boolean(row.tax_enabled),
    taxLabel: row.tax_label ?? "ضريبة",
    taxBp: must(row.tax_bp),
    notes: row.notes ?? "",
    paymentInstructions: row.payment_instructions ?? "",
    instapayAddress: row.instapay_address ?? "",
    showInstapayQr: row.show_instapay_qr !== false,
    paidAt: row.paid_at ? String(row.paid_at) : null,
    paymentReference: row.payment_reference ?? "",
    convertedFromId: row.converted_from_id ? String(row.converted_from_id) : null,
    duplicatedFromId: row.duplicated_from_id ? String(row.duplicated_from_id) : null,
    lockedAt: row.locked_at ? String(row.locked_at) : null,
    batches, lines, frozen,
    createdAt: row.created_at ? String(row.created_at) : undefined,
    updatedAt: row.updated_at ? String(row.updated_at) : undefined,
  };
}

export function rowToEvent(row: Row): StatusEvent {
  return {
    id: must(row.id), fromStatus: (row.from_status ?? null) as DocStatus | null, toStatus: row.to_status as DocStatus, adminId: String(row.admin_id),
    note: row.note ?? "", paidAt: row.paid_at ? String(row.paid_at) : null, paymentReference: row.payment_reference ?? "", createdAt: String(row.created_at),
  };
}

export function rowToListItem(row: Row, totals: { usd: number; points: number | null; egp: number | null }): ListItem {
  return {
    id: String(row.id), docType: row.doc_type, number: String(row.number), status: row.status, clientCompany: row.client_company ?? "",
    issueDate: String(row.issue_date), dueDate: row.due_date ? String(row.due_date) : null,
    totalUsd: totals.usd, totalPoints: totals.points, totalEgp: totals.egp,
    show: { usd: Boolean(row.show_usd), points: Boolean(row.show_points), egp: Boolean(row.show_egp) }, updatedAt: String(row.updated_at ?? row.created_at ?? ""),
  };
}
