/**
 * THE ONE WAY TO READ WHAT A TREG ANSWER CHARGED (DT-20261119-11, Gate 2 F3). The gateway, the client's job budget, the exploration ledger and the admin lookup all read a call's charge here, so no path can book a different figure for the same answer.
 *
 *  - a charge the answer REPORTED wins, success or failure (a 500 that reports $0.04 is $0.04);
 *  - a documented free refusal (a 402 payment/price-cap refusal, a 401/403 auth refusal, a 400/404/409/422/429 refusal: TREG refuses them BEFORE billing) with no report is a KNOWN ZERO;
 *  - everything else is UNKNOWN and the caller keeps what it reserved (at most the call's held amount): a cut or unreachable call, an answered success with no charge in it (or only the catalog's estimate), a 5xx with no charge in it.
 *
 * Never throws. No I/O.
 */
export interface TregChargeFacts {
  ok?: boolean;
  httpStatus?: number;
  costMicro?: number;
  /** the answer carried no charge at all (`costMicro` is a placeholder 0, not a report) */
  costUnreported?: boolean;
  /** `costMicro` is only the catalog's price estimate, not a report */
  costIsEstimate?: boolean;
  /** the cost header was present but is not a plain integer: it is not a report */
  costHeaderInvalid?: boolean;
  /** the charge the answer body reported (`_treg.charged_micro`) */
  chargedMicroReported?: number;
  timedOut?: boolean;
  error?: string;
  blocked?: unknown;
  isRouteMaxCost?: boolean;
}

export type TregCharge = { known: true; usd: number } | { known: false };

const UNKNOWN: TregCharge = { known: false };
/** Answered refusals TREG makes before billing; with no charge in the answer they are a known zero. */
const FREE_REFUSAL_STATUSES: ReadonlySet<number> = new Set([400, 401, 402, 403, 404, 409, 422, 429]);

const validMicro = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** The charge (micro-USD) the answer REPORTED, or null when it reported none. When the header and the answer's own figure disagree the LARGER one counts: money is never under-booked. */
export function reportedChargeMicro(r: TregChargeFacts): number | null {
  if (r.costIsEstimate === true || r.costUnreported === true) return validMicro(r.chargedMicroReported);
  const header = r.costHeaderInvalid === true ? null : validMicro(r.costMicro);
  const body = validMicro(r.chargedMicroReported);
  if (header === null && body === null) return null;
  return Math.max(header ?? 0, body ?? 0);
}

export function classifyTregCharge(r: TregChargeFacts | null | undefined): TregCharge {
  if (!r) return UNKNOWN;
  if (r.timedOut === true || r.error === "network_failure") return UNKNOWN;
  if (r.blocked) return { known: true, usd: 0 };
  const reported = reportedChargeMicro(r);
  if (reported !== null) return { known: true, usd: reported / 1_000_000 };
  if (r.ok === true) return UNKNOWN;
  const status = Number(r.httpStatus) || 0;
  if (FREE_REFUSAL_STATUSES.has(status) || (status === 402 && r.isRouteMaxCost === true)) return { known: true, usd: 0 };
  return UNKNOWN;
}

/** The USD to book for a call that reserved `reservedUsd`: its charge when known, the whole reservation when not. */
export const bookedUsd = (r: TregChargeFacts | null | undefined, reservedUsd: number): number => {
  const c = classifyTregCharge(r);
  return c.known ? c.usd : reservedUsd;
};
