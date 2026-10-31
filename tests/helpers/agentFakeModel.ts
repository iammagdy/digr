import type { ContentBlock } from "../../src/lib/invoices/chat/prompt";

/**
 * A SCRIPTED stand-in for the model (tests and the browser demo only: no real model call is ever made from a session). It reads the real request the server builds
 * (the masked payload) and answers the way the instructions ask: column LETTERS by header and statistics, and actions for the owner's examples.
 * Because it only sees what the model would see, a test through it proves the real model gets enough to do the job; it cannot prove the real model does it.
 */
const ROLE_RE: Array<[string, RegExp]> = [
  ["sector", /^(القطاع|النشاط)$/],
  ["company_en", /^(english|company name|اسم الشركة بالإنجليزية)$/i],
  ["company", /(اسم الشركة|^الشركة$|^شركة$)/],
  ["manager", /(المدير|المسؤول|المسئول|جهة الاتصال)/],
  ["email", /(البريد|الايميل|الإيميل|e-?mail)/i],
  ["phone", /(الهاتف|تليفون|التليفون|الموبايل|رقم الموبايل|phone|mobile)/i],
];

const digitsOf = (s: string) => s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));

export function fakeAgentReply(content: ContentBlock[]): string {
  const payload = JSON.parse((content[0] as { text: string }).text);
  const message: string = digitsOf(payload.owner_message ?? "");
  const out: { say?: string; mapping?: unknown[]; image_counts?: unknown[]; actions: unknown[] } = { actions: [] };

  if (payload.files?.length) {
    out.mapping = [];
    // like the model did live: ONE sheet per file is mapped (the first with a list); the code looks at the others and infers or asks
    for (const f of payload.files) for (const s of f.sheets) {
      const columns: Record<string, string> = {};
      for (const c of s.columns) for (const [role, re] of ROLE_RE) if (!columns[role] && re.test(c.header)) { columns[role] = c.col; break; }
      if (!columns.company && !columns.manager && !columns.email && !columns.phone) continue;
      out.mapping.push({ file: f.file, sheet: s.sheet, sector_name: columns.sector ? null : f.file.replace(/\.[A-Za-z0-9]+$/, ""), columns });
      break;
    }
    out.say = "لقيت الملفات ورتبت الأعمدة. راجع الأعداد وقل تمام.";
  }
  if (payload.images?.length) {
    out.image_counts = [{ image: payload.images[0], sector: "مقاولات", item_type: "company", quantity: 42 }, { image: payload.images[0], sector: "مقاولات", item_type: "manager", quantity: 30 }];
    out.say = "قرأت الصورة تقريبيًا. راجع الأعداد.";
  }
  const rate = /(?:الدولار|سعر الصرف)[^\d]*(\d+(?:\.\d+)?)/.exec(message);
  if (rate) out.actions.push({ action: "set_rate", egp_per_usd: Number(rate[1]) });
  if (/بالنقاط/.test(message) && !/الإجمالي/.test(message)) out.actions.push({ action: "set_currencies", points: true });
  const total = /(?:الإجمالي|الاجمالي)\s*(\d+(?:\.\d+)?)\s*(دولار|نقطة|جنيه)/.exec(message);
  if (total) out.actions.push({ action: "set_target_total", amount: Number(total[1]), currency: total[2] === "دولار" ? "usd" : total[2] === "نقطة" ? "points" : "egp" });
  const price = /سعر\s*(الشركة|المدير)\s*(\d+(?:\.\d+)?)\s*(سنت|دولار|نقطة)/.exec(message);
  if (price) out.actions.push({ action: "set_unit_price", item_type: price[1] === "الشركة" ? "company" : "manager", value: price[3] === "سنت" ? Number(price[2]) / 100 : Number(price[2]), unit: price[3] === "نقطة" ? "points" : "usd" });
  if (/صفحة واحدة/.test(message)) out.actions.push({ action: "set_layout", max_pages: 1 });
  if (/ملخص (المراحل|القطاعات)/.test(message)) out.actions.push({ action: "set_layout", show_phase_summary: true });
  if (/الأرقام المخفية/.test(message)) out.actions.push({ action: "set_layout", unhide_all: true });
  if (/فاتورة/.test(message) && /اعمل/.test(message)) out.actions.push({ action: "set_doc_type", doc_type: "invoice" });
  const sector = /ضيف قطاع\s+(\S+)\s+(\d+)\s*شركة/.exec(message);
  if (sector) out.actions.push({ action: "add_sector", name: sector[1], counts: { company: Number(sector[2]) } });
  if (/ابعت/.test(message) && /الفاتورة/.test(message)) { out.say = "الإرسال بيتم بزرار «إرسال» من عندك."; out.actions = []; }
  return JSON.stringify(out);
}
