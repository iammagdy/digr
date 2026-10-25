/**
 * The profile picture, the parts that need no browser: limits, the object path, the checks and the Arabic texts.
 * Storage: a PRIVATE bucket «avatars», one object per user at {userId}/avatar.{jpg|png|webp}, at most 2 MB. Nothing here is shown to the customer
 * except the Arabic messages: never a path, an id or a storage error.
 */
export const AVATAR_BUCKET = "avatars";
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
/** A picture larger than this is refused before it is even decoded (a phone photo is far below it; the browser shrinks it to AVATAR_MAX_SIDE). */
export const AVATAR_SOURCE_MAX_BYTES = 12 * 1024 * 1024;
export const AVATAR_MAX_SIDE = 512;
export const AVATAR_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type AvatarMime = (typeof AVATAR_TYPES)[number];

const EXTENSION: Record<AvatarMime, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

export type AvatarProblem = "type" | "too_large" | "failed" | "unavailable" | "unreadable";

export const AVATAR_MESSAGES_AR = {
  type: "الملف ليس صورة مدعومة. اختر صورة بصيغة جي بي جي أو بي إن جي أو ويب بي.",
  too_large: "حجم الصورة كبير. اختر صورة لا يتجاوز حجمها ٢ ميجابايت.",
  unreadable: "تعذّرت قراءة هذه الصورة. جرّب صورة أخرى.",
  failed: "تعذّر رفع الصورة. حاول مرة أخرى بعد قليل.",
  unavailable: "الصورة الشخصية غير متاحة الآن. سيبقى الحرف الأول من اسمك ظاهرًا مكانها.",
  saved: "تم حفظ الصورة.",
  removed: "تم حذف الصورة.",
  removeFailed: "تعذّر حذف الصورة. حاول مرة أخرى بعد قليل.",
  hint: "صورة واضحة بصيغة جي بي جي أو بي إن جي أو ويب بي، لا يتجاوز حجمها ٢ ميجابايت.",
} as const;

export function avatarExtension(mime: string): string | null {
  return (EXTENSION as Record<string, string>)[mime] ?? null;
}

/** {userId}/avatar.{ext}: the only shape the storage policies accept. Null for a type that is not allowed. */
export function avatarObjectPath(userId: string, mime: string): string | null {
  const ext = avatarExtension(mime);
  return ext && userId ? `${userId}/avatar.${ext}` : null;
}

/** True when the saved path is this user's own avatar object (a path of another folder is never read, removed or shown). */
export function isOwnAvatarPath(userId: string, path: unknown): path is string {
  return typeof path === "string" && userId.length > 0 && path.startsWith(`${userId}/`) && /^[^/]+\/avatar\.(?:jpg|png|webp)$/.test(path);
}

/** The checks made on the file the visitor picked, before anything is read or sent. */
export function validateAvatarSource(file: { type: string; size: number }): AvatarProblem | null {
  if (!(AVATAR_TYPES as readonly string[]).includes(file.type)) return "type";
  if (!Number.isFinite(file.size) || file.size <= 0) return "unreadable";
  if (file.size > AVATAR_SOURCE_MAX_BYTES) return "too_large";
  return null;
}

/** The size after shrinking: the longest side at most `max`, the proportions kept, never enlarged. */
export function fitWithin(width: number, height: number, max = AVATAR_MAX_SIDE): { width: number; height: number } {
  const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
  const scale = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** The shrunk picture must still fit the bucket's limit. */
export function validateAvatarResult(blob: { type: string; size: number }): AvatarProblem | null {
  if (!(AVATAR_TYPES as readonly string[]).includes(blob.type)) return "unreadable";
  return blob.size > AVATAR_MAX_BYTES ? "too_large" : null;
}

/**
 * What a failed upload means for the customer. A bucket or a policy that is not there yet (the SQL is applied by hand, later) is «unavailable»,
 * said calmly; anything else is a failed upload. The raw error is never shown.
 */
export function classifyUploadError(error: { message?: string; statusCode?: string | number; status?: number } | null | undefined): AvatarProblem {
  const text = String(error?.message ?? "");
  const status = Number(error?.statusCode ?? error?.status ?? 0);
  if (/bucket|row-level security|policy|not found|does not exist/i.test(text) || status === 404 || status === 403) return "unavailable";
  if (/exceed|too large|payload|size/i.test(text) || status === 413) return "too_large";
  return "failed";
}
