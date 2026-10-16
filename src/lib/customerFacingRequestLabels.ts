/** Customer-safe Arabic labels for internal research capability identifiers. */
export function customerFacingCapabilityLabel(slug?: string | null): string {
  const value = String(slug || "").toLowerCase();
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
