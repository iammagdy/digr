import type { DataProviderId } from "../../../multiProvider/types";
import type { ProviderAdapter } from "../adapterTypes";
import { contextDevAdapter } from "./contextdev";
import { firecrawlAdapter } from "./firecrawl";
import { tregAdapter } from "./treg";

export const ADAPTERS: Record<DataProviderId, ProviderAdapter> = {
  treg: tregAdapter,
  firecrawl: firecrawlAdapter,
  contextdev: contextDevAdapter,
};

export { contextDevAdapter, firecrawlAdapter, tregAdapter };
export { runTregDirectoryPage } from "./treg";
