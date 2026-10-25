"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

import { DEFAULT_CREDIT_VALUE_EGP } from "@/lib/creditValue";

export { DEFAULT_CREDIT_VALUE_EGP };

/** EGP value of one point, from settings_public/pricing (falls back to the documented default). */
export function useCreditValue(): number {
  const [value, setValue] = useState(DEFAULT_CREDIT_VALUE_EGP);
  useEffect(() => {
    let alive = true;
    try {
      const supabase = createClient();
      Promise.resolve(
        supabase
          .from("settings_public")
          .select("value")
          .eq("key", "pricing")
          .maybeSingle()
      )
        .then(({ data }) => {
          const v = Number(
            (data?.value as { creditValueEgp?: number; credit_value_egp?: number })?.creditValueEgp ??
            (data?.value as { creditValueEgp?: number; credit_value_egp?: number })?.credit_value_egp
          );
          if (alive && Number.isFinite(v) && v > 0) setValue(v);
        })
        .catch(() => {});
    } catch {
      /* fallback */
    }
    return () => { alive = false; };
  }, []);
  return value;
}
