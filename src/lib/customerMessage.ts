/**
 * A MESSAGE FROM THE ADMIN TO ONE CUSTOMER, in the platform's own e-mail design (the same wordmark, card, colours,
 * button and footer as the six platform templates in src/functions/shared/emailTemplates.ts).
 *
 * Pure and client-safe: the admin's composer previews exactly the HTML the server sends, because both call
 * `renderCustomerMessageHtml` here. The server validates again before sending; the client's copy is never trusted.
 *
 * Safety by construction:
 * - every text is HTML-escaped; the body is plain text (blank line = new paragraph, line break = <br>), no markup;
 * - the button can only point at a page of the site (`ctaPath` starts with "/"), never at another host, so a
 *   message from noreply@diger.tech can never carry a link elsewhere;
 * - the recipient is not part of the message: the route sends only to the customer's registered address.
 */

export const DEFAULT_CUSTOMER_MESSAGE_SITE_URL = "https://diger.tech";

export const CUSTOMER_MESSAGE_LIMITS = {
  subject: { min: 3, max: 150 },
  badge: { max: 40 },
  heading: { min: 3, max: 120 },
  body: { min: 10, max: 5000 },
  ctaLabel: { min: 2, max: 40 },
  ctaPath: { max: 200 },
} as const;

/** The site pages a message's button may open (the composer offers these; any other path of the site is accepted too). */
export const CUSTOMER_MESSAGE_CTA_PAGES: ReadonlyArray<{ path: string; labelAr: string }> = [
  { path: "/dashboard/chat", labelAr: "صفحة طلب جديد" },
  { path: "/dashboard", labelAr: "لوحة العميل" },
  { path: "/dashboard/topup", labelAr: "شحن الرصيد" },
  { path: "/dashboard/settings", labelAr: "الإعدادات" },
];

export interface CustomerMessage {
  subject: string;
  /** A short label above the heading («تحديث بخصوص طلبك»); optional. */
  badge?: string;
  heading: string;
  /** Plain text: a blank line starts a new paragraph, a line break stays a line break. */
  body: string;
  /** The button: both or neither. */
  ctaLabel?: string;
  ctaPath?: string;
}

export type CustomerMessageCheck = { ok: true; value: CustomerMessage } | { ok: false; errorAr: string };

const clean = (v: unknown): string => String(v ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
const oneLine = (v: unknown): string => clean(v).replace(/\s+/g, " ");

/** A path of the site only: it starts with one "/", has no scheme, no host, no backslash and no spaces. */
export function isSitePath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  if (path.length > CUSTOMER_MESSAGE_LIMITS.ctaPath.max) return false;
  return /^\/[A-Za-z0-9\-._~/?#=&%+]*$/.test(path);
}

export function validateCustomerMessage(raw: unknown): CustomerMessageCheck {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const L = CUSTOMER_MESSAGE_LIMITS;
  const subject = oneLine(r.subject);
  const badge = oneLine(r.badge);
  const heading = oneLine(r.heading);
  const body = clean(r.body).replace(/\n{3,}/g, "\n\n");
  const ctaLabel = oneLine(r.ctaLabel);
  const ctaPath = oneLine(r.ctaPath);
  if (subject.length < L.subject.min || subject.length > L.subject.max) return { ok: false, errorAr: `اكتب موضوع الرسالة (من ${L.subject.min} إلى ${L.subject.max} حرفًا).` };
  if (badge.length > L.badge.max) return { ok: false, errorAr: `الشارة أطول من ${L.badge.max} حرفًا.` };
  if (heading.length < L.heading.min || heading.length > L.heading.max) return { ok: false, errorAr: `اكتب عنوان الرسالة (من ${L.heading.min} إلى ${L.heading.max} حرفًا).` };
  if (body.length < L.body.min || body.length > L.body.max) return { ok: false, errorAr: `اكتب نص الرسالة (من ${L.body.min} إلى ${L.body.max} حرفًا).` };
  if (Boolean(ctaLabel) !== Boolean(ctaPath)) return { ok: false, errorAr: "الزر يحتاج نصًا ورابطًا معًا، أو اتركهما فارغين." };
  if (ctaLabel && (ctaLabel.length < L.ctaLabel.min || ctaLabel.length > L.ctaLabel.max)) return { ok: false, errorAr: `نص الزر من ${L.ctaLabel.min} إلى ${L.ctaLabel.max} حرفًا.` };
  if (ctaPath && !isSitePath(ctaPath)) return { ok: false, errorAr: "رابط الزر يجب أن يكون صفحة من الموقع نفسه ويبدأ بـ «/»." };
  return { ok: true, value: { subject, heading, body, ...(badge ? { badge } : {}), ...(ctaLabel ? { ctaLabel, ctaPath } : {}) } };
}

export function escapeMessageHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const FONT = "Tahoma, Arial, Helvetica, sans-serif";
const P_STYLE = `margin:0 0 14px;font-family:${FONT};font-size:15px;line-height:26px;mso-line-height-rule:exactly;color:#3A4241;`;

const paragraphsOf = (body: string): string[] => body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

/** The site URL without a trailing slash; only http(s). */
function siteOf(siteUrl?: string): string {
  const s = (siteUrl || DEFAULT_CUSTOMER_MESSAGE_SITE_URL).trim().replace(/\/+$/, "");
  return /^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(s) ? s : DEFAULT_CUSTOMER_MESSAGE_SITE_URL;
}

/** The e-mail's HTML, in the platform's design. `m` must be a validated message. */
export function renderCustomerMessageHtml(m: CustomerMessage, options: { siteUrl?: string } = {}): string {
  const site = siteOf(options.siteUrl);
  const e = escapeMessageHtml;
  const preheader = e(paragraphsOf(m.body)[0]?.replace(/\s+/g, " ").slice(0, 110) ?? m.heading);
  const badge = m.badge
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="right" style="margin:0 0 18px"><tr><td bgcolor="#F6EEDD" style="background:#F6EEDD;border-radius:999px;padding:5px 12px;font-family:${FONT};font-size:12px;line-height:16px;font-weight:700;color:#8A6420">${e(m.badge)}</td></tr></table><div style="clear:both;line-height:0;font-size:0">&nbsp;</div>`
    : "";
  const paragraphs = paragraphsOf(m.body).map((p) => `<p style="${P_STYLE}">${e(p).replace(/\n/g, "<br>")}</p>`).join("\n");
  const button = m.ctaLabel && m.ctaPath && isSitePath(m.ctaPath)
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="right" style="margin:8px 0 22px"><tr><td bgcolor="#0E3B43" style="background:#0E3B43;border-radius:999px;mso-padding-alt:14px 30px"><a href="${e(site + m.ctaPath)}" target="_blank" style="display:block;padding:14px 30px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:700;color:#FAF8F4;text-decoration:none;border-radius:999px">${e(m.ctaLabel)}</a></td></tr></table><div style="clear:both;line-height:0;font-size:0">&nbsp;</div>`
    : "";
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${e(m.subject)}</title>
<!--[if mso]><style>table,td,p,a,h1{font-family:Tahoma,Arial,sans-serif!important}</style><![endif]-->
<style>
@media only screen and (max-width:620px){.card{padding:28px 20px!important}.h1{font-size:23px!important;line-height:32px!important} }
@media (prefers-color-scheme:dark){.bgw{background:#16201F!important}.card{background:#1D2524!important;border-color:#2C3534!important} }
</style>
</head>
<body style="margin:0;padding:0;background:#F3F0E8;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">${preheader}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" class="bgw" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F3F0E8" style="background:#F3F0E8">
<tr><td align="center" style="padding:32px 12px 40px">
<!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%">
<tr><td dir="rtl" align="right" style="padding:0 6px 18px;text-align:right"><a href="${e(site)}" style="text-decoration:none"><img src="${e(site)}/email/digr-wordmark.png" width="104" alt="Diger ديجر" style="display:block;width:104px;height:auto;border:0;outline:none;text-decoration:none;font-family:${FONT};font-size:20px;font-weight:700;color:#0E3B43"></a></td></tr>
<tr><td class="card" dir="rtl" bgcolor="#FFFDF9" style="background:#FFFDF9;border:1px solid #E6E1D7;border-radius:20px;padding:36px 32px;text-align:right">
${badge}<h1 class="h1" style="margin:0 0 14px;font-family:${FONT};font-size:26px;line-height:36px;mso-line-height-rule:exactly;font-weight:700;color:#16201F">${e(m.heading)}</h1>
${paragraphs}
${button}<p style="margin:0;font-family:${FONT};font-size:12px;line-height:20px;color:#8A8880">لأي استفسار، يسعدنا تواصلك عبر <a href="mailto:support@diger.tech" style="color:#6F716C;text-decoration:underline">support@diger.tech</a> أو بالرد على هذه الرسالة.</p>
</td></tr>
<tr><td dir="rtl" style="padding:20px 8px 0;text-align:right;font-family:${FONT};font-size:12px;line-height:20px;color:#8A8880">
تصلك هذه الرسالة بخصوص حسابك في ديجر.<br>
ديجر (Diger) — مصادر متاحة جاهزة للتحليل · القاهرة، مصر · <a href="mailto:support@diger.tech" style="color:#6F716C;text-decoration:underline">support@diger.tech</a>
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
}

/** The plain-text part (mail clients that do not show HTML, and spam filters, read it). */
export function renderCustomerMessageText(m: CustomerMessage, options: { siteUrl?: string } = {}): string {
  const site = siteOf(options.siteUrl);
  return [m.heading, "", ...paragraphsOf(m.body).flatMap((p) => [p, ""]), ...(m.ctaLabel && m.ctaPath ? [`${m.ctaLabel}: ${site}${m.ctaPath}`, ""] : []), "لأي استفسار: support@diger.tech", "ديجر (Diger)"].join("\n");
}

/** Ready texts the admin starts from (then edits). `name` is how the customer is addressed. */
export const CUSTOMER_MESSAGE_PRESETS: ReadonlyArray<{ id: string; labelAr: string; build: (ctx: { name: string }) => CustomerMessage }> = [
  {
    id: "failed-mission",
    labelAr: "اعتذار عن طلب تعثّر",
    build: ({ name }) => ({
      subject: "بخصوص طلبك الأخير على ديجر",
      badge: "تحديث بخصوص طلبك",
      heading: "نعتذر عن تعثّر طلبك الأخير",
      body: `${name}، تحية طيبة،\nنعتذر عن عدم اكتمال طلبك الأخير على ديجر، ونقدّر وقتك وثقتك.\n\nسبب التعثّر: …\n\nعالجنا ذلك، ويمكنك إعادة إرسال طلبك الآن. لم يُخصم من رصيدك شيء عن الطلب السابق، وعادت النقاط المحجوزة كاملة.`,
      ctaLabel: "إعادة إرسال الطلب",
      ctaPath: "/dashboard/chat",
    }),
  },
  {
    id: "file-attached",
    labelAr: "ملف النتائج مرفق",
    build: ({ name }) => ({
      subject: "ملف نتائج طلبك من ديجر",
      badge: "ملفك جاهز",
      heading: "أرفقنا لك ملف النتائج",
      body: `${name}، تحية طيبة،\nأرفقنا بهذه الرسالة ملف نتائج طلبك، وفيه ورقة الملخص والمنهجية: المصدر، وطريقة البحث، والفترة، وما قُرئ وما استُبعد ولماذا.\n\nإن احتجت أي توضيح أو تعديل، يسعدنا تواصلك بالرد على هذه الرسالة.`,
    }),
  },
  {
    id: "general",
    labelAr: "رسالة عامة",
    build: ({ name }) => ({ subject: "رسالة من فريق ديجر", heading: "رسالة من فريق ديجر", body: `${name}، تحية طيبة،\n\n…` }),
  },
];

/** How a customer is addressed when no name is known. */
export const customerGreetingName = (name: string | null | undefined): string => (name && name.trim() ? name.trim() : "عزيزنا العميل");
