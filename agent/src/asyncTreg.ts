import type { TregCatalog } from "../../src/lib/treg/catalog";
import type { AgentStore } from "./types";
import { RAW_PATH, rowsExpressionOf, type GatewayCallResult } from "./gateway";
import { getPath, hintsOf, readShape } from "../../src/lib/treg/shapeReader";
import { digestValue } from "../../src/lib/modelPlanner/digest";
import { AGENT_FIRST_ROWS } from "../../src/lib/agentMission/constants";

export interface AsyncConfig {
  id_from: string;
  poll?: { endpoint?: string; param?: { in?: string; name?: string } };
  status?: { path?: string; progress?: unknown[]; success?: unknown[]; failure?: unknown[]; billed_failure?: unknown[] };
  result?: { path?: string };
  interval?: number;
  max_age?: number;
  terminal_on_submission?: boolean;
}

export interface AsyncTregDeps {
  catalog: TregCatalog;
  store: AgentStore;
  missionId: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function effectiveChargeUsd(r: { charge_usd?: number | null; reserved_usd?: number | null }): number {
  if (typeof r.charge_usd === "number" && Number.isFinite(r.charge_usd)) return r.charge_usd;
  return typeof r.reserved_usd === "number" && Number.isFinite(r.reserved_usd) ? r.reserved_usd : 0;
}

export function attachMoneyFacts<T extends object>(
  target: T,
  facts: { charge_usd?: number | null; reserved_usd?: number; call_ids?: string[] },
): T {
  const out = { ...target };
  if ("charge_usd" in facts) {
    Object.defineProperty(out, "charge_usd", { value: facts.charge_usd, enumerable: false, configurable: true });
  }
  if ("reserved_usd" in facts) {
    Object.defineProperty(out, "reserved_usd", { value: facts.reserved_usd, enumerable: false, configurable: true });
  }
  if ("call_ids" in facts) {
    Object.defineProperty(out, "call_ids", { value: facts.call_ids, enumerable: false, configurable: true });
  }
  return out;
}

/**
 * Executes an async submit-and-poll endpoint driven by its catalog `async_config`.
 * Standard endpoints without `async_config.poll.endpoint` pass through directly with 0 overhead.
 */
export async function callTregWithAsync(
  deps: AsyncTregDeps,
  callFn: (endpointId: string, params: Record<string, unknown>) => Promise<GatewayCallResult>,
  endpointId: string,
  params: Record<string, unknown>
): Promise<GatewayCallResult> {
  const res = await callFn(endpointId, params);
  const endpoint = deps.catalog.byId.get(endpointId);
  const cfg = endpoint?.async_config as AsyncConfig | undefined | null;

  if (!res.ok || !cfg?.poll?.endpoint || !cfg.poll.param?.name) {
    return res;
  }

  const rawText = await deps.store.getFile(deps.missionId, RAW_PATH(res.call_id));
  if (!rawText) return res;

  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    return res;
  }

  const taskId = getPath(raw, cfg.id_from);
  if (res.rows_in_page > 0 && cfg.terminal_on_submission === true && taskId == null) {
    return res;
  }
  if (!taskId) {
    return res;
  }

  let totalChargeUsd = effectiveChargeUsd(res);
  let totalReservedUsd = Number(res.reserved_usd ?? 0) || 0;
  const callIds: string[] = [res.call_id];
  const moneyFacts = () => ({
    charge_usd: Number(totalChargeUsd.toFixed(6)),
    reserved_usd: Number(totalReservedUsd.toFixed(6)),
    call_ids: [...callIds],
  });

  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());
  const startTime = now();
  const maxAgeMs = Math.min(cfg.max_age ?? 180, 180) * 1000;
  const intervalMs = Math.min(Math.max(cfg.interval ?? 2, 1), 30) * 1000;
  let attempts = 0;
  const maxAttempts = 30;

  while (now() - startTime < maxAgeMs && attempts < maxAttempts) {
    attempts++;
    await sleep(intervalMs);
    const pollRes = await callFn(cfg.poll.endpoint, { [cfg.poll.param.name]: taskId });
    callIds.push(pollRes.call_id);
    totalChargeUsd += effectiveChargeUsd(pollRes);
    totalReservedUsd += Number(pollRes.reserved_usd ?? 0) || 0;
    const facts = moneyFacts();
    if (!pollRes.ok) return attachMoneyFacts(pollRes, facts);

    const pollRawText = await deps.store.getFile(deps.missionId, RAW_PATH(pollRes.call_id));
    if (!pollRawText) return attachMoneyFacts(pollRes, facts);

    let pollRaw: unknown;
    try {
      pollRaw = JSON.parse(pollRawText);
    } catch {
      return attachMoneyFacts(pollRes, facts);
    }

    const st = cfg.status?.path ? getPath(pollRaw, cfg.status.path) : undefined;
    if ((cfg.status?.failure ?? []).includes(st) || (cfg.status?.billed_failure ?? []).includes(st)) {
      return attachMoneyFacts({ ok: false, call_id: pollRes.call_id, failed: true, http_status: 500, message: "async task failed" } as GatewayCallResult, facts);
    }

    if ((cfg.status?.success ?? []).includes(st)) {
      const payload = cfg.result?.path ? getPath(pollRaw, cfg.result.path) : pollRaw;
      const target = payload !== undefined && payload !== null ? payload : pollRaw;
      try {
        await deps.store.putFile(deps.missionId, RAW_PATH(pollRes.call_id), JSON.stringify(target), "application/json");
      } catch {
        // preserve original file
      }
      const pollEndpoint = deps.catalog.byId.get(cfg.poll.endpoint) ?? endpoint;
      const hints = pollEndpoint ? hintsOf(pollEndpoint) : {};
      let reading = readShape(target, hints);
      if (reading.rows.length === 0 && target !== pollRaw) {
        const fallbackReading = readShape(pollRaw, hints);
        if (fallbackReading.rows.length > 0) reading = fallbackReading;
      }
      const rows = reading.rows.length;
      const rowsIn = rows > 0 ? rowsExpressionOf(pollRes.call_id, reading.listPath, reading.listStrategy) : null;
      return attachMoneyFacts({
        ...pollRes,
        rows_in_page: rows,
        has_more: reading.hasMore ?? null,
        next_cursor: reading.nextCursor ?? null,
        first_rows: reading.rows.slice(0, AGENT_FIRST_ROWS).map((r) => digestValue(r)),
        warnings: reading.warnings,
        shape: {
          rows_in_page: rows,
          list_path: reading.listPath,
          fields: {},
          next_cursor_path: reading.cursorPath,
          cursor_kind: reading.cursorKind,
        },
        saved: `${pollRes.call_id} (the full page is saved; give "${pollRes.call_id}" to run_code to process it${rowsIn ? `: its rows are ${rowsIn}` : ""})`,
        ...(rowsIn ? { rows_in_code: rowsIn } : {}),
      } as GatewayCallResult, facts);
    }
  }

  return attachMoneyFacts({ ok: false, call_id: res.call_id, failed: true, http_status: 504, message: "async task timed out" } as GatewayCallResult, moneyFacts());
}
