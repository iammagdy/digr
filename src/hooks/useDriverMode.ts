"use client";

import { useEffect, useState } from "react";
import { normalizeDriverMode, type DriverMode } from "@/lib/driverMode";

const REFRESH_MS = 60_000;

/**
 * Which driver the page may be told about, read from the server and refreshed every minute. «tab» until the server says «cron», and back to
 * «tab» if the always-on driver stops being seen (the server says «cron» only while the scheduler's last call is under three minutes old).
 */
export function useDriverMode(): DriverMode {
  const [mode, setMode] = useState<DriverMode>("tab");
  useEffect(() => {
    let alive = true;
    const read = () =>
      fetch("/api/driver-status", { cache: "no-store" })
        .then((response) => response.json())
        .then((data) => { if (alive) setMode(normalizeDriverMode(data?.mode)); })
        .catch(() => { if (alive) setMode("tab"); });
    void read();
    const timer = setInterval(read, REFRESH_MS);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  return mode;
}
