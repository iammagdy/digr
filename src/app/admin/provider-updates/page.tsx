"use client";

import { useEffect, useState, useCallback } from "react";
import { adminFetch } from "@/lib/adminApi";
import { agoAr } from "@/components/admin/format";
import { ProviderUpdatesView } from "@/components/admin/providerUpdates/ProviderUpdatesView";
import type { ProviderUpdatesFeedPayload } from "@/components/admin/providerUpdates/types";

const POLL_INTERVAL_MS = 30_000;

export default function AdminProviderUpdatesPage() {
  const [payload, setPayload] = useState<ProviderUpdatesFeedPayload | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchFeed = useCallback(async () => {
    try {
      const data = await adminFetch<ProviderUpdatesFeedPayload>("/api/admin/provider-updates");
      if (data && Array.isArray(data.updates)) {
        setPayload(data);
        setLastFetchedAt(new Date().toISOString());
        setError(null);
      } else {
        setError("تعذر تحميل التغذية بالشكل المتوقع.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذر الاتصال بالخادم.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchFeed();
    const timer = setInterval(() => {
      void fetchFeed();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [fetchFeed]);

  return (
    <div className="flex flex-col gap-6" data-screen-label="ProviderUpdates">
      {/* Header bar with live auto-refresh pulse */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-ln pb-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-ink">تحديثات المزوّدين</h1>
          <p className="mt-1 text-xs text-mut">
            ما أضافه أو عدّله أو أوقفه مزودو البيانات وتقارير دراستها قبل الدمج.
          </p>
        </div>

        <div className="flex items-center gap-2 rounded-full border border-ln2 bg-sf px-3.5 py-1.5 text-xs font-semibold text-mut shadow-sm">
          <span
            className="h-2 w-2 rounded-full bg-ok"
            style={{ animation: "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite" }}
          />
          <span data-testid="live-status-indicator">
            محدَّث تلقائيًا {lastFetchedAt ? `(${agoAr(lastFetchedAt)})` : ""}
          </span>
        </div>
      </div>

      {loading && !payload ? (
        <div className="flex h-64 flex-col items-center justify-center gap-3 rounded-2xl bg-sf2 motion-safe:animate-pulse">
          <span className="text-sm font-semibold text-mut">جارٍ جلب تحديثات المزودين...</span>
        </div>
      ) : error && !payload ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-bad/30 bg-bad/10 p-8 text-center text-xs text-bad">
          <span>⚠️ {error}</span>
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              void fetchFeed();
            }}
            className="hit min-h-11 rounded-full border border-bad bg-sf px-4 font-semibold text-bad"
          >
            إعادة المحاولة
          </button>
        </div>
      ) : payload ? (
        <ProviderUpdatesView payload={payload} />
      ) : null}
    </div>
  );
}
