import { readFileSync } from "node:fs";
import path from "node:path";
import type { RegistryArtifact } from "./artifact";
import type { VerificationLevel } from "./evidence";
import type { Operation } from "./registry";
import type { RoutingFacts } from "./router";

/**
 * PHASE 4: the router's facts from the reviewed registry artifact (`data/capabilities/registry.json`), read once per process like the catalog snapshot (process.cwd()/data). Worker only (not exported from the capabilities index, so the
 * website never bundles it). Read only when the `registry_router` switch is on for the mission's account.
 */
let cached: RegistryArtifact | null = null;
export function loadRegistryArtifact(dir: string = path.join(process.cwd(), "data", "capabilities")): RegistryArtifact {
  if (cached) return cached;
  cached = JSON.parse(readFileSync(path.join(dir, "registry.json"), "utf-8")) as RegistryArtifact;
  return cached;
}

/** The router's minimum level: production accounts use production-eligible capabilities only; test accounts may use fixture- or live-verified ones (audit §8.2). */
export const minLevelFor = (isTestAccount: boolean): VerificationLevel => (isTestAccount ? "fixture_verified" : "production_eligible");

/** Routing facts from an artifact. Pure. A capability the artifact does not know is «advertised» (never above the minimum by accident). */
export function routingFactsOf(a: RegistryArtifact, options: { minLevel: VerificationLevel; healthOf?: RoutingFacts["healthOf"]; maxUsdPerCall?: number }): RoutingFacts {
  const levels = new Map(a.capabilities.map((c) => [`${c.id}#${c.operation}`, c.verification.level] as const));
  const measured = new Map(a.capabilities.filter((c) => c.reliability.diger).map((c) => [c.id, c.reliability.diger!] as const));
  return {
    levelOf: (id: string, operation: Operation) => levels.get(`${id}#${operation}`) ?? "advertised",
    measuredOf: (id: string) => measured.get(id) ?? null,
    minLevel: options.minLevel,
    ...(options.healthOf ? { healthOf: options.healthOf } : {}),
    ...(typeof options.maxUsdPerCall === "number" ? { maxUsdPerCall: options.maxUsdPerCall } : {}),
  };
}
