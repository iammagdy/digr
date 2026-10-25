import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Overview, OVERVIEW_PAYMENT_AR, OVERVIEW_STEPS_AR } from "../src/components/landing/Overview";
import { SERVICES_CATALOG, catalogCounts } from "../src/lib/servicesCatalog";
import { platformsCountAr, sectorsCountAr } from "../src/lib/servicesCatalogText";
import { CONTACT_VERIFICATION_LABELS } from "../src/lib/contactVerification";
import { PROVIDER_NAME_PATTERN } from "../src/lib/publicCapabilityIds";

const html = renderToStaticMarkup(createElement(Overview));
const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const hero = readFileSync("src/components/landing/HeroLens.tsx", "utf8");
const page = readFileSync("src/app/page.tsx", "utf8");

describe("landing clarity (Part 3)", () => {
  it("the first screen says in one Arabic sentence what Diger is, with ONE question box and ONE primary action (audit phase 3)", () => {
    expect(hero).toContain("أخبرنا بالبيانات التي تحتاجها، ونجمعها لك.");
    expect(hero.match(/<form/g)?.length).toBe(1);
    expect(hero.match(/type="submit"/g)?.length).toBe(1);
    expect(hero.match(/ابدأ طلبك/g)?.length).toBe(1);
    // no second action and no list of examples in the first screen; the moving background is its own file (HeroBackdrop), the hero keeps only the shield marker
    expect(hero).not.toContain("<Link");
    expect(hero).not.toContain("landing-ideas");
    expect(hero).not.toContain("landing-mission-templates");
    expect(hero).not.toMatch(/requestAnimationFrame|RecordField|data-lens(?!-shield)|data-px/);
  });

  it("three steps: اطلب، راجع الخطة والسعر، استلم الملف", () => {
    expect(OVERVIEW_STEPS_AR.map((step) => step.title)).toEqual(["اطلب", "راجع الخطة والسعر", "استلم الملف"]);
    for (const step of OVERVIEW_STEPS_AR) expect(html).toContain(step.title);
    expect(html.match(/<li class="flex flex-col gap-2/g)?.length).toBe(3);
  });

  it("the sectors are exactly the catalog's, and the counts are computed from it", () => {
    for (const sector of SERVICES_CATALOG) expect(html).toContain(sector.nameAr);
    expect(html.match(/data-testid="landing-sectors"/g)?.length).toBe(1);
    const counts = catalogCounts();
    expect(text).toContain(`${sectorsCountAr(counts.sectors)} من ${platformsCountAr(counts.platforms)}`);
    expect(html).toContain('href="/services"');
    expect(text).toContain("تصفّح خدماتنا");
  });

  it("a dedicated line on decision makers' work e-mails and phones, with the verification status a field can carry", () => {
    expect(html).toContain('data-testid="landing-decision-makers"');
    expect(text).toContain("صناع القرار وبيانات التواصل المهنية");
    expect(text).toContain("بريد عمله وهاتف مكتبه");
    for (const label of CONTACT_VERIFICATION_LABELS) expect(html).toContain(`>${label}<`);
  });

  it("what is paid is said once, in the merged section: only what is delivered, the rest is a released hold (the approval line is the hero's alone)", () => {
    expect(OVERVIEW_PAYMENT_AR).toBe("تدفع مقابل ما يُسلَّم فعلًا من سجلات مطابقة فقط. يُحجز مبلغ مؤقت يشمل احتياطيًا، وما لا يُستخدم منه حجز مؤقت مُحرَّر.");
    expect(html).toContain(OVERVIEW_PAYMENT_AR);
    expect(text).not.toContain("قبل موافقتك");
    expect(text).not.toContain("قبل أي خصم");
  });

  it("no English, no emoji, no provider word, no number typed by hand in the new section", () => {
    expect(text).not.toMatch(/[A-Za-z]/);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(html.match(PROVIDER_NAME_PATTERN)).toBeNull();
    expect(text).not.toMatch(/[0-9]/);
    for (const line of [...OVERVIEW_STEPS_AR.flatMap((step) => [step.title, step.text]), OVERVIEW_PAYMENT_AR]) expect(line).not.toMatch(/[٠-٩0-9]/);
    expect(hero).not.toMatch(/٠٫١٠|ج\.م/);
  });

  it("detailed prices left the landing page (they stay on /pricing and /calculator); the page stays static", () => {
    expect(page).toContain("<HowItWorks />");
    expect(page).toContain("<WhatYouCanAsk />");
    expect(page).toContain("<SampleFile />");
    expect(page).not.toContain("<Calculator />");
    expect(page).not.toContain("<ProductLines />");
    expect(page).toContain('export const dynamic = "force-static"');
    expect(readFileSync("src/components/landing/Sections.tsx", "utf8")).toContain('href="/pricing"');
    expect(readFileSync("src/components/landing/GlassHeader.tsx", "utf8")).toContain('href="/pricing"');
  });

  it("untouched: the visitor beacon in the layout, the public paths and sign-up / login links", () => {
    const layout = readFileSync("src/app/layout.tsx", "utf8");
    expect(layout).toContain("<AuthProvider><VisitBeacon />{children}</AuthProvider>");
    const header = readFileSync("src/components/landing/GlassHeader.tsx", "utf8");
    expect(header).toContain('href="/login"');
    expect(header).toContain('href="/register"');
    expect(readFileSync("src/lib/publicPaths.ts", "utf8")).toContain('"/services"');
  });
});
