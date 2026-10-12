"use client";

import { useEffect, useState } from "react";
import { databases } from "@/lib/appwrite";
import { DATABASE_ID, SETTINGS_PUBLIC_COLLECTION } from "@/lib/constants";

export const DEFAULT_CREDIT_VALUE_EGP = 0.1;

/** EGP value of one point, from settings_public/pricing (falls back to the documented default). */
export function useCreditValue(): number {
  const [value, setValue] = useState(DEFAULT_CREDIT_VALUE_EGP);
  useEffect(() => {
    let alive = true;
    databases
      .getDocument(DATABASE_ID, SETTINGS_PUBLIC_COLLECTION, "pricing")
      .then((doc) => {
        const v = Number((doc as unknown as { creditValueEgp?: number }).creditValueEgp);
        if (alive && Number.isFinite(v) && v > 0) setValue(v);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return value;
}
