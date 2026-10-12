import { randomUUID } from "node:crypto";

export function newVrunPrefix(): string {
  return `vrun_${Date.now()}_${randomUUID()}_`;
}

export type SetupRequirement = {
  table: string;
  purpose: string;
  row: Record<string, unknown>;
};

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
