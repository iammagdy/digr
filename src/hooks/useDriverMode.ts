"use client";

import { useEffect, useState } from "react";
import { normalizeDriverMode, type DriverMode } from "@/lib/driverMode";

let cached: DriverMode | null = null;

/** Which driver runs long jobs, read once from the server. «tab» until the server says «cron»: never assumed. */
export function useDriverMode(): DriverMode {
  const [mode, setMode] = useState<DriverMode>(cached ?? "tab");
  useEffect(() => {
    if (cached) return;
    let alive = true;
    fetch("/api/driver-status", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        cached = normalizeDriverMode(data?.mode);
        if (alive) setMode(cached);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return mode;
}
