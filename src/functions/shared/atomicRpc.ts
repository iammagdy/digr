export function isMissingAtomicRpc(error: unknown, functionName: string): boolean {
  const value = error as { code?: string; message?: string } | null;
  return value?.code === "PGRST202" || value?.code === "42883" ||
    new RegExp(`function .*${functionName}.*(not found|does not exist)|schema cache`, "i")
      .test(String(value?.message || ""));
}

export async function callAtomicOrFallback<T>(options: {
  rpc: () => Promise<{ data?: T; error?: unknown }>;
  functionName: string;
  fallback: () => Promise<T>;
  log?: (line: string) => void;
}): Promise<{ data: T; usedFallback: boolean }> {
  const result = await options.rpc();
  if (!result.error) return { data: result.data as T, usedFallback: false };
  if (!isMissingAtomicRpc(result.error, options.functionName)) throw result.error;
  options.log?.(`[money:${options.functionName}_unavailable] using legacy path until migration is applied`);
  return { data: await options.fallback(), usedFallback: true };
}
