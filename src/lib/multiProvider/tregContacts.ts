/**
 * Strict, fail-closed helpers of the e-mail lookup and the chain's TREG directory calls.
 * catalog figure, unverified, owner-accepted under D-0027
 */

export const TREG_MAX_STATEMENT = "catalog figure, unverified, owner-accepted under D-0027";
export const TREG_EMAIL_LOOKUP = { endpointId: "tomba.companies.emails.list", method: "GET" as const, allowedParamKeys: ["domain", "limit"] as string[], limit: 10, reservedUsd: 0.0089, headerCeilingUsd: 0.02 } as const;
export const TREG_DIRECTORY = { endpointId: "icypeas.companies.search", method: "POST" as const, pageSize: 10, reservedUsd: 0.00576, headerCeilingUsd: 0.05 } as const;

export const ORIGIN_CHARSET_RE = /^[A-Za-z0-9:/._~%?&=#@+,;!$*()'-]{1,200}$/;
export const HOST_RE = /^[a-z0-9.-]{1,100}$/;
export const stripControl = (raw: string): string => raw.replace(/[\u0000-\u001f\u007f]/g, "");
export const utf8Bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
export const escapedBytes = (s: string): number => Buffer.byteLength(JSON.stringify(s)) - 2;
