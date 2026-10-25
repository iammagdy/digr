/**
 * Which numbered steps of the top-up card show as done. Shown only: the server never reads it, and no button waits for it.
 * Step 1 is done while the amount is valid, step 2 once the amount on the screen was copied, step 3 once a receipt is attached.
 */
export function topupStepsDone(input: { amountValid: boolean; amountCopied: boolean; receiptAttached: boolean }): [boolean, boolean, boolean] {
  return [input.amountValid, input.amountValid && input.amountCopied, input.receiptAttached];
}
