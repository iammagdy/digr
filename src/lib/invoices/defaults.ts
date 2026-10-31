/** The payment text prefilled on a new document from the saved Instapay address. The owner can edit it while the document is a draft. */
export function defaultPaymentInstructions(instapayAddress: string): string {
  const ipa = instapayAddress.trim();
  return ipa ? `الدفع عبر إنستا باي على العنوان: ${ipa}\nيرجى كتابة رقم الوثيقة في خانة المرجع عند التحويل.` : "";
}
