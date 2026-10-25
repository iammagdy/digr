/**
 * Platform email templates (Arabic). EVERY template is built by ONE base layout (`layout()` below), so all e-mails look and behave the same:
 *
 *  - right-to-left and right-aligned on the wrapper table and on every cell (many mail clients drop the attributes of <html>);
 *  - the brand mark at the top, on a small light rounded background so it stays visible in dark-mode clients (the mark is dark teal on transparent).
 *    The light background is on the cell AND on the image itself: a client that recolours cell backgrounds does not recolour an image;
 *  - a card: optional status chip, heading, short Arabic body, optional boxed reason, a label/value table, ONE primary button, an optional note;
 *  - a footer: the customer's preferences footer for customer e-mails, the admin footer only for admin e-mails; the support address and the platform line stay.
 *
 * Inline CSS only, table-based, no external fonts, images other than the brand mark, or scripts. The light colours are written out (never left to
 * prefers-color-scheme), and `color-scheme` is declared as light only, so a client does not recolour the card unpredictably.
 *
 * Supabase Edge Function port (Deno). Runs under supabase/functions/send-email/. The sending transport is Resend (see index.ts), NOT Appwrite
 * Messaging (Appwrite is cancelled). renderEmailTemplate() substitutes the {{ .Var }} tokens with HTML-escaped values.
 * The variables of every template are unchanged (new ones can only be added as optional), so the function and the app can be deployed at different times.
 */

export type PlatformEmailTemplateId =
  | "welcome"
  | "topup-received"
  | "topup-approved"
  | "topup-rejected"
  | "job-done"
  | "refund"
  | "job-update"
  | "admin-topup-alert";

export const PLATFORM_EMAIL_SUBJECTS: Record<PlatformEmailTemplateId, string> = {
  "welcome": `أهلًا {{ .Name }} — حسابك على ديجر جاهز`,
  "topup-received": `استلمنا طلب شحن {{ .AmountEgp }} ج.م`,
  "topup-approved": `أُضيف {{ .Credits }} نقطة إلى رصيدك`,
  "topup-rejected": `تعذّر اعتماد طلب الشحن`,
  "job-done": `ملفاتك جاهزة: {{ .JobTitle }}`,
  "refund": `حجز مؤقت مُحرَّر بقيمة {{ .Points }} نقطة`,
  // A status update of a long job (started, stalled, partially completed): the words come from the caller, in plain Arabic.
  "job-update": `{{ .Subject }}`,
  // The owner's alert for a new top-up request (sent by the app to the address in ADMIN_ALERT_EMAIL).
  "admin-topup-alert": `طلب شحن جديد: {{ .Points }} نقطة`,
};

/* ───────────── the base layout ───────────── */

const FONT = "Tahoma, Arial, Helvetica, sans-serif";
const PAGE_BG = "#F3F0E8";
const CARD_BG = "#FFFDF9";
const LINE = "#E6E1D7";
const INK = "#16201F";
const BODY = "#3A4241";
const MUTED = "#6F716C";
/** Footer and note text: 5:1 or better on both the page and the card (the earlier #8A8880 was 3.1:1 on the page). */
const SUBTLE = "#66685F";
const BRAND = "#0E3B43";

type Tone = "pending" | "ok" | "bad";
/** background, text: every pair is at least 4.5:1. */
const TONES: Record<Tone, [string, string]> = {
  pending: ["#F6EEDD", "#8A6420"],
  ok: ["#E8F2EC", "#2F6B4A"],
  bad: ["#FBECE9", "#B4382B"],
};

interface Fact { label: string; value: string; ltr?: boolean }
interface LayoutOptions {
  /** `customer`: the preferences footer. `admin`: the admin footer only. */
  audience: "customer" | "admin";
  /** The hidden line a mail list shows next to the subject. */
  preheader: string;
  chip?: { text: string; tone: Tone };
  heading: string;
  /** Short body paragraphs (tokens allowed). */
  paragraphs?: string[];
  /** A boxed reason (a rejection, a released hold). */
  reason?: { text: string; tone: Tone };
  /** Label/value table of facts. */
  facts?: Fact[];
  /** The ONE primary button. */
  button?: { href: string; label: string };
  /** A small note under the button (may hold a link). */
  note?: string;
}

const PRELUDE_PAD = "&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;";
const LABEL_STYLE = `padding:11px 0;border-bottom:1px solid ${LINE};font-family:${FONT};font-size:13px;line-height:20px;color:${MUTED};text-align:right`;
const VALUE_STYLE = `padding:11px 0;border-bottom:1px solid ${LINE};font-family:${FONT};font-size:14px;line-height:20px;font-weight:700;color:${INK}`;
const factRow = ({ label, value, ltr = false }: Fact) =>
  `<tr><td style="${LABEL_STYLE}" width="38%">${label}</td><td ${ltr ? 'dir="ltr" ' : 'dir="rtl" '}style="${VALUE_STYLE};text-align:${ltr ? "left" : "right"}">${value}</td></tr>`;

function layout(id: PlatformEmailTemplateId, o: LayoutOptions): string {
  const chip = o.chip
    ? `<table role="presentation" dir="rtl" cellpadding="0" cellspacing="0" border="0" align="right" style="margin:0 0 18px"><tr><td dir="rtl" bgcolor="${TONES[o.chip.tone][0]}" style="background:${TONES[o.chip.tone][0]};border-radius:999px;padding:5px 12px;font-family:${FONT};font-size:12px;line-height:16px;font-weight:700;color:${TONES[o.chip.tone][1]};text-align:right">${o.chip.text}</td></tr></table><div style="clear:both;line-height:0;font-size:0">&nbsp;</div>`
    : "";
  const paragraphs = (o.paragraphs ?? [])
    .map((text) => `<p dir="rtl" style="margin:0 0 14px;font-family:${FONT};font-size:15px;line-height:26px;mso-line-height-rule:exactly;color:${BODY};text-align:right">${text}</p>`)
    .join("");
  const reason = o.reason
    ? `<table role="presentation" dir="rtl" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 20px"><tr><td dir="rtl" bgcolor="${TONES[o.reason.tone][0]}" style="background:${TONES[o.reason.tone][0]};border-radius:14px;padding:14px 16px;font-family:${FONT};font-size:13px;line-height:22px;color:${TONES[o.reason.tone][1]};text-align:right"><strong>السبب:</strong> ${o.reason.text}</td></tr></table>`
    : "";
  const facts = o.facts?.length
    ? `<table role="presentation" dir="rtl" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 22px;border-top:1px solid ${LINE}">${o.facts.map(factRow).join("")}</table>`
    : "";
  const button = o.button
    ? `<table role="presentation" dir="rtl" cellpadding="0" cellspacing="0" border="0" align="right" style="margin:8px 0 22px"><tr><td dir="rtl" bgcolor="${BRAND}" style="background:${BRAND};border-radius:999px;mso-padding-alt:14px 30px"><a href="${o.button.href}" target="_blank" style="display:block;padding:14px 30px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:700;color:#FAF8F4;text-decoration:none;border-radius:999px">${o.button.label}</a></td></tr></table><div style="clear:both;line-height:0;font-size:0">&nbsp;</div>`
    : "";
  const note = o.note
    ? `<p dir="rtl" style="margin:0;font-family:${FONT};font-size:12px;line-height:20px;color:${SUBTLE};text-align:right">${o.note}</p>`
    : "";
  const platformLine = `ديجر (Diger) — مصادر متاحة جاهزة للتحليل · القاهرة، مصر · <a href="mailto:support@diger.tech" style="color:${SUBTLE};text-decoration:underline">support@diger.tech</a>`;
  const footer = o.audience === "admin"
    ? `تنبيه داخلي للإدارة: يصل هذا البريد عند وصول كل طلب شحن جديد.<br>\n${platformLine}`
    : `تصلك هذه الرسالة لأنك فعّلت إشعارات البريد. <a href="{{ .SiteURL }}/dashboard/settings" style="color:${SUBTLE};text-decoration:underline">غيّر تفضيلاتك</a>.<br>\n${platformLine}`;

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${PLATFORM_EMAIL_SUBJECTS[id]}</title>
<!--[if mso]><style>table,td,p,a,h1{font-family:Tahoma,Arial,sans-serif!important}</style><![endif]-->
<style>
@media only screen and (max-width:620px){.card{padding:28px 20px!important}.h1{font-size:23px!important;line-height:32px!important} }
</style>
</head>
<body dir="rtl" style="margin:0;padding:0;background:${PAGE_BG};direction:rtl;text-align:right;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">${o.preheader}${PRELUDE_PAD}</div>
<table role="presentation" class="bgw" dir="rtl" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE_BG}" style="background:${PAGE_BG};direction:rtl">
<tr><td dir="rtl" align="center" style="padding:32px 12px 40px">
<!--[if mso]><table role="presentation" dir="rtl" width="560" cellpadding="0" cellspacing="0" border="0"><tr><td dir="rtl" align="right"><![endif]-->
<table role="presentation" dir="rtl" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;direction:rtl">
<tr><td dir="rtl" align="right" style="padding:0 6px 18px;text-align:right"><table role="presentation" dir="rtl" align="right" cellpadding="0" cellspacing="0" border="0"><tr><td dir="rtl" bgcolor="#FFFFFF" style="background:#FFFFFF;border:1px solid ${LINE};border-radius:14px;padding:0"><a href="{{ .SiteURL }}" style="text-decoration:none"><img src="{{ .SiteURL }}/email/digr-wordmark.png" width="104" alt="Diger ديجر" style="display:block;width:104px;height:auto;padding:8px 14px;background:#FFFFFF;border-radius:13px;border:0;outline:none;text-decoration:none;font-family:${FONT};font-size:20px;font-weight:700;color:${BRAND}"></a></td></tr></table></td></tr>
<tr><td class="card" dir="rtl" align="right" bgcolor="${CARD_BG}" style="background:${CARD_BG};border:1px solid ${LINE};border-radius:20px;padding:36px 32px;text-align:right">
${chip}<h1 class="h1" dir="rtl" style="margin:0 0 14px;font-family:${FONT};font-size:26px;line-height:36px;mso-line-height-rule:exactly;font-weight:700;color:${INK};text-align:right">${o.heading}</h1>${paragraphs}${reason}${facts}${button}${note}
</td></tr>
<tr><td dir="rtl" align="right" style="padding:20px 8px 0;text-align:right;font-family:${FONT};font-size:12px;line-height:20px;color:${SUBTLE}">
${footer}
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
}

/* ───────────── the templates ───────────── */

const PLATFORM_EMAIL_TEMPLATES: Record<PlatformEmailTemplateId, string> = {
  "welcome": layout("welcome", {
    audience: "customer",
    preheader: "ثلاث خطوات وتستلم أول ملف بيانات: اشحن، اسأل، وافق.",
    heading: "أهلًا {{ .Name }}، حسابك جاهز",
    paragraphs: ["ديجر يحوّل سؤالك البحثي إلى ملفات جاهزة للتحليل. هكذا تبدأ:"],
    facts: [
      { label: "١ · اشحن رصيدك", value: "عبر إنستاباي" },
      { label: "٢ · اسأل بالعربية", value: "والمساعد يحدد التفاصيل" },
      { label: "٣ · وافق على السعر", value: "وتدفع على المسلَّم فقط" },
    ],
    button: { href: "{{ .SiteURL }}/dashboard/chat", label: "ابدأ أول بحث" },
    note: "النقطة الواحدة = ٠٫١٠ ج.م، وأي حجز مؤقت مُحرَّر لا يُخصم منك.",
  }),
  "topup-received": layout("topup-received", {
    audience: "customer",
    preheader: "طلبك قيد المراجعة — سنبلغك فور اعتماد النقاط.",
    chip: { text: "قيد المراجعة", tone: "pending" },
    heading: "استلمنا طلب الشحن",
    paragraphs: ["أهلًا {{ .Name }}، سيراجع فريقنا التحويل ويعتمد النقاط في محفظتك. {{ .ReviewNote }}"],
    facts: [
      { label: "المبلغ المحوّل", value: "{{ .AmountEgp }} ج.م" },
      { label: "النقاط المتوقعة", value: "{{ .Credits }} نقطة" },
      { label: "تاريخ الطلب", value: "{{ .CreatedAt }}" },
    ],
    button: { href: "{{ .SiteURL }}/dashboard/topup", label: "متابعة الطلب" },
    note: "النقاط النهائية تُحسب من المبلغ الذي يؤكده فريق الإدارة.",
  }),
  "topup-approved": layout("topup-approved", {
    audience: "customer",
    preheader: "تم اعتماد شحنك — رصيدك جاهز لأبحاثك.",
    chip: { text: "تم الاعتماد", tone: "ok" },
    heading: "رصيدك جاهز",
    paragraphs: ["أهلًا {{ .Name }}، راجعنا التحويل وأضفنا النقاط إلى محفظتك."],
    facts: [
      { label: "النقاط المضافة", value: "+{{ .Credits }} نقطة" },
      { label: "المبلغ المؤكد", value: "{{ .ConfirmedAmountEgp }} ج.م" },
      { label: "رصيدك الآن", value: "{{ .Balance }} نقطة" },
    ],
    button: { href: "{{ .SiteURL }}/dashboard/chat", label: "ابدأ بحثًا" },
  }),
  "topup-rejected": layout("topup-rejected", {
    audience: "customer",
    preheader: "راجع سبب الرفض وأرسل طلبًا جديدًا ببيانات صحيحة.",
    chip: { text: "لم يُعتمد", tone: "bad" },
    heading: "تعذّر اعتماد طلب الشحن",
    paragraphs: ["أهلًا {{ .Name }}، راجعنا طلبك ولم نتمكن من اعتماده."],
    reason: { text: "{{ .RejectReason }}", tone: "bad" },
    facts: [{ label: "المبلغ", value: "{{ .AmountEgp }} ج.م" }],
    button: { href: "{{ .SiteURL }}/dashboard/topup", label: "إرسال طلب جديد" },
    note: `لو تم خصم المبلغ من حسابك البنكي، راسلنا على <a href="mailto:support@diger.tech" style="color:${SUBTLE}">support@diger.tech</a> ومعك صورة الإيصال.`,
  }),
  "job-done": layout("job-done", {
    audience: "customer",
    preheader: "اكتمل بحثك — ملفات إكسل وبي دي إف وسي إس في جاهزة للتحميل.",
    chip: { text: "اكتمل", tone: "ok" },
    heading: "ملفاتك جاهزة",
    paragraphs: ["أهلًا {{ .Name }}، اكتمل بحث «{{ .JobTitle }}»."],
    facts: [
      { label: "السجلات المسلَّمة", value: "{{ .Delivered }} من {{ .Requested }}" },
      { label: "النقاط المخصومة", value: "{{ .Charged }} نقطة" },
      { label: "حجز مؤقت مُحرَّر", value: "{{ .Refunded }} نقطة" },
      { label: "الملفات", value: "إكسل · بي دي إف · سي إس في" },
    ],
    button: { href: "{{ .JobURL }}", label: "تحميل الملفات" },
    note: "الملفات متاحة للتحميل لمدة ٩٠ يومًا من «طلباتي».",
  }),
  "refund": layout("refund", {
    audience: "customer",
    preheader: "لم يُخصم شيء مقابل السجلات غير المسلَّمة.",
    chip: { text: "حجز مؤقت مُحرَّر", tone: "pending" },
    heading: "حجز مؤقت مُحرَّر",
    paragraphs: ["أهلًا {{ .Name }}، حجز مؤقت مُحرَّر بقيمة {{ .Points }} نقطة من بحث «{{ .JobTitle }}»، ولم يُخصم منك شيء مقابله."],
    reason: { text: "{{ .Reason }}", tone: "pending" },
    facts: [
      { label: "حجز مؤقت مُحرَّر", value: "+{{ .Points }} نقطة" },
      { label: "رصيدك الآن", value: "{{ .Balance }} نقطة" },
    ],
    button: { href: "{{ .SiteURL }}/dashboard/requests", label: "إعادة المحاولة" },
  }),
  // ONE compact layout for the updates of a long job (started, temporarily stalled, completed partially). Its words (Subject, Heading, Lead,
  // DetailOne, DetailTwo, ButtonLabel) are written by the app in plain Arabic from real numbers; a missing one renders as "".
  "job-update": layout("job-update", {
    audience: "customer",
    preheader: "{{ .Heading }}",
    heading: "{{ .Heading }}",
    paragraphs: ["أهلًا {{ .Name }}، {{ .Lead }}", "{{ .DetailOne }}", "{{ .DetailTwo }}"],
    button: { href: "{{ .JobURL }}", label: "{{ .ButtonLabel }}" },
  }),
  // The owner's alert for a new top-up request: the admin footer only; no receipt image, no receipt id, no token.
  "admin-topup-alert": layout("admin-topup-alert", {
    audience: "admin",
    preheader: "افتح صفحة الاعتماد لمراجعة الإيصال واعتماد النقاط.",
    chip: { text: "بانتظار الاعتماد", tone: "pending" },
    heading: "طلب شحن جديد بانتظار الاعتماد",
    paragraphs: ["وصل طلب شحن جديد. راجع الإيصال من صفحة الاعتماد."],
    facts: [
      { label: "اسم العميل", value: "{{ .CustomerName }}" },
      { label: "بريد العميل", value: "{{ .CustomerEmail }}", ltr: true },
      { label: "النقاط", value: "{{ .Points }} نقطة" },
      { label: "المبلغ المتوقع", value: "{{ .AmountEgp }} ج.م" },
      { label: "وقت الطلب", value: "{{ .RequestTime }}" },
    ],
    button: { href: "{{ .AdminURL }}", label: "افتح صفحة الاعتماد" },
  }),
};

const TOKEN_RE = /\{\{\s*\.([A-Za-z]+)\s*\}\}/g;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export const DEFAULT_SITE_URL = "https://diger.tech";

/** Read an env var in Deno (production) or Node (tests). */
function getEnv(name: string): string {
  try {
    const deno = (globalThis as unknown as { Deno?: { env?: { get(n: string): string | undefined } } }).Deno;
    if (deno?.env) return deno.env.get(name) ?? "";
  } catch { /* Deno unavailable (Node test) — fall through */ }
  try {
    const proc = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process;
    return proc?.env?.[name] ?? "";
  } catch { return ""; }
}

/** Resolve the public site origin for {{ .SiteURL }} (env override, else the canonical domain). */
export function resolveSiteUrl(): string {
  const env = (getEnv("SITE_URL") || getEnv("NEXT_PUBLIC_SITE_URL") || "").replace(/\/+$/, "");
  return env || DEFAULT_SITE_URL;
}

const AR_MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];

/** Format an ISO date as e.g. "13 أكتوبر 2026" for the {{ .CreatedAt }} token. */
export function formatArabicDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getDate()} ${AR_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * Render a platform email template. Values are HTML-escaped in the body; the subject
 * is plain text so its values are substituted raw. Missing variables render as ""
 * so no raw {{ .Var }} token ever reaches a customer. {{ .SiteURL }} defaults to
 * the canonical site origin when not supplied.
 */
export function renderEmailTemplate(
  id: PlatformEmailTemplateId,
  vars: Record<string, string | number | undefined | null> = {},
): { subject: string; html: string } {
  const all: Record<string, string> = { SiteURL: resolveSiteUrl() };
  for (const [k, v] of Object.entries(vars)) {
    if (v !== undefined && v !== null) all[k] = String(v);
  }
  const subject = PLATFORM_EMAIL_SUBJECTS[id].replace(TOKEN_RE, (_, name) => all[name] ?? "");
  const html = PLATFORM_EMAIL_TEMPLATES[id].replace(TOKEN_RE, (_, name) => escapeHtml(all[name] ?? ""));
  return { subject, html };
}

/** The variables a template reads (subject and body), sorted. Used by the tests that pin each template's contract with the app. */
export function templateVariables(id: PlatformEmailTemplateId): string[] {
  const found = new Set<string>();
  for (const source of [PLATFORM_EMAIL_SUBJECTS[id], PLATFORM_EMAIL_TEMPLATES[id]]) {
    for (const match of source.matchAll(TOKEN_RE)) found.add(match[1]);
  }
  return [...found].sort();
}
