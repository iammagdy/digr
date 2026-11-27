import { platformOfEndpointId } from "./platformFacts";
import { isSocialPlatform, type SocialPlatform } from "./redesignFlagTypes";

/**
 * The platform a plan is on, from the STRUCTURE of its stages: the capability the code stored, else the platform words of the tool's own id (never a title). The first stage that names one decides.
 * UP2 (D-0240): the words of each platform's tool ids are its facts (data/treg/platform_facts.json; the `x` between a vendor and a job, «tikhub.x.…», is a namespace marker, not the platform: its markers say so);
 * the first platform in `idPrecedence` order whose marker is in the id decides. This lives apart from redesignFlagTypes.ts, which the admin screen bundles in the browser and which must stay import-free.
 */
export function platformOfStages(stages: ReadonlyArray<{ capability?: string; endpoint_id?: string }>): SocialPlatform | null {
  for (const st of stages) {
    const cap = typeof st.capability === "string" ? st.capability.split(".")[0] : "";
    if (isSocialPlatform(cap)) return cap;
    const id = String(st.endpoint_id ?? "").toLowerCase();
    if (!id) continue;
    const byId = platformOfEndpointId(id);
    if (byId !== null) return byId;
  }
  return null;
}
