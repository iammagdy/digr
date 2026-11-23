"use client";

import Link from "next/link";
import { useState } from "react";
import type { SellableCapabilityItem } from "@/lib/servicesCatalogView";

export function CapabilityCard({ item }: { item: SellableCapabilityItem }) {
  const [showAllColumns, setShowAllColumns] = useState(false);
  const visibleColumns = showAllColumns ? item.outputColumnsAr : item.outputColumnsAr.slice(0, 4);
  const hasMoreColumns = item.outputColumnsAr.length > 4;

  const chatHref = `/dashboard/chat?prompt=${encodeURIComponent(item.sampleQueryAr)}`;

  return (
    <article
      data-testid={`capability-card-${item.id}`}
      className="flex flex-col justify-between gap-4 rounded-[22px] border border-ln bg-sf p-5 text-start shadow-sm transition-all hover:border-ln2 hover:shadow-md"
    >
      <div className="flex flex-col gap-3">
        {/* Header: Title and Pricing/Feature Badge */}
        <div className="flex items-start justify-between gap-2">
          <h3 className="m-0 text-[18px] font-semibold leading-snug text-ink">
            {item.titleAr}
          </h3>
          {item.badgeAr && (
            <span className="shrink-0 rounded-full bg-[color-mix(in_oklab,var(--ac)_12%,var(--sf))] px-2.5 py-0.5 text-[11px] font-medium text-ac">
              {item.badgeAr}
            </span>
          )}
        </div>

        {/* Short Summary */}
        <p className="m-0 text-[14px] font-light leading-[1.8] text-ink2 [text-wrap:pretty]">
          {item.summaryAr}
        </p>

        {/* Deliverable File Columns Section */}
        {item.outputColumnsAr.length > 0 && (
          <div className="flex flex-col gap-2 rounded-[16px] bg-sf2/70 p-3 text-[12px]">
            <span className="font-medium text-mut">محتويات ملف النتائج المعتمدة:</span>
            <div className="flex flex-wrap gap-1.5">
              {visibleColumns.map((col, idx) => (
                <span
                  key={idx}
                  className="rounded-md border border-ln/60 bg-sf px-2 py-0.5 text-[11px] text-ink2"
                >
                  {col}
                </span>
              ))}
              {hasMoreColumns && (
                <button
                  type="button"
                  onClick={() => setShowAllColumns(!showAllColumns)}
                  className="cursor-pointer border-0 bg-transparent p-0 text-[11px] font-medium text-goldT hover:underline"
                >
                  {showAllColumns ? "عرض أقل ↑" : `+ ${item.outputColumnsAr.length - 4} أعمدة أخرى`}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Footer: Pricing Unit (if any) and Action Path */}
      <div className="mt-2 flex items-center justify-between gap-2 border-t border-ln/60 pt-3">
        {item.pricingUnitLabelAr ? (
          <span className="text-[12px] font-light text-mut">
            {item.pricingUnitLabelAr}
          </span>
        ) : (
          <span className="text-[12px] font-light text-mut">حسب خطة الطلب</span>
        )}

        <Link
          href={chatHref}
          data-testid={`order-btn-${item.id}`}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-ac px-5 text-[13px] font-medium text-onac no-underline transition-transform hover:scale-[1.02] active:scale-[0.98]"
        >
          <span>اطلب الآن</span>
          <span aria-hidden="true">←</span>
        </Link>
      </div>
    </article>
  );
}
