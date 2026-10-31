/** Arabic-script labels for customer-facing deliverable formats. */
export const CUSTOMER_FORMAT_LABEL_AR: Record<string, string> = {
  xlsx: "ملف إكسل",
  pdf: "ملف بي دي إف",
};

export function customerFormatLabelAr(format: string): string {
  return CUSTOMER_FORMAT_LABEL_AR[format.toLowerCase()] || "ملف بيانات";
}
