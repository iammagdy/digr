import type { Metadata } from "next";
import ContactForm from "./ContactForm";
import { loadSupportSettings } from "@/lib/server/supportSettings";

export const metadata: Metadata = { title: "تواصل معنا", description: "اكتب لنا مشكلتك أو سؤالك وسنرد عليك على بريدك الإلكتروني." };
// The contact details come from the admin settings on every request, so the first paint already has them.
export const dynamic = "force-dynamic";

export default async function ContactPage() {
  return <ContactForm initialSettings={await loadSupportSettings()} />;
}
