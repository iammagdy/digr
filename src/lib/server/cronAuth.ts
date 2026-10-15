import { NextRequest } from "next/server";
import crypto from "node:crypto";

/**
 * Resolves the canonical internal base URL for server-to-server worker calls.
 * Prioritizes custom app domain over temporary Vercel deployment URLs to avoid
 * deployment protection or preview auth barriers.
 */
export function resolveInternalBaseUrl(req?: NextRequest): string {
  const isProduction = process.env.VERCEL_ENV === "production" ||
    (process.env.NODE_ENV === "production" && process.env.VERCEL === "1");

  // In production, use the origin that actually received the authenticated
  // request. APP_URL can accidentally contain a local development URL, which
  // turns internal worker dispatches into requests to 127.0.0.1 on Vercel.
  if (req) {
    const proto = req.headers.get("x-forwarded-proto") || req.nextUrl?.protocol?.replace(":", "") || "https";
    const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || req.nextUrl?.host;
    if (host && (!isProduction || proto === "https")) {
      return `${proto}://${host}`;
    }
  }

  if (isProduction && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL.replace(/\/+$/, "")}`;
  }

  if (process.env.APP_URL) {
    const configuredUrl = process.env.APP_URL.replace(/\/+$/, "");
    const isLoopback = /^https?:\/\/(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(configuredUrl);
    if (!isProduction || !isLoopback) return configuredUrl;
  }

  if (process.env.NEXT_PUBLIC_SITE_URL) {
    return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/+$/, "");
  }
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL.replace(/\/+$/, "")}`;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL.replace(/\/+$/, "")}`;
  }
  if (isProduction) {
    throw new Error("No production origin is available for the internal worker trigger.");
  }
  return "http://127.0.0.1:3000";
}

function getWorkerSigningSecret(): string {
  return (process.env.CRON_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
}

/**
 * Creates authentication headers for internal server-to-server worker execution.
 * Includes both Bearer CRON_SECRET (if present) and an HMAC-SHA256 signature
 * so internal triggers work reliably regardless of environment configuration.
 */
export function createInternalWorkerAuthHeaders(jobId?: string): Record<string, string> {
  const secret = getWorkerSigningSecret();
  const headers: Record<string, string> = {};

  if (process.env.CRON_SECRET) {
    const cronSecret = process.env.CRON_SECRET.trim();
    headers["Authorization"] = `Bearer ${cronSecret}`;
    headers["x-cron-secret"] = cronSecret;
  }

  if (secret) {
    const timestamp = Date.now().toString();
    const signature = crypto
      .createHmac("sha256", secret)
      .update(`worker:${timestamp}:${jobId || "*"}`)
      .digest("hex");
    headers["x-worker-signature"] = signature;
    headers["x-worker-timestamp"] = timestamp;
    if (jobId) {
      headers["x-worker-job-id"] = jobId;
    }
  }

  return headers;
}

/**
 * Timing-safe authentication for Vercel Cron and internal worker self-chaining.
 * Authenticates against:
 * 1. process.env.CRON_SECRET via Authorization: Bearer <secret> or x-cron-secret: <secret>
 * 2. Internal signed HMAC token using CRON_SECRET or SUPABASE_SERVICE_ROLE_KEY
 */
export function verifyCronSecret(req: NextRequest, targetJobId?: string): boolean {
  // 1. Direct CRON_SECRET verification (standard Vercel Cron)
  const cronSecret = (process.env.CRON_SECRET || "").trim();
  if (cronSecret.length > 0) {
    const authHeader = req.headers.get("authorization");
    let providedToken = "";

    if (authHeader?.startsWith("Bearer ")) {
      providedToken = authHeader.substring(7).trim();
    } else {
      providedToken = req.headers.get("x-cron-secret")?.trim() || "";
    }

    if (providedToken) {
      const providedBuffer = Buffer.from(providedToken, "utf8");
      const secretBuffer = Buffer.from(cronSecret, "utf8");
      if (providedBuffer.length === secretBuffer.length && crypto.timingSafeEqual(providedBuffer, secretBuffer)) {
        return true;
      }
    }
  }

  // 2. Internal signed HMAC verification (accept-quote and chunk-chaining)
  const signingSecret = getWorkerSigningSecret();
  if (signingSecret.length > 0) {
    const signature = req.headers.get("x-worker-signature")?.trim();
    const timestampStr = req.headers.get("x-worker-timestamp")?.trim();
    const headerJobId = req.headers.get("x-worker-job-id")?.trim();

    if (signature && timestampStr) {
      const timestamp = Number(timestampStr);
      const now = Date.now();
      // Allow +/- 10 minutes to accommodate clock skew across serverless instances
      if (Number.isFinite(timestamp) && Math.abs(now - timestamp) <= 10 * 60 * 1000) {
        const candidateJobIds = [targetJobId, headerJobId, "*"].filter(Boolean) as string[];
        for (const jId of candidateJobIds) {
          const expectedSig = crypto
            .createHmac("sha256", signingSecret)
            .update(`worker:${timestampStr}:${jId}`)
            .digest("hex");

          const sigBuf = Buffer.from(signature, "utf8");
          const expectedBuf = Buffer.from(expectedSig, "utf8");
          if (sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf)) {
            return true;
          }
        }
      }
    }
  }

  return false;
}
