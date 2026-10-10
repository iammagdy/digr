import type { Metadata, Viewport } from "next";
import { AuthProvider } from "@/hooks/useUser";
import "./globals.css";

export const metadata: Metadata = {
  title: "Digr — بيانات عامة جاهزة للتحليل",
  description:
    "منصة عربية ذكية لاستخراج مجموعات البيانات العامة وتجهيزها للتحليل في ملفات Excel و PDF مع دليل المتغيرات ومنهجية الجمع.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  themeColor: "#faf9f6",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ar" dir="rtl" className="h-full">
      <body className="min-h-full flex flex-col bg-sand-50 text-ink-800 antialiased selection:bg-amber-100 selection:text-amber-900">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
