/** Icon paths from the Admin design (24×24, stroke 1.7). */
export const ADMIN_IC = {
  overview: "M4 13h6V4H4zM14 20h6v-9h-6zM14 4v4h6V4zM4 20h6v-4H4z",
  users: "M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM22 19v-1a4 4 0 0 0-3-3.87M16 4.13a3 3 0 0 1 0 5.74",
  topups: "M3 6h18v12H3zM3 10h18M7 15h4",
  jobs: "M4 6h16M4 12h16M4 18h10",
  visitors: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  operations: "M3 12h4l3-8 4 16 3-8h4",
  conference: "M3 20h18M6 20V9M12 20V4M18 20v-8",
  export: "M12 3v12m0 0l-4-4m4 4l4-4M4 17v3h16v-3",
  finance: "M4 20V4M4 20h16M8 15l3-4 3 2 5-6",
  "calls-log": "M4 4h16v16H4zM4 9h16M9 9v11M14 14h3",
  providers: "M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4 12h2M18 12h2M12 4v2M12 18v2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  "promo-codes": "M20 12l-8 8-9-9V4h7zM7.5 8.5h.01",
  support: "M4 5h16v11H8l-4 4zM8 10h8M8 13h5",
  audit: "M9 4h6l1 2h3v15H5V6h3zM9 11h6M9 15h4",
  requests: "M12 17v.01M12 13.5a2.5 2.5 0 1 0-2.5-2.5M4 4h16v13H8l-4 4z",
  alert: "M12 8v5M12 16.5v.5M10.3 4l-8 14a2 2 0 0 0 1.7 3h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0z",
  signup: "M15 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M8.5 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 8v6M22 11h-6",
  pay: "M3 6h18v12H3zM3 10h18",
  check: "M5 12l5 5 9-10",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-3.5-3.5",
  sun: "M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z",
  "planner-selftest": "M9 3h6M10 3v6L5 19a1.5 1.5 0 001.3 2h11.4A1.5 1.5 0 0019 19l-5-10V3M8 15h8",
  failures: "M12 3 2.5 20h19L12 3ZM12 10v4.5M12 17.5v.5",
  "reverse-lookup": "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-3.5-3.5M9 11h4",
  moon: "M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z",
} as const;

export type AdminPageId = "overview" | "users" | "topups" | "jobs" | "operations" | "finance" | "promo-codes" | "support" | "providers" | "calls-log" | "audit" | "settings" | "requests" | "conference" | "export" | "visitors" | "reverse-lookup" | "planner-selftest" | "failures";

export const ADMIN_PAGES: Array<[AdminPageId, string]> = [
  ["overview", "نظرة عامة"], ["users", "المستخدمون"], ["topups", "طلبات الشحن"], ["jobs", "عمليات البحث"], ["visitors", "الزوّار"], ["operations", "التشغيل"],
  ["finance", "الإيرادات والأرباح"], ["promo-codes", "الأكواد الترويجية"], ["support", "رسائل الدعم"], ["providers", "مزودو الخدمة"], ["calls-log", "سجل الاستدعاءات"], ["audit", "سجل العمليات"], ["requests", "طلبات غير مدعومة"], ["conference", "لوحة المؤتمر"], ["reverse-lookup", "بحث عكسي"], ["planner-selftest", "فحص المخطط"], ["failures", "لوحة الأعطال"], ["settings", "الإعدادات"], ["export", "نسخة احتياطية"],
];

export const adminHref = (id: AdminPageId) => (id === "overview" ? "/admin" : `/admin/${id}`);

export function AIcon({ d, size = 18, stroke = 1.7 }: { d: string; size?: number; stroke?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
