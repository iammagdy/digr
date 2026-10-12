import type { Metadata, Viewport } from "next";
import { Markazi_Text, Vazirmatn } from "next/font/google";
import { AuthProvider } from "@/hooks/useUser";
import { THEME_INIT_SCRIPT, ThemeProvider } from "@/lib/theme";
import "./globals.css";

const vazirmatn = Vazirmatn({
  subsets: ["arabic", "latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-vazirmatn",
  display: "swap",
});

const markazi = Markazi_Text({
  subsets: ["arabic", "latin"],
  weight: ["500", "600"],
  variable: "--font-markazi",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Digr — بيانات عامة جاهزة للتحليل",
  description:
    "منصة عربية ذكية لاستخراج مجموعات البيانات العامة وتجهيزها للتحليل في ملفات Excel و PDF مع دليل المتغيرات ومنهجية الجمع.",
  icons: { icon: "/favicon.svg", apple: "/brand/digr-app-icon.svg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf8f4" },
    { media: "(prefers-color-scheme: dark)", color: "#111413" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ar" dir="rtl" className={`${vazirmatn.variable} ${markazi.variable} h-full`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col bg-bg text-ink2 antialiased selection:bg-gold/30 selection:text-ink">
        <ThemeProvider>
          <AuthProvider>{children}</AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
