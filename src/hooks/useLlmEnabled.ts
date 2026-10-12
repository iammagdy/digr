"use client";

import { useEffect, useState } from "react";

/** false → show the «simplified mode» banner. Defaults to true until the server answers. */
export function useLlmEnabled(): boolean {
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    let alive = true;
    fetch("/api/llm-enabled", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (alive && typeof j?.enabled === "boolean") setEnabled(j.enabled); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return enabled;
}
