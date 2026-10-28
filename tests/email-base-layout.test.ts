import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PLATFORM_EMAIL_SUBJECTS, renderEmailTemplate, templateVariables, type PlatformEmailTemplateId } from "../supabase/functions/send-email/templates";
import { TOPUP_REVIEW_DEFAULT_AR } from "../src/lib/topupConfig";

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const IDS = Object.keys(PLATFORM_EMAIL_SUBJECTS) as PlatformEmailTemplateId[];
const ADMIN: PlatformEmailTemplateId[] = ["admin-topup-alert"];
const CUSTOMER = IDS.filter((id) => !ADMIN.includes(id));

/** The variables each template reads, pinned: the deployed app sends exactly these names (new ones may only be added as optional; none renamed). */
const CONTRACT: Record<PlatformEmailTemplateId, string[]> = {
  "welcome": ["Name", "SiteURL"],
  "topup-received": ["AmountEgp", "CreatedAt", "Credits", "Name", "ReviewNote", "SiteURL"],
  "topup-approved": ["Balance", "ConfirmedAmountEgp", "Credits", "Name", "SiteURL"],
  "topup-rejected": ["AmountEgp", "Name", "RejectReason", "SiteURL"],
  // «Refunded» was already sent by the app for this template (the earlier short layout simply did not show it)
  "job-done": ["Charged", "Delivered", "JobTitle", "JobURL", "Name", "Refunded", "Requested", "SiteURL"],
  "refund": ["Balance", "JobTitle", "Name", "Points", "Reason", "SiteURL"],
  // (Preheader added: the line a mail list shows next to the subject; optional, a caller that sends none gets its heading) 
  "job-update": ["Name", "Subject", "Preheader", "Heading", "Lead", "DetailOne", "DetailTwo", "ButtonLabel", "JobURL", "SiteURL"].sort(),
  "admin-topup-alert": ["AdminURL", "AmountEgp", "CustomerEmail", "CustomerName", "Points", "RequestTime", "SiteURL"],
};

/** Realistic values, all in Arabic-Indic digits: what the app sends. */
const SAMPLE: Record<string, string> = {
  Name: "منى السيد", AmountEgp: "٢٥٠", Credits: "٢٥٠٠", ReviewNote: TOPUP_REVIEW_DEFAULT_AR, CreatedAt: "٢٥ أكتوبر ٢٠٢٦", ConfirmedAmountEgp: "٢٥٠", Balance: "٣٠٠٠",
  RejectReason: "الإيصال غير واضح", JobTitle: "قائمة شركات", JobURL: "https://diger.tech/dashboard/requests", Delivered: "٤٠", Requested: "١٠٠", Charged: "٣٦٠", Refunded: "٠",
  Points: "٢٠٧", Reason: "توقف تنفيذ الطلب عن التقدم قبل اكتماله", Subject: "اكتمل طلبك جزئيًا", Heading: "اكتمل طلبك جزئيًا", Lead: "وصلك ٤٠ من ١٠٠.", DetailOne: "خُصم ٣٦٠ نقطة.", DetailTwo: "حجز مؤقت مُحرَّر ١٤٠ نقطة.",
  ButtonLabel: "افتح طلباتي", CustomerName: "منى السيد", CustomerEmail: "customer@example.test", RequestTime: "٢٥ أكتوبر ٢٠٢٦ في ١:٠٠ م", AdminURL: "https://diger.tech/admin/topups",
};
const render = (id: PlatformEmailTemplateId) => renderEmailTemplate(id, SAMPLE);
/** What a person reads: no tags, style block or comments. */
const visibleText = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ").replace(/&[#\w]+;/g, " ").replace(/\s+/g, " ").trim();
const lum = (hex: string) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a: string, b: string) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

describe("one base layout for every template", () => {
  it("there are eight templates and every one has a subject", () => {
    expect(IDS.sort()).toEqual(["admin-topup-alert", "job-done", "job-update", "refund", "topup-approved", "topup-received", "topup-rejected", "welcome"]);
    for (const id of IDS) expect(PLATFORM_EMAIL_SUBJECTS[id], id).toMatch(/\S/);
  });

  it.each(IDS)("%s: right-to-left on the wrapper, the card, the heading and every paragraph (not only on <html>)", (id) => {
    const { html } = render(id);
    const body = html.slice(html.indexOf("<body"));
    expect(html).toContain('<html lang="ar" dir="rtl"');
    expect(body.startsWith('<body dir="rtl"'), "body").toBe(true);
    expect(body).toContain('<table role="presentation" class="bgw" dir="rtl" width="100%"'); // the wrapper table
    expect(body).toMatch(/<td class="card" dir="rtl" align="right"[^>]*text-align:right/); // the card
    expect(body).toMatch(/<h1 class="h1" dir="rtl"[^>]*text-align:right/);
    for (const paragraph of body.match(/<p [^>]*>/g) ?? []) {
      expect(paragraph, `${id} paragraph`).toContain('dir="rtl"');
      expect(paragraph, `${id} paragraph`).toContain("text-align:right");
    }
    // a label/value table, when there is one, is right-to-left as well
    for (const table of body.match(/<table [^>]*>/g) ?? []) expect(table, `${id} table`).toContain('dir="rtl"');
    expect(body).not.toMatch(/text-align:left[^"]*"[^>]*>\s*(?!<)[؀-ۿ]/); // no Arabic sentence left-aligned
  });

  it.each(IDS)("%s: the brand mark is on top, on a light rounded background that survives a dark client", (id) => {
    const { html } = render(id);
    const logoAt = html.indexOf("email/digr-wordmark.png");
    expect(logoAt, "logo").toBeGreaterThan(0);
    expect(logoAt, "logo before the card").toBeLessThan(html.indexOf('class="card"'));
    const img = html.slice(html.lastIndexOf("<img", logoAt), html.indexOf(">", logoAt) + 1);
    expect(img).toContain('alt="Diger ديجر"');
    expect(img).toContain("background:#FFFFFF"); // on the image itself: a client that recolours cell backgrounds does not recolour an image
    expect(img).toContain("border-radius:13px");
    const cell = html.slice(html.lastIndexOf("<td", logoAt), logoAt);
    expect(cell).toContain('bgcolor="#FFFFFF"'); // and on its cell, for Outlook desktop
    expect(cell).toContain("border-radius:14px");
    expect(contrast("#0E3B43", "#FFFFFF")).toBeGreaterThan(10);
  });

  it.each(IDS)("%s: inline and self-contained; it never relies on prefers-color-scheme and loads nothing external", (id) => {
    const { html } = render(id);
    expect(html).not.toMatch(/prefers-color-scheme/);
    expect(html).toContain('<meta name="color-scheme" content="light only">');
    expect(html).not.toMatch(/<script|<link |@import|@font-face|googleapis|gstatic|fonts\./i);
    // the only external things are the brand mark, the site's own links and the support address
    const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    for (const url of urls) expect(url, `${id} ${url}`).toMatch(/^(https:\/\/diger\.tech(\/|$)|mailto:support@diger\.tech$)/);
    expect(html).toContain("<table");
    expect(html).toMatch(/style="/);
  });

  it.each(IDS)("%s: readable text: every coloured chip and box is at least 4.5:1, and the footer and notes 4.5:1 on the page", (id) => {
    const { html } = render(id);
    for (const match of html.matchAll(/<td[^>]*bgcolor="(#[0-9A-Fa-f]{6})"[^>]*[; "]color:(#[0-9A-Fa-f]{6})/g)) {
      expect(contrast(match[1], match[2]), `${id} ${match[1]} / ${match[2]}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(html).not.toContain("#8A8880"); // the earlier footer grey was 3.1:1 on the page
    expect(contrast("#66685F", "#F3F0E8")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#66685F", "#FFFDF9")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#6F716C", "#FFFDF9")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#FAF8F4", "#0E3B43")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("footers by audience", () => {
  it.each(CUSTOMER)("%s (customer): the preferences footer, the support address and the platform line", (id) => {
    const text = visibleText(render(id).html);
    expect(text).toContain("تصلك هذه الرسالة لأنك فعّلت إشعارات البريد.");
    expect(text).toContain("غيّر تفضيلاتك");
    expect(render(id).html).toContain('href="https://diger.tech/dashboard/settings"');
    expect(text).toContain("ديجر (Diger) — مصادر متاحة جاهزة للتحليل · القاهرة، مصر");
    expect(text).toContain("support@diger.tech");
    expect(text).not.toContain("تنبيه داخلي للإدارة");
  });
  it.each(ADMIN)("%s (admin): the admin footer ONLY, with the support address and the platform line", (id) => {
    const { html } = render(id);
    const text = visibleText(html);
    expect(text).toContain("تنبيه داخلي للإدارة: يصل هذا البريد عند وصول كل طلب شحن جديد.");
    expect(text).not.toContain("فعّلت إشعارات البريد");
    expect(text).not.toContain("غيّر تفضيلاتك");
    expect(html).not.toContain("/dashboard/settings");
    expect(text).toContain("ديجر (Diger) — مصادر متاحة جاهزة للتحليل · القاهرة، مصر");
    expect(text).toContain("support@diger.tech");
  });
});

describe("customer rules, for every template", () => {
  it.each(IDS)("%s: Arabic-Indic digits in the subject and the body; no Latin digit anywhere a person reads", (id) => {
    const { subject, html } = render(id);
    expect(subject, "subject").not.toMatch(/[0-9]/);
    expect(visibleText(html), "body").not.toMatch(/[0-9]/);
  });

  it.each(IDS)("%s: no internal id, no provider name, no USD, no emoji", (id) => {
    const { subject, html } = render(id);
    const all = subject + visibleText(html) + html;
    expect(all).not.toMatch(/rcpt_|job_[0-9a-z]|top_[0-9a-z]|usr_|[0-9a-f]{24,}|[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(all).not.toMatch(/\bUSD\b|\$|دولار/);
    expect(all).not.toMatch(/tikhub|icypeas|openai|anthropic|resend|supabase|appwrite|treg|apify|instapay/i);
    expect(subject + visibleText(html)).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(html).not.toContain(".Reference");
    expect(html).not.toContain("الرقم المرجعي");
  });

  it.each(IDS)("%s: «حجز مؤقت مُحرَّر» is the only released-hold wording", (id) => {
    const text = subject(id) + visibleText(render(id).html);
    for (const banned of ["رجع لرصيدك", "يرجع لرصيدك", "فرق الحجز", "فرق في الحجز", "استرداد", "مسترد", "ريفند", "refund"]) expect(text, banned).not.toContain(banned);
  });
  const subject = (id: PlatformEmailTemplateId) => render(id).subject;

  it("the templates that speak of a released hold use the exact words", () => {
    for (const id of ["refund", "job-done", "welcome"] as const) expect(visibleText(render(id).html), id).toContain("حجز مؤقت مُحرَّر");
    expect(render("refund").subject).toBe("حجز مؤقت مُحرَّر بقيمة ٢٠٧ نقطة");
  });

  it("the top-up received e-mail keeps the review sentence of the top-up page; the other top-up e-mails do not invent another", () => {
    const text = visibleText(render("topup-received").html);
    expect(text).toContain("غالبًا يتم الاعتماد خلال ١٥ دقيقة، وبحد أقصى ٢٤ ساعة، وتصلك رسالة عند إضافة النقاط.");
    expect(text).not.toContain("ساعات العمل");
    for (const id of ["topup-approved", "topup-rejected", "admin-topup-alert"] as const) expect(visibleText(render(id).html), id).not.toContain("ساعات العمل");
  });

  it("no word of the e-mails is Latin except the brand («Diger») and the support address", () => {
    for (const id of IDS) {
      const words = (visibleText(render(id).html).match(/[A-Za-z][A-Za-z@.\-]*/g) ?? []).filter((w) => !/^(Diger|support@diger\.tech|customer@example\.test)$/.test(w));
      expect(words, id).toEqual([]);
    }
  });
});

describe("the variables of every template (the contract with the deployed app)", () => {
  it.each(IDS)("%s reads exactly its pinned variables: none renamed, none new and required", (id) => {
    expect(templateVariables(id)).toEqual([...CONTRACT[id]].sort());
  });

  it.each(IDS)("%s: every variable it reads is rendered, escaped, and none is left as {{ }}", (id) => {
    const sentinels = Object.fromEntries(templateVariables(id).map((name, index) => [name, `SENTINEL${index}<b>&`]));
    const { subject, html } = renderEmailTemplate(id, sentinels);
    for (const [name, value] of Object.entries(sentinels)) {
      if (name === "SiteURL") continue;
      const escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      expect(html.includes(escaped) || subject.includes(value), `${id} renders ${name}`).toBe(true);
    }
    expect(html).not.toContain("<b>&");
    expect(html + subject).not.toContain("{{");
    // with NO variable at all nothing raw reaches the reader either
    const empty = renderEmailTemplate(id, {});
    expect(empty.html + empty.subject).not.toContain("{{");
  });
});

describe("the inventory: every sender in the app uses a template that exists, for the right audience", () => {
  const files: string[] = [];
  const walk = (dir: string) => { for (const name of readdirSync(new URL(`../${dir}`, import.meta.url))) { const rel = `${dir}/${name}`; (statSync(new URL(`../${rel}`, import.meta.url)).isDirectory() ? walk : (r: string) => /\.tsx?$/.test(r) && files.push(r))(rel); } };
  walk("src/app"); walk("src/lib");

  it("each literal template key sent by the app is one of the eight, and the admin alert is the only admin one", () => {
    const used = new Set<string>();
    for (const file of files) for (const match of src(file).matchAll(/sendPlatformEmail\(\s*"([a-z-]+)"/g)) used.add(match[1]);
    expect([...used].sort()).toEqual(["job-done", "job-update", "refund", "topup-approved", "topup-received", "topup-rejected"]);
    for (const key of used) expect(IDS).toContain(key);
    expect(src("src/lib/server/topupOwnerAlert.ts")).toContain('"admin-topup-alert"');
    // the welcome e-mail is sent by the database trigger, with the customer's name only
    expect(readFileSync(new URL("../supabase/migrations/20261013170000_welcome_email_on_confirm.sql", import.meta.url), "utf8")).toContain("jsonb_build_object('Name', v_name)");
  });
});
