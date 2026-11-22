import type { Metadata } from "next";
import LegalPage from "@/components/LegalPage";
import { REFUNDS_INTRO, REFUNDS_SECTIONS } from "@/lib/legalText";

export const metadata: Metadata = { title: "سياسة الرصيد وإلغاء الطلبات" };

export default function RefundsPage() {
  return <LegalPage tab="refunds" title="سياسة الرصيد وإلغاء الطلبات" intro={REFUNDS_INTRO} sections={REFUNDS_SECTIONS} />;
}
