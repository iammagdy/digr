import type { Metadata } from "next";
import LegalPage from "@/components/LegalPage";
import { PRIVACY } from "@/lib/legalText";

export const metadata: Metadata = { title: "سياسة الخصوصية" };

export default function PrivacyPage() {
  return <LegalPage tab="privacy" title="سياسة الخصوصية" sections={PRIVACY} />;
}
