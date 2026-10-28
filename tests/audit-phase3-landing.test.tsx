import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/hooks/useUser", () => ({ useUser: () => ({ user: null, loading: false }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }), usePathname: () => "/" }));

import { GlassHeader } from "../src/components/landing/GlassHeader";
import { HeroLens } from "../src/components/landing/HeroLens";
import { DIM_OPACITY, HeroBackdropLayers, LENS_OPACITY } from "../src/components/landing/HeroBackdrop";
import { buildFieldItems } from "../src/components/landing/heroField";
import { HowItWorks, PriceStrip, WhatYouCanAsk } from "../src/components/landing/Overview";
import { Faq, FinalCta, SampleFile } from "../src/components/landing/Sections";
import { FAQS } from "../src/components/landing/landingFaq";
import { estimateMission } from "../src/lib/missionEstimate";
import { SAMPLE_ROWS } from "../src/lib/outputStandard";
import { buildPriceRows, homePriceStrip } from "../src/lib/pricingPage";
import { formatAr } from "../src/lib/arabicDigits";

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const text = (markup: string) => markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const SECTIONS = [
  ["hero", () => createElement(HeroLens)],
  ["price strip", () => createElement(PriceStrip)],
  ["how it works", () => createElement(HowItWorks)],
  ["what you can ask", () => createElement(WhatYouCanAsk)],
  ["sample", () => createElement(SampleFile)],
  ["faq", () => createElement(Faq, { items: FAQS })],
  ["closing", () => createElement(FinalCta)],
] as const;
const page = SECTIONS.map(([, make]) => renderToStaticMarkup(make()));
const pageText = text(page.join("\n"));

describe("audit phase 3: the page order", () => {
  it("is header, hero, price strip, how it works, what you can ask, sample, short FAQ, one closing action", () => {
    const source = src("src/app/page.tsx");
    const order = ["<GlassHeader />", "<HeroLens />", "<PriceStrip />", "<HowItWorks />", "<WhatYouCanAsk />", "<SampleFile />", "<Faq items={FAQS} />", "<FinalCta />"].map((tag) => source.indexOf(tag));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const removed of ["<Overview />", "<DemoConversations />", "<Calculator />", "<ProductLines />", "<Statements />", "<Sheets />"]) expect(source).not.toContain(removed);
    expect(source).toContain('export const dynamic = "force-static"');
  });
});

describe("audit phase 3: the hero", () => {
  const hero = page[0];
  it("has ONE explanatory sentence, ONE question box and ONE primary action", () => {
    expect(hero.match(/data-testid="hero-sentence"/g)?.length).toBe(1);
    expect(hero.match(/<p /g)?.length).toBe(2); // the sentence and the single approval line
    expect(hero.match(/<form/g)?.length).toBe(1);
    expect(hero.match(/<input/g)?.length).toBe(1);
    expect(hero.match(/<button/g)?.length).toBe(1);
    expect(hero).not.toContain("<a ");
    expect(hero.match(/<h1/g)?.length).toBe(1);
  });
  it("the hero sentence is the owner-approved one, one short sentence, with balanced wrapping; the file formats are still named elsewhere on the page", () => {
    const sentence = text(hero.slice(hero.indexOf('data-testid="hero-sentence"')).split("</p>")[0]);
    expect(sentence).toContain("أخبرنا بالبيانات التي تحتاجها، ونجمعها لك.");
    expect(sentence.match(/[.،]/g)?.length).toBe(2); // one comma, one full stop: a single short sentence
    expect(sentence).not.toMatch(/إكسل|بي دي إف|[0-9٠-٩]|\p{Extended_Pictographic}/u);
    expect(src("src/components/landing/HeroLens.tsx")).toContain("text-balance"); // text-wrap: balance, so no word stands alone on a line
    expect(hero).toMatch(/<p [^>]*text-balance[^>]*data-testid="hero-sentence"|<p [^>]*data-testid="hero-sentence"[^>]*text-balance/);
    const rest = text(page.slice(1).join("\n"));
    expect(rest).toContain("إكسل");
    expect(rest).toContain("بي دي إف");
    expect(rest).toContain("ملف إكسل أو بي دي إف منظّم"); // the third step
  });
  it("says that nothing starts or is charged before approval, once, and the rest of the page does not repeat it", () => {
    expect(hero).toContain("لا يبدأ أي جمع ولا يُخصم أي رصيد قبل موافقتك");
    expect(pageText.match(/قبل موافقتك/g)?.length).toBe(1);
    expect(pageText.match(/قبل أي خصم/g)?.length ?? 0).toBe(0);
    expect(pageText.match(/لا يُخصم أي رصيد/g)?.length).toBe(1);
  });
  it("has the blurred record field, the lens and the rings behind the text, loaded after the page is shown and kept out of the form's way", () => {
    const source = src("src/components/landing/HeroLens.tsx");
    // the hero itself holds no animation code and no records: the decoration is its own file, loaded in the browser only (not in the first HTML)
    expect(source).not.toMatch(/requestAnimationFrame|RecordField|FIELD_ITEMS|data-lens(?!-shield)|data-px|willChange|opacity: 0\.12/);
    expect(source).toContain('dynamic(() => import("./HeroBackdrop"), { ssr: false })');
    expect(hero).not.toMatch(/data-field|hero-backdrop|data-lens-win|data-px-/);
    // the headline and the two lines keep a soft halo so they stay easy to read over the field
    expect(source).toContain("textShadow");
    expect(source).toContain("WebkitTextStroke");
    expect(source.match(/background: HALO/g)?.length).toBe(2);
    // the records are not in the shared data file (they are built in the browser, by heroField)
    expect(src("src/components/landing/data.ts")).not.toMatch(/FIELD_ITEMS|buildFieldItems/);
  });
  it("the layers: field, lens, ring and rings, all hidden from readers, taking no pointer events, with no control, link or text of their own", () => {
    const records = buildFieldItems().slice(0, 40);
    const markup = renderToStaticMarkup(createElement(HeroBackdropLayers, { items: records, mobile: false }));
    for (const marker of ['data-testid="hero-backdrop"', "data-px-back", "data-lens-win", "data-lens-ring", "data-px-rings", 'data-field="dim"', 'data-field="hi"']) expect(markup).toContain(marker);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup.match(/pointer-events-none/g)!.length).toBeGreaterThanOrEqual(5);
    expect(markup).not.toMatch(/<(?:a|button|input|textarea|select|form|img|svg)\b|href=|tabindex|onclick/i);
    expect(markup).not.toMatch(/example\.|https?:|@/);
    // a phone gets the smaller lens; a wide screen the larger one
    expect(renderToStaticMarkup(createElement(HeroBackdropLayers, { items: [], mobile: true }))).toContain("width:112px");
    expect(renderToStaticMarkup(createElement(HeroBackdropLayers, { items: [], mobile: false }))).toContain("width:170px");
  });
  it("is quieter than before: the field and the lens are less contrasty than the original (0.12 and 0.74), and still above zero", () => {
    expect(DIM_OPACITY).toBeLessThan(0.12);
    expect(DIM_OPACITY).toBeGreaterThan(0.04);
    expect(LENS_OPACITY).toBeLessThan(0.74);
    expect(LENS_OPACITY).toBeGreaterThan(0.4);
  });
  it("respects reduced motion: the loop is not started, the rings and the fade stand still, and nothing is clickable or layout-moving", () => {
    const source = src("src/components/landing/HeroBackdrop.tsx");
    expect(source).toContain('matchMedia("(prefers-reduced-motion: reduce)")');
    const reducedBranch = source.indexOf("if (reduced) {\n      draw(0);");
    const loopStart = source.lastIndexOf("raf = requestAnimationFrame(loop);");
    expect(reducedBranch).toBeGreaterThan(0);
    expect(loopStart).toBeGreaterThan(reducedBranch); // a reduced-motion visitor returns before the loop starts
    expect(source.match(/motion-reduce:\[animation:none\]/g)!.length).toBeGreaterThanOrEqual(4); // the fade and the three rings
    expect(source).toContain("cancelAnimationFrame(raf)");
    expect(source).toContain("IntersectionObserver"); // nothing is drawn while the hero is out of view
    expect(source).toContain("document.hidden");
    // no control of its own, no price code, and it adds nothing to the layout (absolute layers inside the hero)
    expect(source).not.toMatch(/<(?:a|button|input|Link)\b|pricingPage|missionEstimate|calculatorPricing/);
    expect(src("src/components/landing/HeroLens.tsx")).toContain("overflow-hidden"); // no sideways scroll at 390px: the rings are cut at the hero's edge
  });
  it("the records are made-up generic lines: 300 different ones, Arabic only, no emoji, no address, no link, no real company", () => {
    const records = buildFieldItems();
    expect(records).toHaveLength(300);
    expect(new Set(records).size).toBe(300);
    expect(buildFieldItems()).toEqual(records); // seeded: the same lines every time
    const all = records.join("\n");
    expect(all).not.toMatch(/[A-Za-z0-9]/);
    expect(all).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(all).not.toMatch(/https?:|www\.|\.com|@/i);
  });
  it("still sends the typed question to sign-up or the chat", () => {
    const source = src("src/components/landing/HeroLens.tsx");
    expect(source).toContain("savePendingQuestion(q)");
    expect(source).toContain('router.push(user ? "/dashboard/chat" : "/register")');
  });
});

describe("audit phase 3: the price strip is computed", () => {
  it("shows 5 companies and 100 posts on X priced by the shared estimate, in Arabic digits", () => {
    const strip = homePriceStrip();
    expect(strip).toHaveLength(2);
    const companies = estimateMission({ kind: "companies", volume: 5 });
    const posts = estimateMission({ kind: "posts", platform: "x", volume: 100 });
    if (companies.status !== "ok" || posts.status !== "ok") throw new Error("the estimate must price both");
    expect(strip[0]).toMatchObject({ points: companies.expectedPoints, egp: companies.expectedEgp });
    expect(strip[1]).toMatchObject({ points: posts.expectedPoints, egp: posts.expectedEgp });
    const markup = text(page[1]);
    expect(markup).toContain("٥ شركات");
    expect(markup).toContain("١٠٠ تغريدة");
    expect(markup).not.toContain("منشورًا على إكس");
    expect(markup).toContain(`${formatAr(companies.expectedPoints)} نقطة`);
    expect(markup).toContain(`${formatAr(posts.expectedPoints)} نقطة`);
    expect(markup).not.toMatch(/[0-9]/);
  });
  it("agrees with the pricing page's unit prices", () => {
    const rows = buildPriceRows();
    const unit = (id: string) => rows.find((row) => row.id === id)!.unitPricePoints;
    const strip = homePriceStrip();
    // (the old lines had no minimum: Math.ceil(5 * unit) and |points - 100 * unit| < 1) the one pricing rule: a mission is never charged less than 200 points
    expect(strip[0].points).toBe(Math.max(200, Math.ceil(5 * unit("companies"))));
    expect(Math.abs(strip[1].points - Math.max(200, 100 * unit("x-posts")))).toBeLessThan(1);
  });
  it("links to the pricing page and the calculator and states that the real price is in the plan", () => {
    expect(page[1]).toContain('href="/pricing"');
    expect(page[1]).toContain('href="/calculator"');
    expect(text(page[1])).toContain("سعر طلبك الفعلي يظهر في خطته");
  });
  it("the client files carry no pricing code (the strip is built on the server)", () => {
    expect(src("src/components/landing/Sections.tsx")).not.toMatch(/pricingPage|missionEstimate|calculatorPricing/);
    expect(src("src/components/landing/HeroLens.tsx")).not.toMatch(/pricingPage|missionEstimate|calculatorPricing/);
    expect(src("src/components/landing/data.ts")).not.toMatch(/pricingPage|missionEstimate/);
  });
});

describe("audit phase 3: two merged sections", () => {
  it("«إزاي بيشتغل وإيه اللي بتدفعه» holds the three steps and what is paid", () => {
    const markup = text(page[2]);
    expect(markup).toContain("إزاي بيشتغل وإيه اللي بتدفعه");
    for (const step of ["اطلب", "راجع الخطة والسعر", "استلم الملف"]) expect(markup).toContain(step);
    expect(markup).toContain("تدفع مقابل ما يُسلَّم فعلًا من سجلات مطابقة فقط");
    expect(markup).toContain("حجز مؤقت مُحرَّر");
  });
  it("«إيه اللي ممكن تطلبه» holds the sectors and the decision makers with their statuses", () => {
    const markup = text(page[3]);
    expect(markup).toContain("إيه اللي ممكن تطلبه");
    expect(page[3]).toContain('data-testid="landing-sectors"');
    expect(page[3]).toContain('data-testid="landing-decision-makers"');
  });
  it("the old separate headings are gone", () => {
    for (const old of ["ديجر في ثلاث خطوات", "البيانات التي نجمعها"]) expect(pageText).not.toContain(old);
  });
});

describe("audit phase 3: the sample is clearly a sample", () => {
  it("is labelled «نموذج توضيحي» twice (badge and table header) and says the data is not real", () => {
    expect(page[4]).toContain('data-testid="sample-badge"');
    expect(page[4]).toContain("نموذج توضيحي");
    expect(page[4]).toContain('data-testid="sample-label"');
    expect(pageText).toContain("وهمية، ولا تخص أي شخص أو جهة حقيقية");
  });
  it("holds no example.com link, no URL and no e-mail address, on the page or in the sample rows", () => {
    expect(page.join("\n")).not.toMatch(/example\.com/i);
    expect(pageText).not.toMatch(/https?:\/\/|\S+@\S+\.\S+/);
    for (const rows of Object.values(SAMPLE_ROWS)) for (const row of rows) for (const value of Object.values(row)) expect(String(value)).not.toMatch(/example|:\/\/|@/i);
  });
  it("every company name in the sample says it is invented", () => {
    for (const row of SAMPLE_ROWS.companies) expect(String(row.company_name)).toMatch(/النموذج/);
  });
});

describe("audit phase 3: a short FAQ", () => {
  it("has four questions in this order: price, legality, partial delivery, top-up", () => {
    expect(FAQS.map(([question]) => question)).toEqual([
      "كم يكلّف طلبي؟",
      "هل جمع البيانات من المصادر المتاحة قانوني؟",
      "ماذا لو وصلني أقل مما طلبت؟",
      "كيف أشحن رصيدي؟",
    ]);
    expect(page[5].match(/aria-expanded/g)?.length).toBe(4);
  });
  it("uses the pricing page's own answers for the price and the partial delivery", async () => {
    const { PRICING_FAQ_AR } = await import("../src/lib/pricingPage");
    expect(FAQS[0][1]).toBe(PRICING_FAQ_AR[0][1]);
    expect(FAQS[2][1]).toBe(PRICING_FAQ_AR[1][1]);
  });
  it("no answer says it the refund way", () => {
    for (const [, answer] of FAQS) expect(answer).not.toMatch(/يُرد|استرداد|يعود إلى رصيدك|إرجاع/);
  });
});

describe("audit phase 3: one closing action and the footer unchanged", () => {
  const closing = page[6];
  it("has ONE button-like link above the footer", () => {
    expect(closing.match(/bg-ac/g)?.length).toBe(1);
    expect(closing).toContain("سؤال واحد يكفي للبدء.");
  });
  it("keeps the footer links and the copyright line exactly", () => {
    for (const href of ["/pricing", "/for/marketing-agencies", "/calculator", "/legal/terms", "/legal/privacy", "/contact"]) expect(closing).toContain(`href="${href}"`);
    expect(text(closing)).toContain("© ٢٠٢٦ ديجر — من مصادر متاحة · موافقة صريحة قبل أي جمع");
    for (const label of ["الأسعار", "لمن نخدم", "حاسبة التكلفة", "الشروط والأحكام", "سياسة الخصوصية", "تواصل معنا"]) expect(text(closing)).toContain(label);
  });
});

describe("audit phase 3: the page stays Arabic and clean", () => {
  it("has no English word, no emoji and no raw digit in its text (the header is static navigation)", () => {
    expect(pageText).not.toMatch(/[A-Za-z]/);
    expect(pageText.replace("©", "")).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(pageText).not.toMatch(/[0-9]/);
  });
  it("renders the header with its navigation untouched", () => {
    const header = renderToStaticMarkup(createElement(GlassHeader));
    for (const href of ["/services", "/pricing", "/calculator"]) expect(header).toContain(`href="${href}"`);
  });
});
