export type ProviderId = string;
export type UpdateKind = "new" | "changed" | "removed";
export type UpdateStatus = "new" | "studied" | "planned" | "merged" | "rejected";

export interface ProviderUpdateFeedRow {
  id: string;
  date: string;
  provider: ProviderId;
  item: string;
  kind: UpdateKind;
  title_ar: string;
  brief_ar: string;
  summary_ar: string;
  price_ar: string;
  source_url: string;
  report_path: string;
  status: UpdateStatus;
  status_reason_ar?: string;
}

export interface ProviderUpdatesFeedPayload {
  version: 1;
  generated_at: string;
  total: number;
  updates: ProviderUpdateFeedRow[];
  reports: Record<string, string>;
}

export interface ProviderUpdatesStats {
  total: number;
  unstudiedCount: number;
  byProvider: Record<string, { total: number; unstudied: number; lastDate: string | null }>;
  byKind: Record<UpdateKind, number>;
  byStatus: Record<UpdateStatus, number>;
}
