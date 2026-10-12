import { NextRequest } from "next/server";
import crypto from "node:crypto";

/**
 * Timing-safe authentication for Vercel Cron and internal worker self-chaining.
 * Authenticates against process.env.CRON_SECRET.
 * Supports:
 * - Authorization: Bearer <secret>
 * - x-cron-secret: <secret>
 */
export function verifyCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.trim().length === 0) {
    return false;
  }

  const authHeader = req.headers.get("authorization");
  let providedToken = "";

  if (authHeader?.startsWith("Bearer ")) {
    providedToken = authHeader.substring(7).trim();
  } else {
    providedToken = req.headers.get("x-cron-secret")?.trim() || "";
  }

  if (!providedToken) {
    return false;
  }

  const providedBuffer = Buffer.from(providedToken, "utf8");
  const secretBuffer = Buffer.from(secret, "utf8");

  if (providedBuffer.length !== secretBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(providedBuffer, secretBuffer);
}
