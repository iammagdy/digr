"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { SERVICES_CATALOG, type CatalogPlatform, type CatalogService } from "@/lib/servicesCatalog";
import { platformsProvenFirst } from "@/lib/servicesAvailability";
import { platformHref } from "@/lib/servicesCatalogView";
import { PlatformTile } from "@/components/services/PlatformTile";
import { formatAr } from "@/lib/arabicDigits";
import { normalizeArabicSearch, platformsCountAr, servicesCountAr } from "@/lib/servicesCatalogText";

/** Every word of the query must be found (as part of a word) in the text: «بريد مهني» finds «البريد المهني». */
const hasAllWords = (text: string, words: string[]): boolean => words.every((word) => text.includes(word));

function searchable(platform: CatalogPlatform) {
  return { head: normalizeArabicSearch(`${platform.nameAr} ${platform.descAr}`), services: platform.services.map((service) => normalizeArabicSearch(`${service.nameAr} ${service.explainAr} ${service.group}`)) };
}

// Within a sector, platforms with at least one proven service come first (internal list; nothing about it is shown).
const INDEX = SERVICES_CATALOG.map((sector) => ({ sector, platforms: platformsProvenFirst(sector.platforms).map((platform) => ({ platform, text: searchable(platform) })) }));

/** A platform's card: tile, name, one-line description, how many services it holds. While searching it also names up to two matching services. */
function PlatformCard({ platform, sectorId, matched, searching }: { platform: CatalogPlatform; sectorId: string; matched: CatalogService[]; searching: boolean }) {
  return (
    <Link
      href={platformHref(platform.slug)}
      className="group flex min-h-[132px] flex-col gap-3 rounded-[20px] border border-ln bg-sf p-4 text-ink no-underline transition-colors hover:border-ln2 hover:bg-sf2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ac"
    >
      <span className="flex items-start gap-3">
        <PlatformTile nameAr={platform.nameAr} sectorId={sectorId} />
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-base font-semibold leading-6">{platform.nameAr}</span>
          <span className="text-[13px] font-light leading-6 text-mut">{platform.descAr}</span>
        </span>
      </span>
      {searching && matched.length > 0 && matched.length < platform.services.length && (
        <span className="flex flex-col gap-0.5 border-t border-ln pt-2 text-[13px] leading-6 text-ink2">
          {matched.slice(0, 2).map((service) => <span key={service.slug}>{service.nameAr}</span>)}
        </span>
      )}
      <span className="mt-auto flex items-center justify-between text-xs text-mut">
        <span>{searching && matched.length !== platform.services.length ? `${servicesCountAr(matched.length)} مطابقة` : servicesCountAr(platform.services.length)}</span>
        <span aria-hidden="true" className="text-base leading-none text-ink2 transition-transform group-hover:-translate-x-0.5">←</span>
      </span>
    </Link>
  );
}

export function CatalogBrowser() {
  const [query, setQuery] = useState("");
  const q = normalizeArabicSearch(query);
  const result = useMemo(() => {
    const words = q === "" ? [] : q.split(" ");
    return INDEX.map(({ sector, platforms }) => {
      const matches = platforms
        .map(({ platform, text }) => {
          if (!q) return { platform, services: platform.services, total: platform.services.length };
          if (hasAllWords(text.head, words)) return { platform, services: platform.services, total: platform.services.length };
          const services = platform.services.filter((_, index) => hasAllWords(text.services[index], words));
          return { platform, services, total: services.length };
        })
        .filter((entry) => entry.total > 0);
      return { sector, matches };
    }).filter((entry) => entry.matches.length > 0);
  }, [q]);
  const platformTotal = result.reduce((sum, entry) => sum + entry.matches.length, 0);
  
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <label htmlFor="services-search" className="text-sm font-semibold text-ink">ابحث عن منصة أو خدمة</label>
        <input
          id="services-search"
          type="search"
          dir="rtl"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="مثال: تعليقات، أسعار، بريد مهني، فيسبوك"
          className="min-h-12 w-full rounded-full border border-ln2 bg-sf px-5 text-[15px] text-ink outline-none focus:border-ac"
        />
        {q !== "" && <p role="status" className="m-0 text-sm text-mut">{platformTotal === 0 ? "لا توجد نتيجة مطابقة. جرّب كلمة أخرى." : `${platformsCountAr(platformTotal)} تحتوي ما بحثت عنه`}</p>}
      </div>
      <nav aria-label="القطاعات" className="sticky top-0 z-10 -mx-4 overflow-x-auto bg-bg/90 px-4 py-2 backdrop-blur min-[760px]:-mx-5 min-[760px]:px-5">
        <div className="flex gap-2">
          {result.map(({ sector, matches }) => (
            <a key={sector.id} href={`#${sector.id}`} className="flex min-h-11 shrink-0 items-center gap-2 rounded-full border border-ln bg-sf px-4 text-sm text-ink no-underline hover:border-ln2">
              {sector.nameAr}
              <span className="text-xs text-mut">{formatAr(matches.length)}</span>
            </a>
          ))}
        </div>
      </nav>
      {result.map(({ sector, matches }) => (
        <section key={sector.id} id={sector.id} aria-labelledby={`h-${sector.id}`} className="flex scroll-mt-20 flex-col gap-4">
          <div>
            <h3 id={`h-${sector.id}`} className="m-0 flex items-baseline gap-2 font-display text-[26px] font-medium text-ink">
              {sector.nameAr}
              <span className="font-sans text-sm font-normal text-mut">{platformsCountAr(matches.length)}</span>
            </h3>
            <p className="m-0 mt-1 text-sm font-light leading-7 text-mut">{sector.descAr}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {matches.map(({ platform, services }) => (
              <PlatformCard key={platform.slug} platform={platform} sectorId={sector.id} matched={services} searching={q !== ""} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
