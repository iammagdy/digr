import { createAdminClient } from "@/lib/supabase/server";
import { dailyCapPointsFor } from "@/lib/calculatorPricing";
import { resolveProviderLimits } from "./providerLimits";

const READ_TIMEOUT_MS = 2000;

/**
 * The live daily limit as customer POINTS (never the provider USD value): the ONE input every public page passes to the shared
 * one-job sizing, so the calculator, the estimate box and the segment pages cannot disagree. Undefined when the limit cannot
 * be read in time; the sizing then uses the built-in defaults, exactly as before.
 */
export async function liveDailyCapPoints(): Promise<number | undefined> {
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("daily_cap_timeout")), READ_TIMEOUT_MS); });
    try {
      const { limits } = await Promise.race([resolveProviderLimits(createAdminClient()), late]);
      return dailyCapPointsFor(limits.dailyUsd);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch {
    return undefined;
  }
}
