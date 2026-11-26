import fs from "fs";
import path from "path";
import { TREG_DATA_DIR } from "../multiProvider/types";

export type CircuitState = "closed" | "open" | "half-open";

export interface EndpointCircuitRecord {
  endpointId: string;
  state: CircuitState;
  failures: number;
  consecutive400: number;
  consecutiveFailures: number;
  lastFailureTime: number | null;
  openedAt: number | null;
  cooldownMs: number;
}

export interface ControlProbeRequest {
  endpointId: string;
  method?: "GET" | "POST";
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface CircuitBreakerAlert {
  type: "credit_exhaustion";
  endpointId: string;
  provider: string;
  capability?: string;
  status: 402;
  timestamp: number;
  message: string;
  logLine?: string;
}

export const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
export const EXTENDED_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
export const CONSECUTIVE_FAILURES_THRESHOLD = 3;

let cachedRegistryData: any = null;

export function setResearchRegistry(data: any): void {
  cachedRegistryData = data;
}

export function clearResearchRegistryCache(): void {
  cachedRegistryData = null;
}

export function loadResearchRegistry(): any {
  if (cachedRegistryData) return cachedRegistryData;
  const candidatePaths = [
    path.resolve(process.cwd(), "data", TREG_DATA_DIR, "treg_research_endpoint_registry.json"),
    path.resolve(__dirname, "../../..", "data", TREG_DATA_DIR, "treg_research_endpoint_registry.json"),
  ];

  for (const p of candidatePaths) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, "utf-8");
        cachedRegistryData = JSON.parse(raw);
        return cachedRegistryData;
      }
    } catch {
      // Continue to next path
    }
  }
  return null;
}

export function getControlProbeRequest(endpointId: string): ControlProbeRequest | null {
  const reg = loadResearchRegistry();
  if (reg && Array.isArray(reg.endpoints)) {
    const ep = reg.endpoints.find((e: any) => e.endpoint_id === endpointId);
    if (ep) {
      const method = (ep.example_http?.method || (ep.example_request ? "POST" : "GET")).toUpperCase() as "GET" | "POST";
      const params = ep.example_request?.params || ep.example_http?.body || ep.example_http?.query || {};
      return {
        endpointId,
        method,
        params,
        headers: ep.example_http?.headers || ep.example_request?.headers,
      };
    }
  }
  return null;
}

export class EndpointCircuitBreaker {
  private records: Map<string, EndpointCircuitRecord> = new Map();
  private provider402Trips: Map<string, { openedAt: number; cooldownMs: number }> = new Map();
  private alertLogs: CircuitBreakerAlert[] = [];
  private nowFn: () => number;

  constructor(
    initialStatuses?: Record<string, "working" | "degraded" | "failing">,
    nowFn?: () => number
  ) {
    this.nowFn = nowFn ?? (() => Date.now());

    let statuses = initialStatuses;
    if (!statuses) {
      statuses = {};
      const reg = loadResearchRegistry();
      if (reg && Array.isArray(reg.endpoints)) {
        for (const ep of reg.endpoints) {
          if (ep.endpoint_id && ep.current_status) {
            statuses[ep.endpoint_id] = ep.current_status;
          }
        }
      }
    }

    const now = this.nowFn();
    for (const [endpointId, status] of Object.entries(statuses)) {
      // Per Rule 3 (الكبير) & Phase 5 Part B: all circuits start closed at boot;
      // data-file current_status, contract_status ("unknown" / "partial"), or schema drift ("drifted": true)
      // alone never blocks an endpoint unless real failures are observed at runtime in this process.
      this.records.set(endpointId, {
        endpointId,
        state: "closed",
        failures: 0,
        consecutive400: 0,
        consecutiveFailures: 0,
        lastFailureTime: null,
        openedAt: null,
        cooldownMs: DEFAULT_COOLDOWN_MS,
      });
    }
  }

  private getOrCreateRecord(endpointId: string): EndpointCircuitRecord {
    let rec = this.records.get(endpointId);
    if (!rec) {
      rec = {
        endpointId,
        state: "closed",
        failures: 0,
        consecutive400: 0,
        consecutiveFailures: 0,
        lastFailureTime: null,
        openedAt: null,
        cooldownMs: DEFAULT_COOLDOWN_MS,
      };
      this.records.set(endpointId, rec);
    }
    return rec;
  }

  getState(endpointId: string): CircuitState {
    const provider = endpointId.includes(".") ? endpointId.split(".")[0] : endpointId;
    const providerTrip = this.provider402Trips.get(provider);
    if (providerTrip) {
      const elapsed = this.nowFn() - providerTrip.openedAt;
      if (elapsed < providerTrip.cooldownMs) {
        return "open";
      } else {
        this.provider402Trips.delete(provider);
      }
    }
    const rec = this.getOrCreateRecord(endpointId);
    if (rec.state === "open") {
      const elapsed = this.nowFn() - (rec.openedAt ?? 0);
      if (elapsed >= rec.cooldownMs) {
        rec.state = "half-open";
      }
    }
    return rec.state;
  }

  isAvailable(endpointId: string): boolean {
    return this.getState(endpointId) !== "open";
  }

  /**
   * Phase 5 Part B Invariant (Point 5.4 / D-0198):
   * A drifted, unknown, or partial contract never blocks an endpoint by itself.
   * Only real runtime failures (400s/5xx/timeouts) open a circuit.
   *
   * @param endpointId The endpoint identifier
   * @param contract Optional contract metadata (contract_status, drifted)
   * @returns true if the endpoint's circuit is available (closed or half-open)
   */
  isAvailableForContract(
    endpointId: string,
    contract?: { contract_status?: "full" | "partial" | "unknown" | null; drifted?: boolean | null } | null
  ): boolean {
    // Contract metadata (drifted: true, contract_status: "unknown" | "partial") is informational/ranking-only
    // and NEVER trips or opens the circuit. Only real runtime failures in this process change the state.
    return this.isAvailable(endpointId);
  }

  recordSuccess(endpointId: string): void {
    const provider = endpointId.includes(".") ? endpointId.split(".")[0] : endpointId;
    this.provider402Trips.delete(provider);
    const rec = this.getOrCreateRecord(endpointId);
    rec.state = "closed";
    rec.failures = 0;
    rec.consecutive400 = 0;
    rec.consecutiveFailures = 0;
    rec.openedAt = null;
    rec.cooldownMs = DEFAULT_COOLDOWN_MS;
  }

  recordFailure(endpointId: string, status: number, isControlProbe?: boolean, capability?: string): void {
    // Phase 2 / Phase 6 Amendment 2 (Megz / الكبير):
    // HTTP 429 is a rate limit with Retry-After, NOT a circuit failure and does NOT trip the circuit.
    if (status === 429) {
      return;
    }

    const rec = this.getOrCreateRecord(endpointId);
    const now = this.nowFn();
    rec.failures += 1;
    rec.lastFailureTime = now;

    // Phase 6 Amendment 2 (Megz / الكبير):
    // Only HTTP 402 / credit exhaustion trips the circuit breaker to open for that provider account.
    if (status === 402) {
      rec.state = "open";
      rec.openedAt = now;
      rec.cooldownMs = EXTENDED_COOLDOWN_MS;
      rec.consecutiveFailures += 1;

      const provider = endpointId.includes(".") ? endpointId.split(".")[0] : endpointId;
      const capabilityId = capability ?? (endpointId.includes(".") ? endpointId.split(".").slice(1).join(".") : endpointId);
      this.provider402Trips.set(provider, { openedAt: now, cooldownMs: EXTENDED_COOLDOWN_MS });

      for (const [id, r] of this.records.entries()) {
        const p = id.includes(".") ? id.split(".")[0] : id;
        if (p === provider) {
          r.state = "open";
          r.openedAt = now;
          r.cooldownMs = EXTENDED_COOLDOWN_MS;
        }
      }

      const logLine = `[agent] provider_credit_exhausted provider=${provider} capability=${capabilityId}`;
      const alertMsg = `[CIRCUIT_BREAKER_ALERT: COMMANDER] Provider account credit exhausted (HTTP 402) for endpoint ${endpointId} (provider: ${provider}). Circuit tripped open. Megz top-up required.`;
      this.alertLogs.push({
        type: "credit_exhaustion",
        endpointId,
        provider,
        capability: capabilityId,
        status: 402,
        timestamp: now,
        message: alertMsg,
        logLine,
      });
      console.warn(alertMsg);
      console.error(logLine);
      return;
    }

    if (isControlProbe) {
      // If a control probe fails with 400 or error, trip immediately to open with 30-min cooldown
      rec.state = "open";
      rec.openedAt = now;
      rec.cooldownMs = EXTENDED_COOLDOWN_MS;
      rec.consecutiveFailures += 1;
      if (status === 400) rec.consecutive400 += 1;
      return;
    }

    if (rec.state === "half-open") {
      // In half-open, a single failure returns to open
      rec.state = "open";
      rec.openedAt = now;
      rec.cooldownMs = DEFAULT_COOLDOWN_MS;
      rec.consecutiveFailures += 1;
      if (status === 400) rec.consecutive400 += 1;
      return;
    }

    // In closed state, track consecutive 400s and 5xx errors
    const isConsecutiveCandidate = status === 400 || (status >= 500 && status < 600);
    if (isConsecutiveCandidate) {
      rec.consecutiveFailures += 1;
      if (status === 400) {
        rec.consecutive400 += 1;
      }
      if (rec.consecutive400 >= CONSECUTIVE_FAILURES_THRESHOLD || rec.consecutiveFailures >= CONSECUTIVE_FAILURES_THRESHOLD) {
        rec.state = "open";
        rec.openedAt = now;
        rec.cooldownMs = DEFAULT_COOLDOWN_MS;
      }
    }
  }

  reset(endpointId: string): void {
    const provider = endpointId.includes(".") ? endpointId.split(".")[0] : endpointId;
    this.provider402Trips.delete(provider);
    const rec = this.getOrCreateRecord(endpointId);
    rec.state = "closed";
    rec.failures = 0;
    rec.consecutive400 = 0;
    rec.consecutiveFailures = 0;
    rec.lastFailureTime = null;
    rec.openedAt = null;
    rec.cooldownMs = DEFAULT_COOLDOWN_MS;
  }

  resetProvider(provider: string): void {
    this.provider402Trips.delete(provider);
    for (const [id, rec] of this.records.entries()) {
      const p = id.includes(".") ? id.split(".")[0] : id;
      if (p === provider) {
        rec.state = "closed";
        rec.failures = 0;
        rec.consecutive400 = 0;
        rec.consecutiveFailures = 0;
        rec.lastFailureTime = null;
        rec.openedAt = null;
        rec.cooldownMs = DEFAULT_COOLDOWN_MS;
      }
    }
  }

  getAlertLogs(): CircuitBreakerAlert[] {
    return [...this.alertLogs];
  }

  clearAlertLogs(): void {
    this.alertLogs = [];
  }

  getRecord(endpointId: string): EndpointCircuitRecord {
    return { ...this.getOrCreateRecord(endpointId) };
  }
}

let globalCircuitBreaker: EndpointCircuitBreaker | null = null;

export function getCircuitBreaker(): EndpointCircuitBreaker {
  if (!globalCircuitBreaker) {
    globalCircuitBreaker = new EndpointCircuitBreaker();
  }
  return globalCircuitBreaker;
}

export function setCircuitBreaker(cb: EndpointCircuitBreaker | null): void {
  globalCircuitBreaker = cb;
}
