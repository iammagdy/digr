"use client";

import { useEffect, useState } from "react";
import { DRIVER_STATUS_CACHE_MS, normalizeDriverMode, type DriverMode } from "@/lib/driverMode";

let cached: DriverMode | null = null;
let cachedAt = 0;

/** Whether the always-on driver is LIVE right now, read from the server and refreshed every DRIVER_STATUS_CACHE_MS while the page is visible. «tab» until the server says «cron»: never assumed. */
export function useDriverMode(): DriverMode {
  const [mode, setMode] = useState<DriverMode>(cached ?? "tab");
  useEffect(() => {
    let alive = true;
    const load = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (cached && Date.now() - cachedAt < DRIVER_STATUS_CACHE_MS) { setMode(cached); return; }
      fetch("/api/driver-status", { cache: "no-store" })
        .then((response) => response.json())
        .then((data) => {
          cached = normalizeDriverMode(data?.mode);
          cachedAt = Date.now();
          if (alive) setMode(cached);
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, DRIVER_STATUS_CACHE_MS);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  return mode;
}
