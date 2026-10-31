import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import type { AdminContext } from "@/lib/server/adminAuth";
import { InvoiceError, readPricingSettings, type InvoiceDb, type PricingSettings } from "./service";

/** The service-role client, used only AFTER the route's own admin check. */
export const invoiceDb = (): InvoiceDb => createAdminClient() as unknown as InvoiceDb;

export async function readBody(req: Request): Promise<unknown> {
  try { return await req.json(); } catch { return null; }
}

export const isUuid = (v: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** One read-only look at the public pricing row through the admin adapter (Instapay address, point value). */
export function pricingOf(ctx: AdminContext): Promise<PricingSettings> {
  return readPricingSettings(() => ctx.tables.getRow({ databaseId: "digr", tableId: "settings_public", rowId: "pricing" }));
}

export function invoiceErrorResponse(e: unknown): NextResponse {
  if (e instanceof InvoiceError) return NextResponse.json({ error: e.message, code: e.code, ...(e.extra ?? {}) }, { status: e.status });
  return NextResponse.json({ error: "تعذّر تنفيذ العملية الآن. أعد المحاولة بعد قليل." }, { status: 500 });
}

export const badRequest = (message: string) => NextResponse.json({ error: message }, { status: 400 });
export const notFound = () => NextResponse.json({ error: "غير موجود." }, { status: 404 });
