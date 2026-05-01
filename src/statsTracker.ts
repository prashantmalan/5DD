/**
 * Stats Tracker
 * Tracks all token usage, savings, and costs across sessions.
 */

import * as vscode from 'vscode';
import { RequestStat, SessionStats, IStatsTracker } from './types';
export { RequestStat, SessionStats, IStatsTracker };

export class StatsTracker implements IStatsTracker {
  private stats: RequestStat[] = [];
  private context: vscode.ExtensionContext;
  private _onUpdate = new vscode.EventEmitter<SessionStats>();
  readonly onUpdate = this._onUpdate.event;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.load();
  }

  record(stat: RequestStat): void {
    this.stats.push(stat);
    this.save();
    this._onUpdate.fire(this.getSessionStats());
  }

  getSessionStats(): SessionStats {
    const totalRequests = this.stats.length;
    // Exclude cache hits: those tokens were never sent to Anthropic.
    const totalInputTokens = this.stats.reduce((s, r) => s + (r.cacheHit ? 0 : r.inputTokens), 0);
    const totalOutputTokens = this.stats.reduce((s, r) => s + (r.cacheHit ? 0 : r.outputTokens), 0);
    const totalSavedTokens = this.stats.reduce((s, r) => s + r.savedTokensByCompression + r.savedTokensByCache, 0);
    const totalCostUSD = this.stats.reduce((s, r) => s + r.costUSD, 0);
    const totalSavedCostUSD = this.stats.reduce((s, r) => s + r.savedCostUSD, 0);
    const totalSavedCostByCompression = this.stats.reduce((s, r) => s + (r.savedCostByCompression ?? 0), 0);
    const totalSavedCostByRouting = this.stats.reduce((s, r) => s + (r.savedCostByRouting ?? 0), 0);
    const cacheHits = this.stats.filter(r => r.cacheHit).length;
    const modelDowngrades = this.stats.filter(r => r.modelDowngraded).length;

    // Full request size = fresh + cache tokens + what we removed via compression/cache.
    // Using just inputTokens (fresh only) in the denominator inflates the savings rate
    // when Anthropic's prompt cache is active.
    const totalCacheReadTokens = this.stats.reduce((s, r) => s + (r.cacheHit ? 0 : r.cacheReadTokens), 0);
    const totalCacheCreationTokens = this.stats.reduce((s, r) => s + (r.cacheHit ? 0 : r.cacheCreationTokens), 0);
    const totalOriginalTokens = totalInputTokens + totalCacheReadTokens + totalCacheCreationTokens + totalSavedTokens;
    const avgSavingsPct = totalOriginalTokens > 0
      ? (totalSavedTokens / totalOriginalTokens) * 100
      : 0;

    return {
      totalRequests,
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
      cacheHits,
      modelDowngrades,
      avgSavingsPct,
      requests: this.stats.slice(-100)
    };
  }

  getRecentActivity(n = 10): RequestStat[] {
    return this.stats.slice(-n).reverse();
  }

  clear(): void {
    this.stats = [];
    this.save();
    this._onUpdate.fire(this.getSessionStats());
  }

  private save(): void {
    // Keep last 1000 records in workspace state
    const trimmed = this.stats.slice(-1000);
    this.context.workspaceState.update('claudeOptimizer.stats', trimmed);
  }

  private load(): void {
    this.stats = this.context.workspaceState.get<RequestStat[]>('claudeOptimizer.stats', []);
  }

  dispose(): void {
    this._onUpdate.dispose();
  }
}
