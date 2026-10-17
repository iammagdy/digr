export interface ChatTimelineItem {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface ChatTimelineJob {
  jobId: string;
  status: string;
  errorAr?: string;
  updatedAt?: string;
  events?: Array<{
    $id?: string;
    id?: string;
    textAr?: string;
    kind?: string;
    createdAt?: string;
  }>;
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Keep conversation turns in timestamp order and attach one terminal job error
 * as an assistant turn. Job events can echo the same error with separate ids,
 * so matching terminal error text is collapsed after id-based message dedupe.
 */
export function buildChatTimeline<T extends ChatTimelineItem>(
  messages: T[],
  job?: ChatTimelineJob | null
): Array<T | (ChatTimelineItem & { jobFailure: true })> {
  const byId = new Map<string, T>();
  const stableOrder = new Map<string, number>();

  for (const message of messages) {
    if (!message?.id) continue;
    const existing = byId.get(message.id);
    if (existing) {
      // Preserve content from the first saved turn, while allowing later fetches
      // of the same id to fill structured fields such as a refreshed quote.
      byId.set(message.id, {
        ...message,
        ...existing,
        content: existing.content,
        createdAt: existing.createdAt,
      });
      continue;
    }
    stableOrder.set(message.id, stableOrder.size);
    byId.set(message.id, message);
  }

  const uniqueMessages: Array<T | (ChatTimelineItem & { jobFailure: true })> = [...byId.values()];
  if (job?.status === "failed") {
    const eventError = job.events?.find((event) => event.kind === "error" && event.textAr);
    const candidate = job.errorAr
      ? { id: `job_error_${job.jobId}`, textAr: job.errorAr, createdAt: job.updatedAt }
      : eventError
        ? { id: eventError.$id || eventError.id || `job_error_${job.jobId}`, textAr: eventError.textAr!, createdAt: eventError.createdAt }
        : null;
    if (candidate) {
      const text = normalizedText(candidate.textAr);
      if (text) {
        const id = candidate.id || `job_error_${job.jobId}`;
        const existingErrors = uniqueMessages.filter(
          (message) => message.role === "assistant" && normalizedText(message.content) === text,
        );
        if (existingErrors.length) {
          const keep = existingErrors[0];
          const canonicalTime = candidate.createdAt || keep.createdAt;
          const deduped = uniqueMessages.filter(
            (message) => message === keep || !(message.role === "assistant" && normalizedText(message.content) === text),
          );
          uniqueMessages.splice(0, uniqueMessages.length, ...deduped);
          const keepIndex = uniqueMessages.indexOf(keep);
          uniqueMessages[keepIndex] = { ...keep, createdAt: canonicalTime };
        } else if (!byId.has(id)) {
          const fallbackTime = uniqueMessages.at(-1)?.createdAt || new Date(0).toISOString();
          const errorMessage = {
            id,
            role: "assistant" as const,
            content: candidate.textAr,
            createdAt: candidate.createdAt || fallbackTime,
            jobFailure: true as const,
          };
          uniqueMessages.push(errorMessage);
          stableOrder.set(id, stableOrder.size);
        }
      }
    }
  }

  return uniqueMessages.sort((a, b) => {
    const timeDiff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    if (Number.isFinite(timeDiff) && timeDiff !== 0) return timeDiff;
    return (stableOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (stableOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER);
  });
}
