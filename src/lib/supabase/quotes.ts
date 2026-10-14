import { SupabaseClient } from "@supabase/supabase-js";
import {
  calculateUnitPricePoints,
  calculateQuote,
  calculateFinalSettlement,
  isQuoteExpired,
  generateQuoteExpiry,
  DEFAULT_PRICING_SETTINGS,
  type PricingSettings,
  type PlanItem,
  type QuoteCalculationResult,
} from "../../functions/shared/quotes";
import { computePlanHash } from "../../functions/shared/planManager";
import crypto from "crypto";


export {
  calculateUnitPricePoints,
  calculateQuote,
  calculateFinalSettlement,
  isQuoteExpired,
  generateQuoteExpiry,
  DEFAULT_PRICING_SETTINGS,
  type PricingSettings,
  type PlanItem,
  type QuoteCalculationResult,
};

export interface CreateQuoteRecordOptions {
  userId: string;
  items: PlanItem[] | any[];
  totalReservedCredits: number;
  outputFormats?: string[];
  expiresAt?: string;
  quoteHash?: string;
}

/**
 * Creates and stores a deterministic quote in `plans_quotes` via Service Role.
 * Clients are forbidden from writing to plans_quotes by RLS.
 */
export async function createQuoteRecord(
  adminClient: SupabaseClient,
  options: CreateQuoteRecordOptions
) {
  const quoteId = `quote_${crypto.randomBytes(12).toString("hex")}`;
  const quoteHash = options.quoteHash || computePlanHash(options.items, options.outputFormats);
  const expiresAt = options.expiresAt || generateQuoteExpiry(30);

  const { data, error } = await adminClient
    .from("plans_quotes")
    .insert({
      id: quoteId,
      user_id: options.userId,
      quote_hash: quoteHash,
      status: "quoted",
      items: options.items,
      total_reserved_credits: options.totalReservedCredits,
      output_formats: options.outputFormats || ["xlsx", "csv", "pdf"],
      expires_at: expiresAt,
      created_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create quote record: ${error.message}`);
  }

  return data;
}
