"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { SellableCapabilityGroup } from "@/lib/servicesCatalogView";
import { CapabilityCard } from "./CapabilityCard";
import { ServicesSkeleton } from "./ServicesSkeleton";
import { normalizeArabicSearch } from "@/lib/servicesCatalogText";

export function CatalogDynamicView({
  groups,
  initialMounted = false,
}: {
  groups: SellableCapabilityGroup[];
  initialMounted?: boolean;
}) {
  const [mounted, setMounted] = useState(initialMounted);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    setMounted(true);
  }, []);

  const normalizedQuery = normalizeArabicSearch(searchQuery);

  const filteredGroups = useMemo(() => {
    if (!normalizedQuery) return groups;
    const words = normalizedQuery.split(" ").filter(Boolean);

    return groups
      .map((group) => {
        const matchingItems = group.items.filter((item) => {
          const haystack = normalizeArabicSearch(
            `${item.titleAr} ${item.summaryAr} ${item.outputColumnsAr.join(" ")} ${group.nameAr}`
          );
          return words.every((w) => haystack.includes(w));
        });

        return { ...group, items: matchingItems };
      })
      .filter((group) => group.items.length > 0);
  }, [groups, normalizedQuery]);

  const totalMatches = filteredGroups.reduce((acc, g) => acc + g.items.length, 0);

  if (!mounted) {
    return <ServicesSkeleton />;
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Search Input Bar */}
      <div className="flex flex-col gap-2">
        <label htmlFor="catalog-search" className="text-sm font-medium text-ink">
          ابحث في الخدمات المتاحة
        </label>
        <div className="relative w-full">
          <input
            id="catalog-search"
            data-testid="catalog-search-input"
            type="search"
            dir="rtl"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="ابحث بكلمة: شركات، مطاعم، تعليقات، مدير تسويق، تقييمات..."
            className="min-h-12 w-full rounded-full border border-ln2 bg-sf px-5 text-[15px] text-ink outline-none transition-colors focus:border-ac"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="absolute end-4 top-1/2 -translate-y-1/2 cursor-pointer border-0 bg-transparent text-sm text-mut hover:text-ink"
            >
              مسح
            </button>
          )}
        </div>
      </div>

      {/* Sticky Fast Navigation Pills */}
      {filteredGroups.length > 1 && (
        <nav
          data-testid="catalog-groups-nav"
          aria-label="أقسام القدرات"
          className="sticky top-0 z-20 -mx-4 flex gap-2 overflow-x-auto bg-bg/90 px-4 py-2.5 backdrop-blur no-scrollbar min-[760px]:-mx-5 min-[760px]:px-5"
        >
          {filteredGroups.map((group) => (
            <a
              key={group.id}
              href={`#group-${group.id}`}
              className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-ln bg-sf px-4 text-[13px] font-medium text-ink no-underline transition-colors hover:border-ln2 hover:bg-sf2"
            >
              <span>{group.nameAr}</span>
              <span className="text-[11px] text-mut">({group.items.length})</span>
            </a>
          ))}
        </nav>
      )}

      {/* Empty State when search yields no matches */}
      {totalMatches === 0 && (
        <div
          data-testid="catalog-empty-state"
          role="status"
          className="flex flex-col items-center justify-center gap-4 rounded-[24px] border border-ln bg-sf p-10 text-center"
        >
          <div className="flex flex-col gap-1">
            <h3 className="m-0 text-[18px] font-semibold text-ink">
              لم نعثر على خدمات مطابقة لبحثك
            </h3>
            <p className="m-0 text-[14px] font-light text-mut">
              يمكنك كتابة طلبك مباشرة للمساعد الذكي وسيقوم بتجهيز خطة مخصصة وفق المصادر المتاحة.
            </p>
          </div>
          <Link
            href="/dashboard/chat"
            className="inline-flex min-h-11 items-center rounded-full bg-ac px-6 text-sm font-medium text-onac no-underline"
          >
            تحدث مع المساعد الذكي
          </Link>
        </div>
      )}

      {/* Groups and Cards Grid */}
      {filteredGroups.map((group) => (
        <section
          key={group.id}
          id={`group-${group.id}`}
          data-testid={`group-section-${group.id}`}
          className="flex scroll-mt-24 flex-col gap-4"
        >
          <div className="flex flex-col gap-1 border-b border-ln/60 pb-3">
            <div className="flex items-center gap-2">
              <h2 className="m-0 font-display text-[24px] font-semibold text-ink">
                {group.nameAr}
              </h2>
              <span className="rounded-full bg-sf2 px-2.5 py-0.5 text-[12px] font-medium text-mut">
                {group.items.length}
              </span>
            </div>
            <p className="m-0 text-[14px] font-light leading-relaxed text-mut">
              {group.descAr}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {group.items.map((item) => (
              <CapabilityCard key={item.id} item={item} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
