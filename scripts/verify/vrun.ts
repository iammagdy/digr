import { randomUUID } from "node:crypto";
import { SupabaseClient } from "@supabase/supabase-js";

export function newVrunPrefix(): string {
  return `vrun_${Date.now()}_${randomUUID()}_`;
}

export type SetupRequirement = {
  table: string;
  purpose: string;
  row: Record<string, unknown>;
};

export async function createVerifyFixtures(
  supabase: SupabaseClient,
  requirements: SetupRequirement[]
): Promise<void> {
  for (const req of requirements) {
    const { error } = await supabase.rpc("create_verify_fixture", {
      p_table: req.table,
      p_row: req.row,
    });
    if (error) {
      throw new Error(`Failed to create verify fixture for ${req.table} (${req.purpose}): ${error.message}`);
    }
  }
}

export function requireSetupRows(requirements: SetupRequirement[]): never {
  throw new Error(
    [
      "SETUP_REQUIRED: verification stopped before any mutation.",
      "No approved RPC creates the required fixture row(s); do not insert them manually.",
      "Exact required row(s):",
      JSON.stringify(requirements, null, 2),
      "Wait for owner direction or an approved fixture-creation RPC before running this check.",
    ].join("\n"),
  );
}

export async function getTestUserBalance(
  supabase: SupabaseClient,
  userId: string = "00000000-0000-0000-0000-000000000001"
): Promise<number> {
  const { data, error } = await supabase
    .from("credit_ledger")
    .select("delta")
    .eq("user_id", userId);
  if (error) throw error;
  return (data || []).reduce((acc: number, r: { delta: number | string }) => acc + Number(r.delta), 0);
}

