import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { AuthProvider } from "@/hooks/useUser";
import { THEME_INIT_SCRIPT, ThemeProvider } from "@/lib/theme";
import { SITE_NAME, SITE_URL } from "@/lib/site";
import "./globals.css";

// Fonts are committed in src/app/fonts so the build never fetches them from Google.
const vazirmatn = localFont({
  src: [{ path: "./fonts/Vazirmatn-Variable.woff2", weight: "200 700", style: "normal" }],
  variable: "--font-vazirmatn",
  display: "swap",
});

const markazi = localFont({
  src: [
    { path: "./fonts/MarkaziText-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/MarkaziText-600.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-markazi",
  display: "swap",
});

const TITLE = "ديجر — مصادر متاحة جاهزة للتحليل";
const DESCRIPTION =
  "منصة عربية ذكية لاستخراج مجموعات البيانات من المصادر المتاحة وتجهيزها للتحليل في ملفات Excel و PDF مع دليل المتغيرات ومنهجية الجمع.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: TITLE, template: "%s — ديجر" },
  description: DESCRIPTION,
  applicationName: SITE_NAME,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: SITE_NAME,
    locale: "ar_EG",
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "ديجر — ماذا تريد أن تعرف؟" }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og-image.png"] },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
    apple: "/apple-touch-icon.png",
  },
  manifest: "/site.webmanifest",
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
    <html lang="ar" dir="rtl" translate="no" className={`${vazirmatn.variable} ${markazi.variable} h-full notranslate`} suppressHydrationWarning>
      <head>
        <meta name="google" content="notranslate" />
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
