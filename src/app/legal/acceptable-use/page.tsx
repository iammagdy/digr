import type { Metadata } from "next";
import LegalPage from "@/components/LegalPage";
import { ACCEPTABLE_USE_INTRO, ACCEPTABLE_USE_SECTIONS } from "@/lib/legalText";

export const metadata: Metadata = { title: "سياسة الاستخدام المقبول" };

export default function AcceptableUsePage() {
  return <LegalPage tab="acceptable-use" title="سياسة الاستخدام المقبول وضوابط المصادر المتاحة" intro={ACCEPTABLE_USE_INTRO} sections={ACCEPTABLE_USE_SECTIONS} />;
}
