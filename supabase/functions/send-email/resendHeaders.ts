/** Pure Resend request headers; deterministic keys prevent duplicate transactional sends on retries. */
export function buildResendHeaders(resendKey: string, idempotencyKey?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${resendKey}`,
    "Content-Type": "application/json",
    ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
  };
}
