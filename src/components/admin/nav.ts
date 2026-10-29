import type { AdminPageId } from "./icons";

/**
 * The admin menu as sections. `ADMIN_PAGES` (icons.tsx) stays the flat list of every page with its title; this file only groups the same ids.
 * No route moved: every page keeps its `/admin/<id>` address, so every old link still opens the same page.
 * Sections are ordered most used first, and so are the pages inside each section.
 */
export interface AdminGroup { id: string; label: string; pages: AdminPageId[] }

export const ADMIN_GROUPS: AdminGroup[] = [
  { id: "overview", label: "نظرة عامة", pages: ["overview", "operations", "conference", "visitors"] },
  { id: "customers", label: "العملاء والطلبات", pages: ["users", "jobs", "support", "requests"] },
  { id: "money", label: "الفلوس والشحن", pages: ["topups", "finance", "promo-codes"] },
  { id: "providers", label: "المزودون والمفاتيح", pages: ["providers", "calls-log"] },
  { id: "agent", label: "الوكيل والجودة", pages: ["agent", "failures", "planner-selftest", "reverse-lookup"] },
  { id: "settings", label: "الإعدادات", pages: ["settings", "audit", "export"] },
];

/** One calm sentence under each page title: what the page is for. */
export const ADMIN_PAGE_INFO: Record<AdminPageId, string> = {
  overview: "ملخص الأرقام والنشاط في الفترة المختارة.",
  operations: "ما يعمل الآن، وما تعطّل، وطابور المهام، وما يحتاج انتباهك.",
  conference: "لوحة حيّة تتجدد كل عشر ثوانٍ: التسجيلات والمحادثات النشطة والمزود وطلبات الشحن.",
  visitors: "زيارات الموقع: عددها وأجهزة الزوّار وبلدانهم.",
  users: "كل العملاء وأرصدتهم وحساباتهم.",
  jobs: "عمليات البحث التي طلبها العملاء وحالة كل واحدة.",
  support: "الرسائل التي أرسلها العملاء إلى الدعم.",
  requests: "ما طلبه العملاء ولا نبيعه حاليًا.",
  topups: "طلبات الشحن التي تنتظر الاعتماد أو الرفض.",
  finance: "الإيرادات والتكاليف والأرباح شهرًا بشهر.",
  "promo-codes": "إنشاء الأكواد الترويجية ومتابعة من استخدمها.",
  providers: "حالة كل مزود ورصيده ومفاتيحه وحدوده وسجل مكالماته.",
  "calls-log": "كل المكالمات التي أجرتها المنصة مع المزودين وتكلفة كل واحدة.",
  agent: "تشغيل مهام الوكيل ومتابعتها.",
  failures: "كل ما فشل أو رجع فارغًا في آخر سبعة أيام، مع إعادة التجربة.",
  "planner-selftest": "فحص المخطط على طلبات جاهزة دون أي خصم من العملاء.",
  "reverse-lookup": "بحث عن شخص برقم هاتف أو بريد إلكتروني.",
  settings: "سعر النقطة وحدود الشحن وبيانات الدعم وفريق الإدارة.",
  audit: "من فعل ماذا ومتى في لوحة الإدارة. لا يُعدَّل ولا يُحذف.",
  export: "نسخة احتياطية للقراءة فقط من الجداول.",
};

export const adminGroupOf = (id: AdminPageId): AdminGroup => ADMIN_GROUPS.find((g) => g.pages.includes(id)) ?? ADMIN_GROUPS[0];

/** The four pages on the phone's bottom bar; every other page is one tap away under «المزيد». */
export const BOTTOM_BAR_PAGES: AdminPageId[] = ["overview", "users", "topups", "providers"];

/** Every admin address that existed before the reorganisation. A page must keep answering at its old address. */
export const ADMIN_LEGACY_ROUTES = [
  "/admin", "/admin/users", "/admin/topups", "/admin/jobs", "/admin/visitors", "/admin/operations", "/admin/finance", "/admin/promo-codes", "/admin/support",
  "/admin/providers", "/admin/calls-log", "/admin/audit", "/admin/requests", "/admin/conference", "/admin/reverse-lookup", "/admin/planner-selftest",
  "/admin/failures", "/admin/agent", "/admin/settings", "/admin/export",
] as const;
