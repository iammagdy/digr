import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ServicesCatalogPage from "../src/app/services/page";
import { CapabilityCard } from "../src/components/services/CapabilityCard";
import { ServicesSkeleton } from "../src/components/services/ServicesSkeleton";
import { CatalogDynamicView } from "../src/components/services/CatalogDynamicView";
import {
  getSellableCatalogView,
  defaultColumnsForSector,
  type SellableCapabilityItem,
} from "../src/lib/servicesCatalogView";
import { getLiveServicesCatalog } from "../src/lib/liveServicesCatalog";
import { PROVIDER_NAME_PATTERN } from "../src/lib/publicCapabilityIds";
import { checkCustomerText } from "../src/lib/agentMission/text";

const LATIN = /[A-Za-z]/;
const EMOJI = /\p{Extended_Pictographic}/u;
const MARKDOWN = /[*_`~#]|\]\(|\[\w/;
const textOf = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ");

describe("FX-CAT Ph3: /services Page Redesign Spec & Components", () => {
  const liveCatalog = getLiveServicesCatalog();
  const catalogView = getSellableCatalogView(liveCatalog);

  it("1. Data Contract: getSellableCatalogView matches live catalog count and 10 groups", () => {
    expect(catalogView.groups.length).toBe(10);
    expect(catalogView.totalCapabilitiesCount).toBe(liveCatalog.counts.services);
    expect(catalogView.totalCapabilitiesCount).toBe(999);

    const sumItems = catalogView.groups.reduce((acc, g) => acc + g.items.length, 0);
    expect(sumItems).toBe(catalogView.totalCapabilitiesCount);

    for (const group of catalogView.groups) {
      expect(group.id).toMatch(/^s\d+$/);
      expect(group.nameAr).toMatch(/[؀-ۿ]/u);
      expect(group.descAr).toMatch(/[؀-ۿ]/u);
      expect(group.items.length).toBeGreaterThan(0);
      expect(["building", "users", "message", "map-pin", "globe", "apps"]).toContain(group.iconName);
    }
  });

  it("2. Deliverable Columns: every sector has compliant Arabic output columns", () => {
    for (const group of catalogView.groups) {
      const cols = defaultColumnsForSector(group.id);
      expect(cols.length).toBeGreaterThanOrEqual(3);
      for (const col of cols) {
        expect(col).not.toMatch(LATIN);
        expect(col).not.toMatch(EMOJI);
        expect(col).not.toMatch(PROVIDER_NAME_PATTERN);
        const check = checkCustomerText(col);
        expect(check.issues).toHaveLength(0);
      }
    }
  });

  it("3. Quality & Safety: zero Latin, zero emoji, zero provider names in capability items", () => {
    for (const group of catalogView.groups) {
      for (const item of group.items) {
        expect(item.id).toMatch(/^[0-9a-f]{7}$/);
        expect(item.titleAr).toMatch(/[؀-ۿ]/u);
        expect(item.summaryAr).toMatch(/[؀-ۿ]/u);
        expect(item.sampleQueryAr).toMatch(/^أريد /);

        expect(item.titleAr).not.toMatch(LATIN);
        expect(item.titleAr).not.toMatch(EMOJI);
        expect(item.titleAr).not.toMatch(PROVIDER_NAME_PATTERN);

        expect(item.summaryAr).not.toMatch(LATIN);
        expect(item.summaryAr).not.toMatch(EMOJI);
        expect(item.summaryAr).not.toMatch(PROVIDER_NAME_PATTERN);

        if (item.badgeAr) {
          expect(item.badgeAr).not.toMatch(LATIN);
          expect(item.badgeAr).not.toMatch(EMOJI);
        }

        if (item.pricingUnitLabelAr) {
          expect(item.pricingUnitLabelAr).not.toMatch(LATIN);
          expect(item.pricingUnitLabelAr).not.toMatch(EMOJI);
          expect(item.pricingUnitLabelAr).toContain("نقطة");
        }
      }
    }
  });

  it("4. CapabilityCard component: renders metadata, output columns, pricing and chat order link", () => {
    const sampleItem: SellableCapabilityItem = {
      id: "abc1234",
      titleAr: "حصر الشركات حسب النشاط والموقع",
      summaryAr: "استخراج بيانات الشركات والأنشطة التجارية في منطقة معينة",
      outputColumnsAr: [
        "اسم المنشأة",
        "المدينة والمحافظة",
        "الموقع الرسمي",
        "اسم المسؤول",
        "المسمى الوظيفي",
        "البريد المهني",
      ],
      sampleQueryAr: "أريد حصر الشركات في الرياض",
      badgeAr: "صناع القرار",
      pricingUnitLabelAr: "٥ نقاط",
    };

    const html = renderToStaticMarkup(createElement(CapabilityCard, { item: sampleItem }));

    expect(html).toContain('data-testid="capability-card-abc1234"');
    expect(html).toContain("حصر الشركات حسب النشاط والموقع");
    expect(html).toContain("استخراج بيانات الشركات والأنشطة التجارية");
    expect(html).toContain("صناع القرار");
    expect(html).toContain("٥ نقاط");
    expect(html).toContain('data-testid="order-btn-abc1234"');
    expect(html).toContain('/dashboard/chat?prompt=%D8%A3%D8%B1%D9%8A%D8%AF%20%D8%AD%D8%B5%D8%B1%20%D8%A7%D9%84%D8%B4%D8%B1%D9%83%D8%A7%D8%AA%20%D9%81%D9%8A%20%D8%A7%D9%84%D8%B1%D9%8A%D8%A7%D8%B6');
    expect(html).toContain("اطلب الآن");
    expect(html).toContain("+ 2 أعمدة أخرى");

    // Clean text: no English, no emoji
    const cleanText = textOf(html);
    expect(cleanText).not.toMatch(LATIN);
    expect(cleanText).not.toMatch(EMOJI);
  });

  it("5. ServicesSkeleton: renders accessible loading pulse placeholder", () => {
    const html = renderToStaticMarkup(createElement(ServicesSkeleton));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="جارٍ تحميل الكتالوج"');
    expect(html).toContain("animate-pulse");

    // Fast, lightweight HTML
    const count = (html.match(/<div/g) ?? []).length;
    expect(count).toBeLessThan(100);
  });

  it("6. CatalogDynamicView (mounted): renders all 10 groups, 999 cards, sticky nav, and search input", () => {
    const html = renderToStaticMarkup(
      createElement(CatalogDynamicView, { groups: catalogView.groups, initialMounted: true })
    );

    expect(html).toContain('data-testid="catalog-search-input"');
    expect(html).toContain('data-testid="catalog-groups-nav"');

    // All 10 groups rendered
    for (const group of catalogView.groups) {
      expect(html).toContain(`data-testid="group-section-${group.id}"`);
      expect(html).toContain(group.nameAr);
    }

    // All 999 cards rendered
    const cardMatches = html.match(/data-testid="capability-card-/g) ?? [];
    expect(cardMatches.length).toBe(999);

    const orderBtnMatches = html.match(/data-testid="order-btn-/g) ?? [];
    expect(orderBtnMatches.length).toBe(999);
  });

  it("7. CatalogDynamicView (SSR unmounted): renders skeleton placeholder", () => {
    const html = renderToStaticMarkup(
      createElement(CatalogDynamicView, { groups: catalogView.groups, initialMounted: false })
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="جارٍ تحميل الكتالوج"');
    expect(html).not.toContain('data-testid="catalog-search-input"');
  });

  it("8. Empty search state: renders clean empty message and chat CTA without emoji", () => {
    const html = renderToStaticMarkup(
      createElement(CatalogDynamicView, { groups: [], initialMounted: true })
    );

    expect(html).toContain('data-testid="catalog-empty-state"');
    expect(html).toContain('role="status"');
    expect(html).toContain("لم نعثر على خدمات مطابقة لبحثك");
    expect(html).toContain("تحدث مع المساعد الذكي");
    expect(html).toContain('href="/dashboard/chat"');

    const clean = textOf(html);
    expect(clean).not.toMatch(LATIN);
    expect(clean).not.toMatch(EMOJI);
  });

  it("9. ServicesCatalogPage integration: preserves required sections and guards", () => {
    const html = renderToStaticMarkup(createElement(ServicesCatalogPage));

    expect(html).toContain('data-testid="request-groups"');
    expect(html).toContain('data-testid="catalog-all"');
    expect(html).toContain('data-testid="services-counts"');
    expect(html).toContain('data-testid="decision-makers-line"');
    expect(html).toContain('data-testid="core-b2b"');
    expect(html).toContain('data-testid="services-status-line"');
    expect(html).toContain('data-testid="services-bottom-cta"');

    const pageText = textOf(html);
    expect(pageText).not.toMatch(LATIN);
    expect(pageText).not.toMatch(EMOJI);
    expect(html.match(PROVIDER_NAME_PATTERN)).toBeNull();

    // SSR element count is small and fast
    const elements = html.match(/<[a-z][^>]*>/g)?.length ?? 0;
    expect(elements).toBeLessThan(liveCatalog.counts.services + 400);
  });
});
