import type { Metadata } from "next";
import ContactForm from "./ContactForm";

export const metadata: Metadata = { title: "تواصل معنا", description: "اكتب لنا مشكلتك أو سؤالك وسنرد عليك على بريدك الإلكتروني." };

export default function ContactPage() {
  return <ContactForm />;
}
