"use client";

import { useMemo, useState } from "react";
import { formatAr } from "@/lib/arabicDigits";
import { StatusBadge, SegmentChips, type BadgeTone } from "../ui";
import { dateTimeAr, tint } from "../format";
import { ProviderUpdateDetailSheet, providerDisplayName } from "./ProviderUpdateDetailSheet";
import type {
  ProviderUpdatesFeedPayload,
  ProviderUpdateFeedRow,
  UpdateKind,
  UpdateStatus,
} from "./types";

const KIND_MAP: Record<UpdateKind, { label: string; tone: BadgeTone }> = {
  new: { label: "ميزة جديدة", tone: "ok" },
  changed: { label: "تعديل متاح", tone: "warn" },
  removed: { label: "إيقاف أو حذف", tone: "bad" },
};

const STATUS_MAP: Record<UpdateStatus, { label: string; tone: BadgeTone }> = {
  new: { label: "جديدة", tone: "gold" },
  studied: { label: "اتدرست", tone: "mute" },
  planned: { label: "في الخطة", tone: "warn" },
  merged: { label: "اندمجت", tone: "ok" },
  rejected: { label: "اترفضت", tone: "bad" },
};

function StatTile({
  label,
  value,
  sublabel,
  unstudied,
}: {
  label: string;
  value: number;
  sublabel?: string;
  unstudied?: number;
}) {
  return (
    <div className="flex flex-col justify-between rounded-2xl border border-ln bg-sf p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-mut">{label}</span>
        {typeof unstudied === "number" && unstudied > 0 && (
          <span className="rounded-full bg-gold px-2 py-0.5 text-[10px] font-bold text-onac">
            {formatAr(unstudied)} جديدة
          </span>
        )}
      </div>
      <div className="mt-3 flex items-baseline gap-2">
        <span className="text-2xl font-bold tracking-tight text-ink">
          {formatAr(value)}
        </span>
        {sublabel && <span className="text-xs text-mut">{sublabel}</span>}
      </div>
    </div>
  );
}

export function ProviderUpdatesView({
  payload,
}: {
  payload: ProviderUpdatesFeedPayload;
}) {
  const [activeProvider, setActiveProvider] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [timeFilter, setTimeFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [selectedItem, setSelectedItem] = useState<ProviderUpdateFeedRow | null>(null);

  // Derive unique providers list dynamically from data
  const providerKeys = useMemo(() => {
    const set = new Set<string>();
    for (const u of payload.updates) {
      if (u.provider) set.add(u.provider);
    }
    return Array.from(set);
  }, [payload.updates]);

  // Derive stats
  const stats = useMemo(() => {
    let unstudied = 0;
    const byP: Record<string, { total: number; unstudied: number }> = {};
    for (const pk of providerKeys) {
      byP[pk] = { total: 0, unstudied: 0 };
    }
    for (const u of payload.updates) {
      if (u.status === "new") unstudied++;
      if (byP[u.provider]) {
        byP[u.provider].total++;
        if (u.status === "new") byP[u.provider].unstudied++;
      }
    }
    return { total: payload.updates.length, unstudied, byP };
  }, [payload.updates, providerKeys]);

  // Provider segment chips
  const segmentItems: Array<[string, string]> = useMemo(() => {
    const list: Array<[string, string]> = [["all", "الكل"]];
    for (const pk of providerKeys) {
      list.push([pk, providerDisplayName(pk)]);
    }
    return list;
  }, [providerKeys]);

  const segmentCounts = useMemo(() => {
    const counts: Record<string, number> = { all: stats.total };
    for (const pk of providerKeys) {
      counts[pk] = stats.byP[pk]?.total ?? 0;
    }
    return counts;
  }, [stats, providerKeys]);

  // Filtered rows
  const filteredUpdates = useMemo(() => {
    const now = Date.now();
    return payload.updates.filter((row) => {
      if (activeProvider !== "all" && row.provider !== activeProvider) return false;
      if (statusFilter !== "all" && row.status !== statusFilter) return false;
      if (kindFilter !== "all" && row.kind !== kindFilter) return false;

      if (timeFilter !== "all") {
        const rowTime = new Date(row.date).getTime();
        const daysAgo = (now - rowTime) / (1000 * 60 * 60 * 24);
        if (timeFilter === "30d" && daysAgo > 30) return false;
        if (timeFilter === "90d" && daysAgo > 90) return false;
      }

      if (searchQuery.trim().length > 0) {
        const q = searchQuery.toLowerCase().trim();
        const haystack = `${row.title_ar} ${row.item} ${row.summary_ar} ${row.brief_ar} ${row.price_ar}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }

      return true;
    });
  }, [payload.updates, activeProvider, statusFilter, kindFilter, timeFilter, searchQuery]);

  return (
    <div className="flex flex-col gap-6" data-testid="provider-updates-view">
      {/* 1. Stat Tiles Grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="إجمالي التحديثات"
          value={stats.total}
          sublabel="تحديث مسجل"
          unstudied={stats.unstudied}
        />
        {providerKeys.map((pk) => (
          <StatTile
            key={pk}
            label={`تحديثات ${providerDisplayName(pk)}`}
            value={stats.byP[pk]?.total ?? 0}
            unstudied={stats.byP[pk]?.unstudied ?? 0}
          />
        ))}
      </div>

      {/* 2. Filter & Search Controls */}
      <div className="flex flex-col gap-3 rounded-2xl border border-ln bg-sf p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SegmentChips
            label="فلاتر المزودين"
            items={segmentItems}
            value={activeProvider}
            counts={segmentCounts}
            onChange={setActiveProvider}
          />

          <div className="flex flex-1 items-center justify-end gap-2">
            <input
              type="text"
              placeholder="بحث في الميزات والملخصات..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="min-h-11 w-full max-w-xs rounded-xl border border-ln2 bg-bg px-3.5 text-xs text-ink placeholder:text-mut focus:border-ac focus:outline-none"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-ln pt-3 text-xs">
          <label className="flex items-center gap-1.5 text-mut">
            <span>الحالة:</span>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="min-h-11 rounded-lg border border-ln2 bg-bg px-2.5 py-1 text-xs text-ink focus:outline-none"
            >
              <option value="all">كل الحالات</option>
              <option value="new">جديدة</option>
              <option value="studied">اتدرست</option>
              <option value="planned">في الخطة</option>
              <option value="merged">اندمجت</option>
              <option value="rejected">اترفضت</option>
            </select>
          </label>

          <label className="flex items-center gap-1.5 text-mut">
            <span>النوع:</span>
            <select
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value)}
              className="min-h-11 rounded-lg border border-ln2 bg-bg px-2.5 py-1 text-xs text-ink focus:outline-none"
            >
              <option value="all">كل الأنواع</option>
              <option value="new">ميزة جديدة</option>
              <option value="changed">تعديل متاح</option>
              <option value="removed">إيقاف أو حذف</option>
            </select>
          </label>

          <label className="flex items-center gap-1.5 text-mut">
            <span>الفترة:</span>
            <select
              value={timeFilter}
              onChange={(e) => setTimeFilter(e.target.value)}
              className="min-h-11 rounded-lg border border-ln2 bg-bg px-2.5 py-1 text-xs text-ink focus:outline-none"
            >
              <option value="all">كل الفترات</option>
              <option value="30d">آخر ٣٠ يومًا</option>
              <option value="90d">آخر ٩٠ يومًا</option>
            </select>
          </label>

          {(activeProvider !== "all" || statusFilter !== "all" || kindFilter !== "all" || timeFilter !== "all" || searchQuery) && (
            <button
              type="button"
              onClick={() => {
                setActiveProvider("all");
                setStatusFilter("all");
                setKindFilter("all");
                setTimeFilter("all");
                setSearchQuery("");
              }}
              className="hit ms-auto min-h-11 cursor-pointer text-xs font-semibold text-bad hover:underline"
            >
              إعادة الضبط
            </button>
          )}
        </div>
      </div>

      {/* 3. Empty State */}
      {filteredUpdates.length === 0 ? (
        <div
          data-testid="empty-feed-state"
          className="flex min-h-[260px] flex-col items-center justify-center rounded-2xl border border-dashed border-ln2 p-8 text-center"
        >
          <span className="mb-3 text-3xl">📡</span>
          <h3 className="text-sm font-bold text-ink">
            {payload.updates.length === 0
              ? "«لا توجد تحديثات مسجلة حتى الآن»"
              : "«لا توجد تحديثات تطابق الفلتر المختار»"}
          </h3>
          <p className="mt-1 text-xs text-mut">
            يرصد بوت الكشّاف التحديثات الجديدة ويسجلها في هذا التبويب تلقائياً.
          </p>
        </div>
      ) : (
        <>
          {/* 4. Desktop Table View (>= 900px) */}
          <div className="hidden overflow-hidden rounded-2xl border border-ln bg-sf shadow-sm md:block">
            <table className="w-full border-collapse text-right text-xs">
              <thead>
                <tr className="border-b border-ln bg-sf2 text-mut">
                  <th className="p-3.5 font-semibold">التاريخ</th>
                  <th className="p-3.5 font-semibold">المزود</th>
                  <th className="p-3.5 font-semibold">النوع</th>
                  <th className="p-3.5 font-semibold">الحالة</th>
                  <th className="p-3.5 font-semibold">الميزة والملخص</th>
                  <th className="p-3.5 font-semibold">التكلفة</th>
                  <th className="p-3.5 font-semibold text-center">الإجراء</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ln">
                {filteredUpdates.map((row) => {
                  const kindInfo = KIND_MAP[row.kind] ?? { label: row.kind, tone: "mute" as BadgeTone };
                  const statusInfo = STATUS_MAP[row.status] ?? { label: row.status, tone: "mute" as BadgeTone };
                  return (
                    <tr
                      key={row.id}
                      data-testid={`update-row-${row.id}`}
                      onClick={() => setSelectedItem(row)}
                      className="cursor-pointer transition-colors hover:bg-sf2"
                    >
                      <td className="whitespace-nowrap p-3.5 text-mut">
                        {dateTimeAr(row.date)}
                      </td>
                      <td className="whitespace-nowrap p-3.5 font-semibold text-ink">
                        {providerDisplayName(row.provider)}
                      </td>
                      <td className="whitespace-nowrap p-3.5">
                        <StatusBadge tone={kindInfo.tone}>{kindInfo.label}</StatusBadge>
                      </td>
                      <td className="whitespace-nowrap p-3.5">
                        <StatusBadge tone={statusInfo.tone}>{statusInfo.label}</StatusBadge>
                      </td>
                      <td className="p-3.5">
                        <div className="font-semibold text-ink">{row.title_ar}</div>
                        <div className="line-clamp-1 text-mut">{row.summary_ar}</div>
                        <div className="mt-0.5 font-mono text-[11px] text-mut opacity-80">{row.item}</div>
                      </td>
                      <td className="whitespace-nowrap p-3.5 font-mono text-ink">
                        {row.price_ar || "—"}
                      </td>
                      <td className="whitespace-nowrap p-3.5 text-center">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedItem(row);
                          }}
                          className="hit min-h-11 rounded-full border border-ln2 bg-sf px-3.5 text-xs font-semibold text-ink hover:border-ln"
                        >
                          التفاصيل
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* 5. Mobile Cards View (< 900px / 390px viewport) */}
          <div className="flex flex-col gap-3 md:hidden" data-testid="mobile-cards-container">
            {filteredUpdates.map((row) => {
              const kindInfo = KIND_MAP[row.kind] ?? { label: row.kind, tone: "mute" as BadgeTone };
              const statusInfo = STATUS_MAP[row.status] ?? { label: row.status, tone: "mute" as BadgeTone };
              return (
                <div
                  key={row.id}
                  data-testid={`update-card-${row.id}`}
                  onClick={() => setSelectedItem(row)}
                  className="flex cursor-pointer flex-col gap-2.5 rounded-2xl border border-ln bg-sf p-4 shadow-sm transition-colors active:bg-sf2"
                  style={{ minHeight: "44px" }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-mut">
                      {providerDisplayName(row.provider)}
                    </span>
                    <span className="text-[11px] text-mut">{dateTimeAr(row.date)}</span>
                  </div>

                  <h4 className="text-sm font-bold text-ink">{row.title_ar}</h4>
                  <p className="line-clamp-2 text-xs leading-relaxed text-mut">{row.summary_ar}</p>

                  <div className="font-mono text-[11px] text-mut opacity-75">{row.item}</div>

                  <div className="mt-1 flex flex-wrap items-center justify-between gap-2 border-t border-ln pt-2.5">
                    <div className="flex items-center gap-1.5">
                      <StatusBadge tone={kindInfo.tone}>{kindInfo.label}</StatusBadge>
                      <StatusBadge tone={statusInfo.tone}>{statusInfo.label}</StatusBadge>
                    </div>
                    <span className="font-mono text-xs font-semibold text-ink">{row.price_ar || "—"}</span>
                  </div>

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedItem(row);
                    }}
                    className="hit mt-1 flex min-h-11 w-full items-center justify-center rounded-xl border border-ln2 bg-sf2 text-xs font-semibold text-ink"
                  >
                    عرض التفاصيل والتقرير
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* 6. Two-Step Detail Sheet */}
      <ProviderUpdateDetailSheet
        item={selectedItem}
        reports={payload.reports}
        onClose={() => setSelectedItem(null)}
      />
    </div>
  );
}
