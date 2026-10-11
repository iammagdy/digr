import type { Metadata, Viewport } from "next";
import { Markazi_Text, Vazirmatn } from "next/font/google";
import { ThemeProvider } from "@/components/ThemeProvider";
import { AuthProvider } from "@/hooks/useUser";
import { themeInitializationScript } from "@/lib/theme";
import "./globals.css";

const vazirmatn = Vazirmatn({
  subsets: ["arabic", "latin"],
  weight: ["300", "400", "500", "600"],
  display: "swap",
  variable: "--font-vazirmatn",
});

const markaziText = Markazi_Text({
  subsets: ["arabic", "latin"],
  weight: ["500", "600"],
  display: "swap",
  variable: "--font-markazi",
});

export const metadata: Metadata = {
  title: "Digr — بيانات عامة جاهزة للتحليل",
  description:
    "منصة عربية ذكية لاستخراج مجموعات البيانات العامة وتجهيزها للتحليل في ملفات Excel و PDF مع دليل المتغيرات ومنهجية الجمع.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FAF8F4" },
    { media: "(prefers-color-scheme: dark)", color: "#111413" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ar" dir="rtl" className={`${vazirmatn.variable} ${markaziText.variable} h-full`} data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitializationScript }} />
      </head>
      <body className="min-h-full flex flex-col bg-sand-50 text-ink-800 antialiased selection:bg-gold/30 selection:text-foreground">
        <ThemeProvider>
          <AuthProvider>{children}</AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
