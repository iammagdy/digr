type PersistEditedQuoteInput = {
  conversationId: string;
  userId: string;
  previousQuoteId: string;
  quote: {
    quoteId: string;
    targetVolumeMax: number;
    quotedPoints: number;
  };
};

/** plans_quotes intentionally has no conversation_id column; the saved assistant
 * message is the authoritative relation between a quote and its conversation. */
export async function resolveQuoteConversationId(
  database: any,
  input: { userId: string; quoteId: string; fallbackConversationId?: string | null },
): Promise<string> {
  if (input.fallbackConversationId?.trim()) return input.fallbackConversationId.trim();

  for (const quoteKey of ["quote->>quoteId", "quote->>id"]) {
    const { data, error } = await database
      .from("messages")
      .select("conversation_id")
      .eq("user_id", input.userId)
      .eq(quoteKey, input.quoteId)
      .not("quote", "is", null)
      .limit(2);

    if (error) throw error;
    const conversationIds = [...new Set(
      (data || [])
        .map((message: any) => message?.conversation_id)
        .filter((id: unknown): id is string => typeof id === "string" && id.length > 0),
    )];
    if (conversationIds.length === 1) return conversationIds[0];
    if (conversationIds.length > 1) throw new Error("تعذر تحديد المحادثة المرتبطة بعرض السعر.");
  }

  throw new Error("تعذر العثور على المحادثة المرتبطة بعرض السعر.");
}

/**
 * Keep the saved assistant message in sync with the replacement quote row.
 * Conversation restore reads its quote card from messages.quote, so updating
 * plans_quotes alone leaves the old card visible after a reload.
 */
export async function persistEditedQuoteMessage(database: any, input: PersistEditedQuoteInput): Promise<void> {
  const { data: messages, error: readError } = await database
    .from("messages")
    .select("id, quote")
    .eq("conversation_id", input.conversationId)
    .eq("user_id", input.userId)
    .not("quote", "is", null);

  if (readError) throw readError;

  const matchingMessage = (messages || []).find((message: any) =>
    message?.quote?.quoteId === input.previousQuoteId || message?.quote?.id === input.previousQuoteId
  );

  if (!matchingMessage?.id) {
    throw new Error("تعذر ربط عرض السعر المحدث برسالة المحادثة المحفوظة.");
  }

  const { error: updateError } = await database
    .from("messages")
    .update({
      quote: input.quote,
      content_ar: `تم تعديل تفاصيل الخطة وتحديث عرض السعر:\n• السجلات المعتمدة: حتى ${input.quote.targetVolumeMax} سجل\n• التكلفة الإجمالية: ${input.quote.quotedPoints} نقطة`,
    })
    .eq("id", matchingMessage.id)
    .eq("conversation_id", input.conversationId)
    .eq("user_id", input.userId);

  if (updateError) throw updateError;
}
