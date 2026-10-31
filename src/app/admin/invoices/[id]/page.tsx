"use client";

import { useParams } from "next/navigation";
import { InvoiceBuilder } from "@/components/admin/invoices/InvoiceBuilder";

export default function AdminInvoicePage() {
  const { id } = useParams<{ id: string }>();
  return <InvoiceBuilder id={id} />;
}
