import { agoAr } from "@/components/admin/format";

/** «منذ ٤ دقائق» for server-built payloads (same wording as the UI helper). */
export const agoSince = (iso: string, now: number) => agoAr(iso, now);
