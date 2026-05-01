import { RequestStat, SessionStats, IStatsTracker } from './types';
export { IStatsTracker };

// In-process stats tracker used by the proxy worker (no VS Code dependency).
export class WorkerStats implements IStatsTracker {
  private data: RequestStat[] = [];
  private listeners: ((s: SessionStats) => void)[] = [];

  onUpdate(cb: (s: SessionStats) => void): void {
    this.listeners.push(cb);
  }

  record(stat: RequestStat): void {
    this.data.push(stat);
    if (this.data.length > 1000) { this.data = this.data.slice(-1000); }
    const s = this.getSessionStats();
    this.listeners.forEach(l => l(s));
  }

  getSessionStats(): SessionStats {
    const d = this.data;
    const totalInputTokens      = d.reduce((s, r) => s + (r.cacheHit ? 0 : r.inputTokens), 0);
    const totalOutputTokens     = d.reduce((s, r) => s + (r.cacheHit ? 0 : r.outputTokens), 0);
    const totalSavedTokens      = d.reduce((s, r) => s + r.savedTokensByCompression + r.savedTokensByCache, 0);
    const totalCostUSD          = d.reduce((s, r) => s + r.costUSD, 0);
    const totalSavedCostUSD     = d.reduce((s, r) => s + r.savedCostUSD, 0);
    const totalSavedCostByCompression = d.reduce((s, r) => s + (r.savedCostByCompression ?? 0), 0);
    const totalSavedCostByRouting     = d.reduce((s, r) => s + (r.savedCostByRouting ?? 0), 0);
    const totalCacheReadTokens    = d.reduce((s, r) => s + (r.cacheHit ? 0 : r.cacheReadTokens), 0);
    const totalCacheCreationTokens = d.reduce((s, r) => s + (r.cacheHit ? 0 : r.cacheCreationTokens), 0);
    const totalOriginalTokens     = totalInputTokens + totalCacheReadTokens + totalCacheCreationTokens + totalSavedTokens;
    return {
      totalRequests:    d.length,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheCreationTokens,
      totalSavedTokens,
      totalOriginalTokens,
      totalCostUSD,
      totalSavedCostUSD,
      totalSavedCostByCompression,
      totalSavedCostByRouting,
      cacheHits:       d.filter(r => r.cacheHit).length,
      modelDowngrades: d.filter(r => r.modelDowngraded).length,
      avgSavingsPct:   totalOriginalTokens > 0 ? (totalSavedTokens / totalOriginalTokens) * 100 : 0,
      requests:        d.slice(-100),
    };
  }

  getRecentActivity(n = 10): RequestStat[] {
    return this.data.slice(-n).reverse();
  }

  clear(): void {
    this.data = [];
    const s = this.getSessionStats();
    this.listeners.forEach(l => l(s));
  }
}
