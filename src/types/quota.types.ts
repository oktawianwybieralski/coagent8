export type QuotaStatus = 'operational' | 'uninstalled' | 'rate_limited';

export interface BackendQuota {
  installed: boolean;
  executionSupported?: boolean;
  status: QuotaStatus;
  window: string;
  usedPercent: number | null;
  resetsAt: string | null;
  cooldownUntil: string | null;
  headroomPercent: number | null;
  measured: boolean;
  cooldownReason?: string | null;
  cooldownLevel?: number;
  lastCooldownAt?: string | null;
}

export interface QuotaReport {
  [backendId: string]: BackendQuota;
}

export interface QuotaCacheRecord {
  timestamp: number;
  data: QuotaReport;
}
