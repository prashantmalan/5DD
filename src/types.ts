export interface RequestStat {
  timestamp: number;
  model: string;
  originalModel: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  savedTokensByCompression: number;
  savedTokensByCache: number;
  cacheHit: boolean;
  modelDowngraded: boolean;
  costUSD: number;
  savedCostUSD: number;
  savedCostByCompression: number;
  savedCostByRouting: number;
  techniques: string[];
}

export interface SessionStats {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalSavedTokens: number;
  totalOriginalTokens: number;
  totalCostUSD: number;
  totalSavedCostUSD: number;
  totalSavedCostByCompression: number;
  totalSavedCostByRouting: number;
  cacheHits: number;
  modelDowngrades: number;
  avgSavingsPct: number;
  requests: RequestStat[];
}

export interface IStatsTracker {
  record(stat: RequestStat): void;
  getSessionStats(): SessionStats;
  getRecentActivity(n?: number): RequestStat[];
  clear(): void;
}
