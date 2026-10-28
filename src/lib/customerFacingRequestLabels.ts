import { CHAIN_CAPABILITY_SLUG } from "./multiProvider/routes";

/** Customer-safe Arabic labels for internal research capability identifiers. */
export function customerFacingCapabilityLabel(slug?: string | null): string {
  const value = String(slug || "").toLowerCase();
  // a mission of the agent (several stages, any platform): its own word
  if (value === "agent-mission") return "مهمة بيانات";
  // The multi-provider contact capability: its own word (its id carries «contact», which would read as people).
  if (value === CHAIN_CAPABILITY_SLUG) return "بيانات تواصل الشركات";
  if (value.includes("people") || value.includes("contact") || value.includes("lead") || value.includes("decision")) {
    return "صناع القرار والمسؤولين";
  }
  if (value.includes("company") || value.includes("companies") || value.includes("b2b")) {
    return "الشركات والأعمال";
  }
  if (value.includes("tiktok")) return "تيك توك";
  if (value.includes("instagram")) return "إنستغرام";
  if (value.includes("youtube")) return "يوتيوب";
  if (value.includes("facebook")) return "فيسبوك";
  if (value.includes("linkedin")) return "لينكدإن";
  if (value.includes("reddit")) return "ريديت";
  if (value.startsWith("x-") || value.includes("twitter")) return "إكس";
  return "بحث";
}

export function customerFacingQuoteSummary(slug?: string | null): string | undefined {
  if (!slug) return undefined;
  return `طلب ${customerFacingCapabilityLabel(slug)}`;
}

/** The request's name in an e-mail: «بحث تيك توك», or «بحثك» when the capability has no customer word. Never an internal id. */
export function customerEmailJobTitle(slug?: string | null): string {
  const label = customerFacingCapabilityLabel(slug);
  return label === "بحث" ? "بحثك" : `بحث ${label}`;
}
