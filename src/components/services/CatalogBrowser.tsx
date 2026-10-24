"use client";

import { useMemo, useState } from "react";
import { SERVICES_CATALOG, servicesByGroup, type CatalogPlatform, type CatalogService } from "@/lib/servicesCatalog";
import { platformsProvenFirst } from "@/lib/servicesAvailability";
import { normalizeArabicSearch, platformsCountAr, servicesCountAr } from "@/lib/servicesCatalogText";

/** The platforms are collapsed: a platform's services are rendered only once it is opened (or when a search narrows the list to a few). */
const AUTO_OPEN_AT_MOST = 6;

/** Every word of the query must be found (as part of a word) in the text: «بريد مهني» finds «البريد المهني». */
const hasAllWords = (text: string, words: string[]): boolean => words.every((word) => text.includes(word));

function searchable(platform: CatalogPlatform) {
  return { head: normalizeArabicSearch(`${platform.nameAr} ${platform.descAr}`), services: platform.services.map((service) => normalizeArabicSearch(`${service.nameAr} ${service.explainAr} ${service.group}`)) };
}

// Within a sector, platforms with at least one proven service come first (internal list; nothing about it is shown).
const INDEX = SERVICES_CATALOG.map((sector) => ({ sector, platforms: platformsProvenFirst(sector.platforms).map((platform) => ({ platform, text: searchable(platform) })) }));

function PlatformCard({ platform, services, forceOpen, searching }: { platform: CatalogPlatform; services: CatalogService[]; forceOpen: boolean; searching: boolean }) {
  const [open, setOpen] = useState(false);
  const shown = forceOpen || open;
  const panelId = `p-${platform.slug}`;
  const groups = servicesByGroup({ ...platform, services });
  return (
    <article className="rounded-[20px] border border-ln bg-sf">
      <button type="button" aria-expanded={shown} aria-controls={panelId} onClick={() => setOpen(!open)} className="flex min-h-[64px] w-full items-start justify-between gap-3 rounded-[20px] bg-transparent p-4 text-right text-ink">
        <span className="flex flex-col gap-1">
          <span className="text-base font-semibold">{platform.nameAr}</span>
          <span className="text-[13px] font-light leading-6 text-mut">{platform.descAr}</span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1 text-xs text-mut">
          <span>{servicesCountAr(searching ? services.length : platform.services.length)}</span>
          <span aria-hidden="true" className="text-lg leading-none">{shown ? "−" : "+"}</span>
        </span>
      </button>
      {shown && (
        <div id={panelId} className="flex flex-col gap-4 border-t border-ln px-4 pb-4 pt-3">
          {groups.map(({ group, services: items }) => (
            <section key={group} className="flex flex-col gap-1.5">
              <h4 className="m-0 text-[13px] font-semibold text-ink2">{group}</h4>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {items.map((service) => (
                  <li key={service.slug} className="flex flex-col gap-0.5 text-sm leading-7 text-ink">
                    <span className="font-medium">{service.nameAr}</span>
                    <span className="text-[13px] font-light leading-6 text-mut">{service.explainAr}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </article>
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
  const autoOpen = q !== "" && platformTotal <= AUTO_OPEN_AT_MOST;

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
      <nav aria-label="القطاعات" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {result.map(({ sector }) => (
          <a key={sector.id} href={`#${sector.id}`} className="flex min-h-11 shrink-0 items-center rounded-full border border-ln bg-sf px-4 text-sm text-ink no-underline">{sector.nameAr}</a>
        ))}
      </nav>
      {result.map(({ sector, matches }) => (
        <section key={sector.id} id={sector.id} aria-labelledby={`h-${sector.id}`} className="flex scroll-mt-24 flex-col gap-3">
          <div>
            <h3 id={`h-${sector.id}`} className="m-0 font-display text-[22px] font-medium text-ink">{sector.nameAr}</h3>
            <p className="m-0 mt-1 text-sm font-light leading-7 text-mut">{sector.descAr}</p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {matches.map(({ platform, services }) => (
              <PlatformCard key={platform.slug} platform={platform} services={services} forceOpen={autoOpen} searching={q !== ""} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
