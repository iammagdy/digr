"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { InvoiceBuilder } from "@/components/admin/invoices/InvoiceBuilder";

function NewDocument() {
  const type = useSearchParams().get("type") === "quote" ? "quote" : "invoice";
  return <InvoiceBuilder initialType={type} />;
}

export default function AdminNewInvoicePage() {
  return <Suspense fallback={<p className="text-[13px] text-mut">جارٍ التحميل…</p>}><NewDocument /></Suspense>;
}
