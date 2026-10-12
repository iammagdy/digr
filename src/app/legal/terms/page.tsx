import type { Metadata } from "next";
import LegalPage from "@/components/LegalPage";
import { TERMS } from "@/lib/legalText";

export const metadata: Metadata = { title: "الشروط والأحكام — Digr" };

export default function TermsPage() {
  return <LegalPage tab="terms" title="الشروط والأحكام" sections={TERMS} />;
}
