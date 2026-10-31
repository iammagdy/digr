/**
 * An in-memory model of the invoice_* tables and the three SQL functions of docs/proposals/admin-invoices (04_functions.sql) and their guards
 * (03_numbering_and_guards.sql), written separately from the app code so the tests check the app against the SQL's rules:
 * numbering, the lock after «مرسلة», the allowed transitions, the revision check, the frozen totals, the append-only log, and «service_role may only READ the
 * document tables» (a direct write on them fails exactly as the revoked privileges would).
 * Every table and function the code touches is recorded in `touched`, so a test can prove that no wallet table was ever used.
 */
type Row = Record<string, any>;
export interface Touch { kind: "from" | "rpc"; name: string; op: string }

const DIRECT_WRITE_OK = new Set(["invoice_settings", "invoice_item_types", "invoice_clients"]);
const KNOWN = new Set(["invoice_settings", "invoice_item_types", "invoice_clients", "invoice_number_counters", "invoice_documents", "invoice_batches", "invoice_lines", "invoice_status_events"]);
const TRANSITIONS = [["draft", "sent"], ["draft", "void"], ["sent", "paid"], ["sent", "void"]];

export class InvoiceDbModel {
  tables: Record<string, Row[]> = {};
  touched: Touch[] = [];
  /** public.settings_public (the pricing row) is read-only here, like the app's single read of it */
  /** rows written to tables outside the invoice set (the admin audit log): stored, so counts and limits can be tested */
  extra: Record<string, Row[]> = {};
  settingsPublic: Row[] = [{ key: "pricing", value: { ipa: "iammagdy@instapay", creditValueEgp: 0.1 } }];
  now: () => Date = () => new Date("2026-10-31T10:00:00Z");
  private seq = 0;
  private eventSeq = 0;

  constructor() {
    for (const t of KNOWN) this.tables[t] = [];
    this.tables.invoice_settings.push({ id: true, seller_name_ar: "ديجر", seller_email: "support@diger.tech", seller_website: "diger.tech", seller_tax_number: null, seller_commercial_register: null, last_rate_egp_per_usd_e4: null });
    ["شركة", "مدير", "بريد إلكتروني", "رقم هاتف"].forEach((name, i) => this.tables.invoice_item_types.push({ id: this.uuid(), name_ar: name, default_unit_price_usd_centi_cents: 0, sort_order: i + 1, is_active: true, created_at: this.now().toISOString() }));
  }

  uuid(): string { this.seq += 1; return `00000000-0000-4000-8000-${String(this.seq).padStart(12, "0")}`; }
  private fail(message: string, code?: string): never { throw Object.assign(new Error(message), { code }); }

  from(table: string) { return new Query(this, table); }

  async rpc(name: string, args: Record<string, any>): Promise<{ data: any; error: any }> {
    this.touched.push({ kind: "rpc", name, op: "rpc" });
    // one transaction: work on a copy and keep it only if the function does not raise
    const snapshot = JSON.parse(JSON.stringify({ t: this.tables, s: this.seq, e: this.eventSeq }));
    try {
      let data: any = null;
      if (name === "invoice_create_document") data = this.create(args);
      else if (name === "invoice_save_draft") data = this.save(args);
      else if (name === "invoice_set_status") data = this.setStatus(args);
      else this.fail("function does not exist", "42883");
      return { data, error: null };
    } catch (e: any) {
      this.tables = snapshot.t; this.seq = snapshot.s; this.eventSeq = snapshot.e;
      return { data: null, error: { message: e.message, code: e.code } };
    }
  }

  // ---- helpers shared by the functions ----
  private doc(id: string): Row | undefined { return this.tables.invoice_documents.find((d) => d.id === id); }
  private lines(id: string): Row[] { return this.tables.invoice_lines.filter((l) => l.document_id === id); }
  private lineTotal(q: number, u: number): number { return Number((BigInt(q) * BigInt(u) + BigInt(50)) / BigInt(100)); }

  private applyFields(d: Row, p: Row) {
    const next = {
      client_id: p.client_id || null, client_company: p.client_company ?? "", client_contact: p.client_contact ?? "", client_email: p.client_email ?? "", client_phone: p.client_phone ?? "", client_address: p.client_address ?? "",
      issue_date: p.issue_date || d.issue_date, due_date: p.due_date || null,
      show_usd: p.show_usd ?? d.show_usd, show_points: p.show_points ?? d.show_points, show_egp: p.show_egp ?? d.show_egp,
      rate_egp_per_usd_e4: p.rate_egp_per_usd_e4 ?? null, credit_value_e4: p.credit_value_e4 ?? d.credit_value_e4,
      discount_kind: p.discount_kind ?? "none", discount_value: p.discount_value ?? 0, tax_enabled: p.tax_enabled ?? false, tax_label: p.tax_label || "ضريبة", tax_bp: p.tax_bp ?? 0,
      notes: p.notes ?? "", payment_instructions: p.payment_instructions ?? "", instapay_address: p.instapay_address ?? "", show_instapay_qr: p.show_instapay_qr ?? true,
    };
    // the CHECK constraints
    if (!(next.show_usd || next.show_points || next.show_egp)) this.fail("check one_currency", "23514");
    if ((next.show_points || next.show_egp) && next.rate_egp_per_usd_e4 == null) this.fail("check rate_needed", "23514");
    if (next.due_date && next.due_date < next.issue_date) this.fail("check dates", "23514");
    if (next.discount_kind === "percent" && next.discount_value > 10000) this.fail("check discount", "23514");
    if (next.credit_value_e4 < 100 || next.credit_value_e4 > 100000) this.fail("check credit", "23514");
    if (d.doc_type === "statement" && !(next.discount_kind === "none" && next.discount_value === 0 && !next.tax_enabled && next.show_usd && !next.show_points && !next.show_egp && next.rate_egp_per_usd_e4 == null)) this.fail("check statement_no_money", "23514");
    Object.assign(d, next);
  }

  private replaceChildren(docId: string, p: Row) {
    const docType = this.doc(docId)?.doc_type;
    if ((p.batches ?? []).length > 50 || (p.lines ?? []).length > 500) this.fail("invoice_too_large");
    this.tables.invoice_lines = this.tables.invoice_lines.filter((l) => l.document_id !== docId);
    this.tables.invoice_batches = this.tables.invoice_batches.filter((b) => b.document_id !== docId);
    const map: Record<string, string> = {};
    (p.batches ?? []).forEach((b: Row, i: number) => {
      const id = this.uuid();
      this.tables.invoice_batches.push({ id, document_id: docId, title: b.title, sort_order: i + 1, summary_only: !!b.summary_only });
      map[b.key] = id;
    });
    (p.lines ?? []).forEach((l: Row, i: number) => {
      let batch: string | null = null;
      if (docType === "statement" && Number(l.unit_price_usd_centi_cents) !== 0) this.fail("invoice_statement_no_prices");
      if (l.batch_key) { batch = map[l.batch_key] ?? null; if (!batch) this.fail("invoice_unknown_batch"); }
      if (!(l.quantity >= 1 && l.quantity <= 10_000_000) || !(l.unit_price_usd_centi_cents >= 0 && l.unit_price_usd_centi_cents <= 100_000_000)) this.fail("check line", "23514");
      this.tables.invoice_lines.push({
        id: this.uuid(), document_id: docId, batch_id: batch, sort_order: i + 1, item_type_id: l.item_type_id || null, item_type_name: l.item_type_name ?? "", description: l.description ?? "",
        quantity: l.quantity, unit_price_usd_centi_cents: l.unit_price_usd_centi_cents, line_total_usd_cents: this.lineTotal(l.quantity, l.unit_price_usd_centi_cents),
        hidden: !!l.hidden, line_total_points: null, line_total_egp_qirsh: null,
      });
    });
  }

  private event(docId: string, from: string | null, to: string, admin: string, note: string, paidAt: string | null, ref: string) {
    this.eventSeq += 1;
    this.tables.invoice_status_events.push({ id: this.eventSeq, document_id: docId, from_status: from, to_status: to, admin_id: admin, note, paid_at: paidAt, payment_reference: ref, created_at: this.now().toISOString() });
  }

  private create(a: Row): string {
    if (!a.p_admin) this.fail("invoice_admin_required");
    const year = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric" }).format(this.now()));
    let counter = this.tables.invoice_number_counters.find((c) => c.doc_type === a.p_type && c.year === year);
    if (!counter) { counter = { id: this.tables.invoice_number_counters.length + 1, doc_type: a.p_type, year, last_value: 0 }; this.tables.invoice_number_counters.push(counter); }
    counter.last_value += 1;
    const n = counter.last_value;
    const number = `${a.p_type === "invoice" ? "INV" : a.p_type === "statement" ? "STM" : "QUO"}-${year}-${n < 10000 ? String(n).padStart(4, "0") : String(n)}`;
    const d: Row = {
      id: this.uuid(), doc_type: a.p_type, number, status: "draft", revision: 1, issue_date: "2026-10-31", show_usd: true, show_points: false, show_egp: false, credit_value_e4: 1000,
      converted_from_id: a.p_converted_from ?? null, duplicated_from_id: a.p_duplicated_from ?? null, paid_at: null, payment_reference: "", locked_at: null, created_by: a.p_admin,
      created_at: this.now().toISOString(), updated_at: this.now().toISOString(), updated_by: a.p_admin,
      subtotal_usd_cents: null, discount_usd_cents: null, tax_usd_cents: null, total_usd_cents: null, subtotal_points: null, discount_points: null, tax_points: null, total_points: null,
      subtotal_egp_qirsh: null, discount_egp_qirsh: null, tax_egp_qirsh: null, total_egp_qirsh: null,
    };
    this.tables.invoice_documents.push(d);
    this.applyFields(d, a.p_payload);
    this.replaceChildren(d.id, a.p_payload);
    this.event(d.id, null, "draft", a.p_admin, a.p_converted_from ? "converted_from_quote" : a.p_duplicated_from ? "duplicated" : "created", null, "");
    return d.id;
  }

  private save(a: Row): number {
    if (!a.p_admin) this.fail("invoice_admin_required");
    const d = this.doc(a.p_id);
    if (!d) this.fail("invoice_not_found");
    if (d.status !== "draft") this.fail("invoice_locked");
    if (a.p_expected_revision !== d.revision) this.fail("invoice_stale");
    this.applyFields(d, a.p_payload);
    this.replaceChildren(d.id, a.p_payload);
    d.revision += 1; d.updated_by = a.p_admin; d.updated_at = this.now().toISOString();
    return d.revision;
  }

  private setStatus(a: Row): void {
    if (!a.p_admin) this.fail("invoice_admin_required");
    const d = this.doc(a.p_id);
    if (!d) this.fail("invoice_not_found");
    if (!TRANSITIONS.some(([f, t]) => f === d.status && t === a.p_to)) this.fail("invoice_bad_transition");
    if (a.p_to === "paid" && d.doc_type !== "invoice") this.fail("invoice_bad_transition");
    const from = d.status;
    if (a.p_to === "sent") {
      if (a.p_expected_revision !== d.revision) this.fail("invoice_stale");
      const t = a.p_frozen?.totals;
      if (!t) this.fail("invoice_frozen_required");
      const lines = this.lines(d.id);
      if (lines.length === 0) this.fail("invoice_no_lines");
      const sum = lines.reduce((s, l) => s + l.line_total_usd_cents, 0);
      if ((a.p_frozen.lines ?? []).length !== lines.length || t.subtotal_usd_cents !== sum) this.fail("invoice_stale");
      if (d.rate_egp_per_usd_e4 != null && (t.total_points == null || t.total_egp_qirsh == null)) this.fail("invoice_frozen_required");
      let matched = 0;
      for (const f of a.p_frozen.lines) { const l = lines.find((x) => x.id === f.id); if (l) { l.line_total_points = f.points; l.line_total_egp_qirsh = f.egp; matched += 1; } }
      if (matched !== lines.length) this.fail("invoice_stale");
      Object.assign(d, t, { locked_at: this.now().toISOString(), status: "sent" });
    } else if (a.p_to === "paid") {
      if (!a.p_paid_at) this.fail("invoice_paid_date_required");
      Object.assign(d, { status: "paid", paid_at: a.p_paid_at, payment_reference: a.p_reference ?? "" });
    } else {
      d.status = "void";
    }
    d.updated_by = a.p_admin; d.updated_at = this.now().toISOString();
    this.event(d.id, from, a.p_to, a.p_admin, a.p_note ?? "", a.p_to === "paid" ? a.p_paid_at : null, a.p_to === "paid" ? a.p_reference ?? "" : "");
  }
}

class Query implements PromiseLike<{ data: any; error: any }> {
  private filters: Array<(r: Row) => boolean> = [];
  private op: "select" | "insert" | "update" = "select";
  private payload: any = null;
  private orderBy: Array<[string, boolean]> = [];
  private slice: [number, number] | null = null;
  private max: number | null = null;
  private wantRows = true;
  private one: "single" | "maybe" | null = null;
  private countMode = false;
  private head = false;

  constructor(private db: InvoiceDbModel, private table: string) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) { if (this.op !== "select") this.wantRows = true; this.countMode = Boolean(opts?.count); this.head = Boolean(opts?.head); return this; }
  gte(col: string, val: any) { this.filters.push((r) => r[col] >= val); return this; }
  eq(col: string, val: any) { this.filters.push((r) => r[col] === val); return this; }
  in(col: string, vals: any[]) { this.filters.push((r) => vals.includes(r[col])); return this; }
  order(col: string, o?: { ascending?: boolean }) { this.orderBy.push([col, o?.ascending !== false]); return this; }
  range(a: number, b: number) { this.slice = [a, b]; return this; }
  limit(n: number) { this.max = n; return this; }
  single() { this.one = "single"; return this; }
  maybeSingle() { this.one = "maybe"; return this; }
  insert(row: any) { this.op = "insert"; this.payload = row; this.wantRows = false; return this; }
  update(patch: any) { this.op = "update"; this.payload = patch; this.wantRows = false; return this; }

  then<T1, T2>(ok?: ((v: { data: any; error: any }) => T1 | PromiseLike<T1>) | null, bad?: ((e: any) => T2 | PromiseLike<T2>) | null): PromiseLike<T1 | T2> {
    return Promise.resolve(this.shape(this.run())).then(ok as any, bad as any);
  }

  private shape(r: { data: any; error: any }): { data: any; error: any } {
    if (!this.one || r.error) return r;
    const first = Array.isArray(r.data) ? r.data[0] : r.data;
    if (!first && this.one === "single") return { data: null, error: { message: "no rows", code: "PGRST116" } };
    return { data: first ?? null, error: null };
  }

  private run(): { data: any; error: any } {
    const t = this.table;
    const known = t in this.db.tables;
    this.db.touched.push({ kind: "from", name: t, op: this.op });
    if (t === "settings_public") {
      if (this.op !== "select") return { data: null, error: { message: "permission denied", code: "42501" } };
      return { data: this.db.settingsPublic.map((r) => ({ ...r })), error: null };
    }
    if (!known) {
      const rows = (this.db.extra[t] ??= []);
      if (this.op === "insert") { const row = { id: this.db.uuid(), created_at: this.db.now().toISOString(), ...this.payload }; rows.push(row); return { data: [{ ...row }], error: null }; }
      const hit = rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.head) return { data: null, error: null, count: hit.length } as any;
      return { data: hit.map((r) => ({ ...r })), error: null, ...(this.countMode ? { count: hit.length } : {}) } as any;
    }
    if (this.op !== "select" && !DIRECT_WRITE_OK.has(t)) return { data: null, error: { message: "permission denied for table", code: "42501" } };
    const rows = this.db.tables[t];
    if (this.op === "insert") {
      const row = { id: this.db.uuid(), created_at: this.db.now().toISOString(), updated_at: this.db.now().toISOString(), is_active: true, archived: false, ...this.payload };
      if (t === "invoice_item_types" && rows.some((r) => r.name_ar.trim().toLowerCase() === String(row.name_ar).trim().toLowerCase())) return { data: null, error: { message: "duplicate", code: "23505" } };
      rows.push(row);
      return { data: [{ ...row }], error: null };
    }
    let hit = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "update") { for (const r of hit) Object.assign(r, this.payload); return { data: hit.map((r) => ({ ...r })), error: null }; }
    for (const [col, asc] of [...this.orderBy].reverse()) hit = [...hit].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
    if (this.slice) hit = hit.slice(this.slice[0], this.slice[1] + 1);
    if (this.max !== null) hit = hit.slice(0, this.max);
    return { data: hit.map((r) => ({ ...r })), error: null };
  }
}
