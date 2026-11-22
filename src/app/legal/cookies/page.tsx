import type { Metadata } from "next";
import LegalPage from "@/components/LegalPage";
import { COOKIES_INTRO, COOKIES_SECTIONS } from "@/lib/legalText";

export const metadata: Metadata = { title: "إشعار ملفات تعريف الارتباط" };

export default function CookiesPage() {
  return <LegalPage tab="cookies" title="إشعار ملفات تعريف الارتباط وتقنيات التخزين" intro={COOKIES_INTRO} sections={COOKIES_SECTIONS} />;
}
