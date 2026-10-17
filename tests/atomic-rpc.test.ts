import { describe, expect, it, vi } from "vitest";
import { callAtomicOrFallback, isMissingAtomicRpc } from "../src/functions/shared/atomicRpc";

describe("atomic RPC migration compatibility", () => {
  it("uses the atomic result when the function is installed", async () => {
    const fallback = vi.fn(async () => "legacy");
    const result = await callAtomicOrFallback({
      rpc: async () => ({ data: "atomic" }),
      functionName: "create_quote_atomic",
      fallback,
    });
    expect(result).toEqual({ data: "atomic", usedFallback: false });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("falls back only when the function is missing and emits one short log", async () => {
    const fallback = vi.fn(async () => "legacy");
    const log = vi.fn();
    const result = await callAtomicOrFallback({
      rpc: async () => ({ error: { code: "PGRST202", message: "missing function" } }),
      functionName: "approve_topup_atomic",
      fallback,
      log,
    });
    expect(result).toEqual({ data: "legacy", usedFallback: true });
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).not.toMatch(/@|password|token|secret/i);
  });

  it("does not hide real database errors behind legacy writes", async () => {
    const fallback = vi.fn(async () => "legacy");
    await expect(callAtomicOrFallback({
      rpc: async () => ({ error: { code: "23505", message: "duplicate key" } }),
      functionName: "create_quote_atomic",
      fallback,
    })).rejects.toMatchObject({ code: "23505" });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("recognizes both PostgreSQL and PostgREST missing-function errors", () => {
    expect(isMissingAtomicRpc({ code: "42883" }, "approve_topup_atomic")).toBe(true);
    expect(isMissingAtomicRpc({ message: "Could not find function create_quote_atomic in schema cache" }, "create_quote_atomic")).toBe(true);
    expect(isMissingAtomicRpc({ code: "42501" }, "create_quote_atomic")).toBe(false);
  });
});
