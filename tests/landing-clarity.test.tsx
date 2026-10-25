import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Overview, OVERVIEW_STEPS_AR, OVERVIEW_TRUST_AR } from "../src/components/landing/Overview";
import { SERVICES_CATALOG, catalogCounts } from "../src/lib/servicesCatalog";
import { platformsCountAr, sectorsCountAr } from "../src/lib/servicesCatalogText";
import { CONTACT_VERIFICATION_LABELS } from "../src/lib/contactVerification";
import { PROVIDER_NAME_PATTERN } from "../src/lib/publicCapabilityIds";

const html = renderToStaticMarkup(createElement(Overview));
const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const hero = readFileSync("src/components/landing/HeroLens.tsx", "utf8");
const page = readFileSync("src/app/page.tsx", "utf8");

describe("landing clarity (Part 3)", () => {
  it("the first screen says in one Arabic sentence what Diger is, and offers one sign-up CTA and one link to «خدماتنا»", () => {
    expect(hero).toContain("اسأل بالعربية، واستلم بيانات منظّمة من مصادر كثيرة في ملف إكسل أو بي دي إف");
    expect(hero).toContain('href={user ? "/dashboard/chat" : "/register"}');
    expect(hero).toContain('href="/services"');
    expect(hero.match(/href="\/services"/g)?.length).toBe(1);
    expect(hero.match(/أنشئ حسابك وابدأ طلبك/g)?.length).toBe(1);
    // the ideas and the mission templates are behind a button, not in the first screen
    expect(hero).toContain('aria-controls="landing-ideas"');
    expect(hero).toContain("{ideasOpen && <div id=\"landing-ideas\">");
    expect(hero).toContain('data-testid="landing-mission-templates"');
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

  it("trust points: you approve before any spend, you pay only for what is delivered, held points are released", () => {
    expect(OVERVIEW_TRUST_AR).toEqual(["توافق على الخطة والسعر قبل أي خصم", "لا تدفع إلا على ما يُسلَّم فعلًا", "ما لا يُستخدم من النقاط المحجوزة هو حجز مؤقت مُحرَّر"]);
    for (const point of OVERVIEW_TRUST_AR) expect(html).toContain(point);
  });

  it("no English, no emoji, no provider word, no number typed by hand in the new section", () => {
    expect(text).not.toMatch(/[A-Za-z]/);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(html.match(PROVIDER_NAME_PATTERN)).toBeNull();
    expect(text).not.toMatch(/[0-9]/);
    for (const line of [...OVERVIEW_STEPS_AR.flatMap((step) => [step.title, step.text]), ...OVERVIEW_TRUST_AR]) expect(line).not.toMatch(/[٠-٩0-9]/);
    expect(hero).not.toMatch(/٠٫١٠|ج\.م/);
  });

  it("detailed prices left the landing page (they stay on /pricing and /calculator); the page stays static", () => {
    expect(page).toContain("<Overview />");
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
