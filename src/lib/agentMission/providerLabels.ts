import catalogIndexRaw from "../../../data/treg/treg_catalog_index.json";
import providerMetadataRaw from "../../../data/capabilities/provider-metadata.json";
import platformHostsRaw from "../../../data/capabilities/platform-hosts.json";
import { replaceBareHostsInText, replaceUrlsInText } from "../arabicNormalize";

function loadProviderLabels(): Set<string> {
  const platformTokens = new Set<string>();
  const hosts = Array.isArray(platformHostsRaw) ? platformHostsRaw : [];
  for (const h of hosts) {
    if (typeof h === "string") {
      for (const part of h.toLowerCase().split(".")) {
        if (part && part !== "com" && part !== "org" && part !== "net" && part !== "me" && part !== "be" && part !== "in") {
          platformTokens.add(part);
        }
      }
    }
  }

  const set = new Set<string>();
  const indexProviders = (catalogIndexRaw as { providers?: string[] })?.providers ?? [];
  for (const p of indexProviders) {
    if (typeof p === "string" && p) {
      const lower = p.toLowerCase();
      if (!platformTokens.has(lower)) set.add(lower);
    }
  }
  const webMeta = (providerMetadataRaw as { web?: Record<string, { summary?: { server?: string } }> })?.web ?? {};
  for (const [providerKey, meta] of Object.entries(webMeta)) {
    if (providerKey) {
      const lower = providerKey.toLowerCase();
      if (!platformTokens.has(lower)) set.add(lower);
    }
    const srv = meta?.summary?.server;
    if (srv) {
      try {
        const hostname = new URL(srv).hostname.toLowerCase();
        for (const token of hostname.split(".").slice(0, -1)) {
          if (token && token !== "api" && token !== "www" && !platformTokens.has(token)) {
            set.add(token);
          }
        }
      } catch {
        // invalid URL ignored
      }
    }
  }
  return set;
}

const LABELS: ReadonlySet<string> = loadProviderLabels();
export const PROVIDER_LABELS: readonly string[] = [...LABELS].sort();

function isProviderAddress(address: string): boolean {
  const t = address.replace(/[.,;:!?]+$/, "");
  let host = "";
  try { host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`).hostname.toLowerCase(); } catch { return false; }
  return host.split(".").filter(Boolean).slice(0, -1).some((l) => LABELS.has(l));
}

/** The text with every address of a data provider taken out (the address itself, not the words around it); the same text when there is none. */
export function withoutProviderHosts(text: string): string {
  if (!text) return text;
  const dropProviderAddress = (m: string): string => (isProviderAddress(m) ? "" : m);
  const out = replaceBareHostsInText(replaceUrlsInText(text, dropProviderAddress), dropProviderAddress);
  return out === text ? text : out.replace(/[ \t]{2,}/g, " ").trim();
}
