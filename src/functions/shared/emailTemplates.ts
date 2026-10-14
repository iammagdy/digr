/**
 * Platform email templates (Arabic) — COPIED VERBATIM from the supplied email brief.
 * Do not hand-edit the HTML below: it must stay byte-identical to the brief.
 *
 * The templates live here as TypeScript strings (instead of standalone .html files)
 * because scripts/build-functions.ts bundles functions with esbuild and has no
 * .html loader or copy step — a raw .html file would never reach the deployed bundle.
 * renderEmailTemplate() substitutes the {{ .Var }} tokens with HTML-escaped values.
 */

export type PlatformEmailTemplateId =
  | "welcome"
  | "topup-received"
  | "topup-approved"
  | "topup-rejected"
  | "job-done"
  | "refund";

export const PLATFORM_EMAIL_SUBJECTS: Record<PlatformEmailTemplateId, string> = {
  "welcome": `أهلًا {{ .Name }} — حسابك على ديجر جاهز`,
  "topup-received": `استلمنا طلب شحن {{ .AmountEgp }} ج.م`,
  "topup-approved": `أُضيف {{ .Credits }} نقطة إلى رصيدك`,
  "topup-rejected": `تعذّر اعتماد طلب الشحن`,
  "job-done": `ملفاتك جاهزة: {{ .JobTitle }}`,
  "refund": `رجعت {{ .Points }} نقطة لرصيدك`,
};

const PLATFORM_EMAIL_TEMPLATES: Record<PlatformEmailTemplateId, string> = {
  "welcome": `<!DOCTYPE html>
<html lang="ar" dir="rtl" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>أهلًا {{ .Name }} — حسابك على ديجر جاهز</title>
<!--[if mso]><style>table,td,p,a,h1{font-family:Tahoma,Arial,sans-serif!important}</style><![endif]-->
<style>
@media only screen and (max-width:620px){.card{padding:28px 20px!important}.h1{font-size:23px!important;line-height:32px!important} }
@media (prefers-color-scheme:dark){.bgw{background:#16201F!important}.card{background:#1D2524!important;border-color:#2C3534!important} }
</style>
</head>
<body style="margin:0;padding:0;background:#F3F0E8;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">ثلاث خطوات وتستلم أول ملف بيانات: اشحن، اسأل، وافق.&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" class="bgw" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F3F0E8" style="background:#F3F0E8">
<tr><td align="center" style="padding:32px 12px 40px">
<!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%">
<tr><td dir="rtl" align="right" style="padding:0 6px 18px;text-align:right"><a href="{{ .SiteURL }}" style="text-decoration:none"><img src="{{ .SiteURL }}/email/digr-wordmark.png" width="104" alt="Diger ديجر" style="display:block;width:104px;height:auto;border:0;outline:none;text-decoration:none;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:20px;font-weight:700;color:#0E3B43"></a></td></tr>
<tr><td class="card" dir="rtl" bgcolor="#FFFDF9" style="background:#FFFDF9;border:1px solid #E6E1D7;border-radius:20px;padding:36px 32px;text-align:right">
<h1 class="h1" style="margin:0 0 14px;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:26px;line-height:36px;mso-line-height-rule:exactly;font-weight:700;color:#16201F">أهلًا {{ .Name }}، حسابك جاهز</h1><p style="margin:0 0 14px;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:15px;line-height:26px;mso-line-height-rule:exactly;color:#3A4241;">ديجر يحوّل سؤالك البحثي إلى ملفات جاهزة للتحليل. هكذا تبدأ:</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 22px;border-top:1px solid #E6E1D7"><tr><td style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:13px;line-height:20px;color:#6F716C;text-align:right" width="45%">١ · اشحن رصيدك</td><td  style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:14px;line-height:20px;font-weight:700;color:#16201F;text-align:left">عبر Instapay</td></tr><tr><td style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:13px;line-height:20px;color:#6F716C;text-align:right" width="45%">٢ · اسأل بالعربية</td><td  style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:14px;line-height:20px;font-weight:700;color:#16201F;text-align:left">والمساعد يحدد التفاصيل</td></tr><tr><td style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:13px;line-height:20px;color:#6F716C;text-align:right" width="45%">٣ · وافق على السعر</td><td  style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:14px;line-height:20px;font-weight:700;color:#16201F;text-align:left">وتدفع على المسلَّم فقط</td></tr></table><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="right" style="margin:8px 0 22px"><tr><td bgcolor="#0E3B43" style="background:#0E3B43;border-radius:999px;mso-padding-alt:14px 30px"><a href="{{ .SiteURL }}/dashboard/chat" target="_blank" style="display:block;padding:14px 30px;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:15px;line-height:20px;font-weight:700;color:#FAF8F4;text-decoration:none;border-radius:999px">ابدأ أول بحث</a></td></tr></table><div style="clear:both;line-height:0;font-size:0">&nbsp;</div><p style="margin:0;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:12px;line-height:20px;color:#8A8880">النقطة الواحدة = ٠٫١٠ ج.م. أي فرق في الحجز يرجع لرصيدك تلقائيًا.</p>
</td></tr>
<tr><td dir="rtl" style="padding:20px 8px 0;text-align:right;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:12px;line-height:20px;color:#8A8880">
تصلك هذه الرسالة لأنك فعّلت إشعارات البريد. <a href="{{ .SiteURL }}/dashboard/settings" style="color:#6F716C;text-decoration:underline">غيّر تفضيلاتك</a>.<br>
ديجر (Diger) — بيانات عامة جاهزة للتحليل · القاهرة، مصر · <a href="mailto:support@diger.tech" style="color:#6F716C;text-decoration:underline">support@diger.tech</a>
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`,
  "topup-received": `<!DOCTYPE html>
<html lang="ar" dir="rtl" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>استلمنا طلب شحن {{ .AmountEgp }} ج.م</title>
<!--[if mso]><style>table,td,p,a,h1{font-family:Tahoma,Arial,sans-serif!important}</style><![endif]-->
<style>
@media only screen and (max-width:620px){.card{padding:28px 20px!important}.h1{font-size:23px!important;line-height:32px!important} }
@media (prefers-color-scheme:dark){.bgw{background:#16201F!important}.card{background:#1D2524!important;border-color:#2C3534!important} }
</style>
</head>
<body style="margin:0;padding:0;background:#F3F0E8;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">طلبك قيد المراجعة — سنبلغك فور اعتماد النقاط.&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" class="bgw" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F3F0E8" style="background:#F3F0E8">
<tr><td align="center" style="padding:32px 12px 40px">
<!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%">
<tr><td dir="rtl" align="right" style="padding:0 6px 18px;text-align:right"><a href="{{ .SiteURL }}" style="text-decoration:none"><img src="{{ .SiteURL }}/email/digr-wordmark.png" width="104" alt="Diger ديجر" style="display:block;width:104px;height:auto;border:0;outline:none;text-decoration:none;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:20px;font-weight:700;color:#0E3B43"></a></td></tr>
<tr><td class="card" dir="rtl" bgcolor="#FFFDF9" style="background:#FFFDF9;border:1px solid #E6E1D7;border-radius:20px;padding:36px 32px;text-align:right">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="right" style="margin:0 0 18px"><tr><td bgcolor="#F6EEDD" style="background:#F6EEDD;border-radius:999px;padding:5px 12px;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:12px;line-height:16px;font-weight:700;color:#8A6420">قيد المراجعة</td></tr></table><div style="clear:both;line-height:0;font-size:0">&nbsp;</div><h1 class="h1" style="margin:0 0 14px;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:26px;line-height:36px;mso-line-height-rule:exactly;font-weight:700;color:#16201F">استلمنا طلب الشحن</h1><p style="margin:0 0 14px;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:15px;line-height:26px;mso-line-height-rule:exactly;color:#3A4241;">أهلًا {{ .Name }}، سيراجع فريقنا التحويل ويعتمد النقاط في محفظتك. عادةً خلال ساعات العمل.</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 22px;border-top:1px solid #E6E1D7"><tr><td style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:13px;line-height:20px;color:#6F716C;text-align:right" width="45%">المبلغ المحوّل</td><td  style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:14px;line-height:20px;font-weight:700;color:#16201F;text-align:left">{{ .AmountEgp }} ج.م</td></tr><tr><td style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:13px;line-height:20px;color:#6F716C;text-align:right" width="45%">النقاط المتوقعة</td><td  style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:14px;line-height:20px;font-weight:700;color:#16201F;text-align:left">{{ .Credits }} نقطة</td></tr><tr><td style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:13px;line-height:20px;color:#6F716C;text-align:right" width="45%">الرقم المرجعي</td><td dir="ltr" style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:14px;line-height:20px;font-weight:700;color:#16201F;text-align:left">{{ .Reference }}</td></tr><tr><td style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:13px;line-height:20px;color:#6F716C;text-align:right" width="45%">تاريخ الطلب</td><td  style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:14px;line-height:20px;font-weight:700;color:#16201F;text-align:left">{{ .CreatedAt }}</td></tr></table><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="right" style="margin:8px 0 22px"><tr><td bgcolor="#0E3B43" style="background:#0E3B43;border-radius:999px;mso-padding-alt:14px 30px"><a href="{{ .SiteURL }}/dashboard/topup" target="_blank" style="display:block;padding:14px 30px;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:15px;line-height:20px;font-weight:700;color:#FAF8F4;text-decoration:none;border-radius:999px">متابعة الطلب</a></td></tr></table><div style="clear:both;line-height:0;font-size:0">&nbsp;</div><p style="margin:0;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:12px;line-height:20px;color:#8A8880">النقاط النهائية تُحسب من المبلغ الذي يؤكده فريق الإدارة.</p>
</td></tr>
<tr><td dir="rtl" style="padding:20px 8px 0;text-align:right;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:12px;line-height:20px;color:#8A8880">
تصلك هذه الرسالة لأنك فعّلت إشعارات البريد. <a href="{{ .SiteURL }}/dashboard/settings" style="color:#6F716C;text-decoration:underline">غيّر تفضيلاتك</a>.<br>
ديجر (Diger) — بيانات عامة جاهزة للتحليل · القاهرة، مصر · <a href="mailto:support@diger.tech" style="color:#6F716C;text-decoration:underline">support@diger.tech</a>
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`,
  "topup-approved": `<!DOCTYPE html>
<html lang="ar" dir="rtl" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>أُضيف {{ .Credits }} نقطة إلى رصيدك</title>
<!--[if mso]><style>table,td,p,a,h1{font-family:Tahoma,Arial,sans-serif!important}</style><![endif]-->
<style>
@media only screen and (max-width:620px){.card{padding:28px 20px!important}.h1{font-size:23px!important;line-height:32px!important} }
@media (prefers-color-scheme:dark){.bgw{background:#16201F!important}.card{background:#1D2524!important;border-color:#2C3534!important} }
</style>
</head>
<body style="margin:0;padding:0;background:#F3F0E8;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">تم اعتماد شحنك — رصيدك جاهز لأبحاثك.&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" class="bgw" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F3F0E8" style="background:#F3F0E8">
<tr><td align="center" style="padding:32px 12px 40px">
<!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%">
<tr><td dir="rtl" align="right" style="padding:0 6px 18px;text-align:right"><a href="{{ .SiteURL }}" style="text-decoration:none"><img src="{{ .SiteURL }}/email/digr-wordmark.png" width="104" alt="Diger ديجر" style="display:block;width:104px;height:auto;border:0;outline:none;text-decoration:none;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:20px;font-weight:700;color:#0E3B43"></a></td></tr>
<tr><td class="card" dir="rtl" bgcolor="#FFFDF9" style="background:#FFFDF9;border:1px solid #E6E1D7;border-radius:20px;padding:36px 32px;text-align:right">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="right" style="margin:0 0 18px"><tr><td bgcolor="#E8F2EC" style="background:#E8F2EC;border-radius:999px;padding:5px 12px;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:12px;line-height:16px;font-weight:700;color:#2F6B4A">تم الاعتماد</td></tr></table><div style="clear:both;line-height:0;font-size:0">&nbsp;</div><h1 class="h1" style="margin:0 0 14px;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:26px;line-height:36px;mso-line-height-rule:exactly;font-weight:700;color:#16201F">رصيدك جاهز</h1><p style="margin:0 0 14px;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:15px;line-height:26px;mso-line-height-rule:exactly;color:#3A4241;">أهلًا {{ .Name }}، راجعنا التحويل وأضفنا النقاط إلى محفظتك.</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 22px;border-top:1px solid #E6E1D7"><tr><td style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:13px;line-height:20px;color:#6F716C;text-align:right" width="45%">النقاط المضافة</td><td  style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:14px;line-height:20px;font-weight:700;color:#16201F;text-align:left">+{{ .Credits }} نقطة</td></tr><tr><td style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:13px;line-height:20px;color:#6F716C;text-align:right" width="45%">المبلغ المؤكد</td><td  style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:14px;line-height:20px;font-weight:700;color:#16201F;text-align:left">{{ .ConfirmedAmountEgp }} ج.م</td></tr><tr><td style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:13px;line-height:20px;color:#6F716C;text-align:right" width="45%">الرقم المرجعي</td><td dir="ltr" style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:14px;line-height:20px;font-weight:700;color:#16201F;text-align:left">{{ .Reference }}</td></tr><tr><td style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:13px;line-height:20px;color:#6F716C;text-align:right" width="45%">رصيدك الآن</td><td  style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:14px;line-height:20px;font-weight:700;color:#16201F;text-align:left">{{ .Balance }} نقطة</td></tr></table><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="right" style="margin:8px 0 22px"><tr><td bgcolor="#0E3B43" style="background:#0E3B43;border-radius:999px;mso-padding-alt:14px 30px"><a href="{{ .SiteURL }}/dashboard/chat" target="_blank" style="display:block;padding:14px 30px;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:15px;line-height:20px;font-weight:700;color:#FAF8F4;text-decoration:none;border-radius:999px">ابدأ بحثًا</a></td></tr></table><div style="clear:both;line-height:0;font-size:0">&nbsp;</div>
</td></tr>
<tr><td dir="rtl" style="padding:20px 8px 0;text-align:right;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:12px;line-height:20px;color:#8A8880">
تصلك هذه الرسالة لأنك فعّلت إشعارات البريد. <a href="{{ .SiteURL }}/dashboard/settings" style="color:#6F716C;text-decoration:underline">غيّر تفضيلاتك</a>.<br>
ديجر (Diger) — بيانات عامة جاهزة للتحليل · القاهرة، مصر · <a href="mailto:support@diger.tech" style="color:#6F716C;text-decoration:underline">support@diger.tech</a>
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`,
  "topup-rejected": `<!DOCTYPE html>
<html lang="ar" dir="rtl" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>تعذّر اعتماد طلب الشحن</title>
<!--[if mso]><style>table,td,p,a,h1{font-family:Tahoma,Arial,sans-serif!important}</style><![endif]-->
<style>
@media only screen and (max-width:620px){.card{padding:28px 20px!important}.h1{font-size:23px!important;line-height:32px!important} }
@media (prefers-color-scheme:dark){.bgw{background:#16201F!important}.card{background:#1D2524!important;border-color:#2C3534!important} }
</style>
</head>
<body style="margin:0;padding:0;background:#F3F0E8;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">راجع سبب الرفض وأرسل طلبًا جديدًا ببيانات صحيحة.&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" class="bgw" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F3F0E8" style="background:#F3F0E8">
<tr><td align="center" style="padding:32px 12px 40px">
<!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%">
<tr><td dir="rtl" align="right" style="padding:0 6px 18px;text-align:right"><a href="{{ .SiteURL }}" style="text-decoration:none"><img src="{{ .SiteURL }}/email/digr-wordmark.png" width="104" alt="Diger ديجر" style="display:block;width:104px;height:auto;border:0;outline:none;text-decoration:none;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:20px;font-weight:700;color:#0E3B43"></a></td></tr>
<tr><td class="card" dir="rtl" bgcolor="#FFFDF9" style="background:#FFFDF9;border:1px solid #E6E1D7;border-radius:20px;padding:36px 32px;text-align:right">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="right" style="margin:0 0 18px"><tr><td bgcolor="#FBECE9" style="background:#FBECE9;border-radius:999px;padding:5px 12px;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:12px;line-height:16px;font-weight:700;color:#B4382B">لم يُعتمد</td></tr></table><div style="clear:both;line-height:0;font-size:0">&nbsp;</div><h1 class="h1" style="margin:0 0 14px;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:26px;line-height:36px;mso-line-height-rule:exactly;font-weight:700;color:#16201F">تعذّر اعتماد طلب الشحن</h1><p style="margin:0 0 14px;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:15px;line-height:26px;mso-line-height-rule:exactly;color:#3A4241;">أهلًا {{ .Name }}، راجعنا طلبك ولم نتمكن من اعتماده.</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 20px"><tr><td bgcolor="#FBECE9" style="background:#FBECE9;border-radius:14px;padding:14px 16px;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:13px;line-height:22px;color:#B4382B;text-align:right"><strong>السبب:</strong> {{ .RejectReason }}</td></tr></table><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 22px;border-top:1px solid #E6E1D7"><tr><td style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:13px;line-height:20px;color:#6F716C;text-align:right" width="45%">المبلغ</td><td  style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:14px;line-height:20px;font-weight:700;color:#16201F;text-align:left">{{ .AmountEgp }} ج.م</td></tr><tr><td style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:13px;line-height:20px;color:#6F716C;text-align:right" width="45%">الرقم المرجعي</td><td dir="ltr" style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:14px;line-height:20px;font-weight:700;color:#16201F;text-align:left">{{ .Reference }}</td></tr></table><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="right" style="margin:8px 0 22px"><tr><td bgcolor="#0E3B43" style="background:#0E3B43;border-radius:999px;mso-padding-alt:14px 30px"><a href="{{ .SiteURL }}/dashboard/topup" target="_blank" style="display:block;padding:14px 30px;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:15px;line-height:20px;font-weight:700;color:#FAF8F4;text-decoration:none;border-radius:999px">إرسال طلب جديد</a></td></tr></table><div style="clear:both;line-height:0;font-size:0">&nbsp;</div><p style="margin:0;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:12px;line-height:20px;color:#8A8880">لو تم خصم المبلغ من حسابك البنكي، راسلنا على <a href="mailto:support@diger.tech" style="color:#8A8880">support@diger.tech</a> ومعك صورة الإيصال.</p>
</td></tr>
<tr><td dir="rtl" style="padding:20px 8px 0;text-align:right;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:12px;line-height:20px;color:#8A8880">
تصلك هذه الرسالة لأنك فعّلت إشعارات البريد. <a href="{{ .SiteURL }}/dashboard/settings" style="color:#6F716C;text-decoration:underline">غيّر تفضيلاتك</a>.<br>
ديجر (Diger) — بيانات عامة جاهزة للتحليل · القاهرة، مصر · <a href="mailto:support@diger.tech" style="color:#6F716C;text-decoration:underline">support@diger.tech</a>
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`,
  "job-done": `<!DOCTYPE html>
<html lang="ar" dir="rtl" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>ملفاتك جاهزة: {{ .JobTitle }}</title>
<!--[if mso]><style>table,td,p,a,h1{font-family:Tahoma,Arial,sans-serif!important}</style><![endif]-->
<style>
@media only screen and (max-width:620px){.card{padding:28px 20px!important}.h1{font-size:23px!important;line-height:32px!important} }
@media (prefers-color-scheme:dark){.bgw{background:#16201F!important}.card{background:#1D2524!important;border-color:#2C3534!important} }
</style>
</head>
<body style="margin:0;padding:0;background:#F3F0E8;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">اكتمل بحثك — Excel وPDF وCSV جاهزة للتحميل.&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" class="bgw" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F3F0E8" style="background:#F3F0E8">
<tr><td align="center" style="padding:32px 12px 40px">
<!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%">
<tr><td dir="rtl" align="right" style="padding:0 6px 18px;text-align:right"><a href="{{ .SiteURL }}" style="text-decoration:none"><img src="{{ .SiteURL }}/email/digr-wordmark.png" width="104" alt="Diger ديجر" style="display:block;width:104px;height:auto;border:0;outline:none;text-decoration:none;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:20px;font-weight:700;color:#0E3B43"></a></td></tr>
<tr><td class="card" dir="rtl" bgcolor="#FFFDF9" style="background:#FFFDF9;border:1px solid #E6E1D7;border-radius:20px;padding:36px 32px;text-align:right">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="right" style="margin:0 0 18px"><tr><td bgcolor="#E8F2EC" style="background:#E8F2EC;border-radius:999px;padding:5px 12px;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:12px;line-height:16px;font-weight:700;color:#2F6B4A">اكتمل</td></tr></table><div style="clear:both;line-height:0;font-size:0">&nbsp;</div><h1 class="h1" style="margin:0 0 14px;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:26px;line-height:36px;mso-line-height-rule:exactly;font-weight:700;color:#16201F">ملفاتك جاهزة</h1><p style="margin:0 0 14px;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:15px;line-height:26px;mso-line-height-rule:exactly;color:#3A4241;">أهلًا {{ .Name }}، اكتمل بحث «{{ .JobTitle }}».</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 22px;border-top:1px solid #E6E1D7"><tr><td style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:13px;line-height:20px;color:#6F716C;text-align:right" width="45%">السجلات المسلَّمة</td><td  style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:14px;line-height:20px;font-weight:700;color:#16201F;text-align:left">{{ .Delivered }} من {{ .Requested }}</td></tr><tr><td style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:13px;line-height:20px;color:#6F716C;text-align:right" width="45%">النقاط المخصومة</td><td  style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:14px;line-height:20px;font-weight:700;color:#16201F;text-align:left">{{ .Charged }} نقطة</td></tr><tr><td style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:13px;line-height:20px;color:#6F716C;text-align:right" width="45%">رجع لرصيدك</td><td  style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:14px;line-height:20px;font-weight:700;color:#16201F;text-align:left">+{{ .Refunded }} نقطة</td></tr><tr><td style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:13px;line-height:20px;color:#6F716C;text-align:right" width="45%">الملفات</td><td  style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:14px;line-height:20px;font-weight:700;color:#16201F;text-align:left">Excel · PDF · CSV</td></tr></table><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="right" style="margin:8px 0 22px"><tr><td bgcolor="#0E3B43" style="background:#0E3B43;border-radius:999px;mso-padding-alt:14px 30px"><a href="{{ .JobURL }}" target="_blank" style="display:block;padding:14px 30px;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:15px;line-height:20px;font-weight:700;color:#FAF8F4;text-decoration:none;border-radius:999px">تحميل الملفات</a></td></tr></table><div style="clear:both;line-height:0;font-size:0">&nbsp;</div><p style="margin:0;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:12px;line-height:20px;color:#8A8880">الملفات متاحة للتحميل لمدة ٩٠ يومًا من «طلباتي».</p>
</td></tr>
<tr><td dir="rtl" style="padding:20px 8px 0;text-align:right;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:12px;line-height:20px;color:#8A8880">
تصلك هذه الرسالة لأنك فعّلت إشعارات البريد. <a href="{{ .SiteURL }}/dashboard/settings" style="color:#6F716C;text-decoration:underline">غيّر تفضيلاتك</a>.<br>
ديجر (Diger) — بيانات عامة جاهزة للتحليل · القاهرة، مصر · <a href="mailto:support@diger.tech" style="color:#6F716C;text-decoration:underline">support@diger.tech</a>
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`,
  "refund": `<!DOCTYPE html>
<html lang="ar" dir="rtl" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>رجعت {{ .Points }} نقطة لرصيدك</title>
<!--[if mso]><style>table,td,p,a,h1{font-family:Tahoma,Arial,sans-serif!important}</style><![endif]-->
<style>
@media only screen and (max-width:620px){.card{padding:28px 20px!important}.h1{font-size:23px!important;line-height:32px!important} }
@media (prefers-color-scheme:dark){.bgw{background:#16201F!important}.card{background:#1D2524!important;border-color:#2C3534!important} }
</style>
</head>
<body style="margin:0;padding:0;background:#F3F0E8;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">لم يُخصم شيء مقابل السجلات غير المسلَّمة.&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" class="bgw" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F3F0E8" style="background:#F3F0E8">
<tr><td align="center" style="padding:32px 12px 40px">
<!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%">
<tr><td dir="rtl" align="right" style="padding:0 6px 18px;text-align:right"><a href="{{ .SiteURL }}" style="text-decoration:none"><img src="{{ .SiteURL }}/email/digr-wordmark.png" width="104" alt="Diger ديجر" style="display:block;width:104px;height:auto;border:0;outline:none;text-decoration:none;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:20px;font-weight:700;color:#0E3B43"></a></td></tr>
<tr><td class="card" dir="rtl" bgcolor="#FFFDF9" style="background:#FFFDF9;border:1px solid #E6E1D7;border-radius:20px;padding:36px 32px;text-align:right">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="right" style="margin:0 0 18px"><tr><td bgcolor="#F6EEDD" style="background:#F6EEDD;border-radius:999px;padding:5px 12px;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:12px;line-height:16px;font-weight:700;color:#8A6420">استرداد</td></tr></table><div style="clear:both;line-height:0;font-size:0">&nbsp;</div><h1 class="h1" style="margin:0 0 14px;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:26px;line-height:36px;mso-line-height-rule:exactly;font-weight:700;color:#16201F">رجعت نقاطك</h1><p style="margin:0 0 14px;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:15px;line-height:26px;mso-line-height-rule:exactly;color:#3A4241;">أهلًا {{ .Name }}، أعدنا {{ .Points }} نقطة إلى رصيدك من بحث «{{ .JobTitle }}».</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 20px"><tr><td bgcolor="#F6EEDD" style="background:#F6EEDD;border-radius:14px;padding:14px 16px;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:13px;line-height:22px;color:#8A6420;text-align:right"><strong>السبب:</strong> {{ .Reason }}</td></tr></table><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 22px;border-top:1px solid #E6E1D7"><tr><td style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:13px;line-height:20px;color:#6F716C;text-align:right" width="45%">النقاط المستردة</td><td  style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:14px;line-height:20px;font-weight:700;color:#16201F;text-align:left">+{{ .Points }} نقطة</td></tr><tr><td style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:13px;line-height:20px;color:#6F716C;text-align:right" width="45%">رصيدك الآن</td><td  style="padding:11px 0;border-bottom:1px solid #E6E1D7;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:14px;line-height:20px;font-weight:700;color:#16201F;text-align:left">{{ .Balance }} نقطة</td></tr></table><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="right" style="margin:8px 0 22px"><tr><td bgcolor="#0E3B43" style="background:#0E3B43;border-radius:999px;mso-padding-alt:14px 30px"><a href="{{ .SiteURL }}/dashboard/requests" target="_blank" style="display:block;padding:14px 30px;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:15px;line-height:20px;font-weight:700;color:#FAF8F4;text-decoration:none;border-radius:999px">إعادة المحاولة</a></td></tr></table><div style="clear:both;line-height:0;font-size:0">&nbsp;</div>
</td></tr>
<tr><td dir="rtl" style="padding:20px 8px 0;text-align:right;font-family:Tahoma, Arial, Helvetica, sans-serif;font-size:12px;line-height:20px;color:#8A8880">
تصلك هذه الرسالة لأنك فعّلت إشعارات البريد. <a href="{{ .SiteURL }}/dashboard/settings" style="color:#6F716C;text-decoration:underline">غيّر تفضيلاتك</a>.<br>
ديجر (Diger) — بيانات عامة جاهزة للتحليل · القاهرة، مصر · <a href="mailto:support@diger.tech" style="color:#6F716C;text-decoration:underline">support@diger.tech</a>
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`,
};

const TOKEN_RE = /\{\{\s*\.([A-Za-z]+)\s*\}\}/g;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export const DEFAULT_SITE_URL = "https://diger.tech";

/** Resolve the public site origin for {{ .SiteURL }} (env override, else the canonical domain). */
export function resolveSiteUrl(): string {
  const env = (process.env.NEXT_PUBLIC_SITE_URL || "").replace(/\/+$/, "");
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
