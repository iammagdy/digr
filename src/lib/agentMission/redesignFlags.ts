import { contractTypeOf, type ContractStageLike } from "./taskContracts";
import { redesignActive, type RedesignFlags, type RedesignType } from "./redesignFlagTypes";

// The pure constants and readers live in redesignFlagTypes.ts (no catalog, no file access), so the admin screen can import them without pulling the server code into the browser bundle.
export * from "./redesignFlagTypes";

export type BuiltBy = "code" | "model";

/**
 * THE STAGE 1 ORDERING GATE (docs/REDESIGN-PLAN.md section 4.3): raw delivery is effective only when the type's flag is active for this account AND the stored recipe was BUILT BY CODE from the tool's own fields
 * (`built_by === "code"`, set when the request is built by code). A recipe the model wrote never runs raw, whatever the flag says: raw delivery of an under-specified request would deliver everything the source returns.
 */
export function rawDeliveryEffective(input: { flags: RedesignFlags; type: RedesignType; isTest: boolean; builtBy: BuiltBy | undefined }): boolean {
  return input.builtBy === "code" && redesignActive(input.flags, input.type, { isTest: input.isTest });
}

/** The request type of a plan, from the shape of its stages (the same rule the file contract uses): posts (an account's posts when the customer named the account), comments, companies, people, places. */
export function redesignTypeOf(stages: ReadonlyArray<Pick<ContractStageLike, "key" | "title_ar" | "parent_key" | "deliver" | "role_preference" | "endpoint_id">>, facts: { account: boolean }, capabilityOf?: (endpointId: string) => string | null): RedesignType {
  switch (contractTypeOf(stages, capabilityOf)) {
    case "comments": return "social_comments";
    case "companies": return "companies";
    case "companies_people": return "people";
    case "places": return "places";
    default: return facts.account ? "social_account" : "social_posts";
  }
}
