import fs from "fs";
import path from "path";

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
    path.resolve(process.cwd(), "data/treg/treg_research_endpoint_registry.json"),
    path.resolve(__dirname, "../../../data/treg/treg_research_endpoint_registry.json"),
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
      if (status === "failing") {
        this.records.set(endpointId, {
          endpointId,
          state: "open",
          failures: 0,
          consecutive400: 0,
          consecutiveFailures: 0,
          lastFailureTime: null,
          openedAt: now,
          cooldownMs: DEFAULT_COOLDOWN_MS,
        });
      } else {
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

  recordSuccess(endpointId: string): void {
    const rec = this.getOrCreateRecord(endpointId);
    rec.state = "closed";
    rec.failures = 0;
    rec.consecutive400 = 0;
    rec.consecutiveFailures = 0;
    rec.openedAt = null;
    rec.cooldownMs = DEFAULT_COOLDOWN_MS;
  }

  recordFailure(endpointId: string, status: number, isControlProbe?: boolean): void {
    const rec = this.getOrCreateRecord(endpointId);
    const now = this.nowFn();
    rec.failures += 1;
    rec.lastFailureTime = now;

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
    const rec = this.getOrCreateRecord(endpointId);
    rec.state = "closed";
    rec.failures = 0;
    rec.consecutive400 = 0;
    rec.consecutiveFailures = 0;
    rec.lastFailureTime = null;
    rec.openedAt = null;
    rec.cooldownMs = DEFAULT_COOLDOWN_MS;
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
