import type { Metadata } from "next";
import { AuthProvider } from "@/hooks/useUser";
import "./globals.css";

export const metadata: Metadata = {
  title: "Digr — بيانات جاهزة للتحليل",
  description:
    "منصة عربية لطلب مجموعات بيانات جاهزة للتحليل، مصممة للباحثين والإحصائيين والطلاب.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ar" dir="rtl">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
