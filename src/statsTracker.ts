/**
 * Stats Tracker
 * Tracks all token usage, savings, and costs across sessions.
 */

import * as vscode from 'vscode';

export interface RequestStat {
  timestamp: number;
  model: string;
  originalModel: string;
  inputTokens: number;
  outputTokens: number;
  savedTokensByCompression: number;
  savedTokensByCache: number;
  cacheHit: boolean;
  modelDowngraded: boolean;
  costUSD: number;
  savedCostUSD: number;
  techniques: string[];
}

export interface SessionStats {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalSavedTokens: number;
  totalCostUSD: number;
  totalSavedCostUSD: number;
  cacheHits: number;
  modelDowngrades: number;
  avgSavingsPct: number;
  requests: RequestStat[];
}

export class StatsTracker {
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
    const totalInputTokens = this.stats.reduce((s, r) => s + r.inputTokens, 0);
    const totalOutputTokens = this.stats.reduce((s, r) => s + r.outputTokens, 0);
    const totalSavedTokens = this.stats.reduce((s, r) => s + r.savedTokensByCompression + r.savedTokensByCache, 0);
    const totalCostUSD = this.stats.reduce((s, r) => s + r.costUSD, 0);
    const totalSavedCostUSD = this.stats.reduce((s, r) => s + r.savedCostUSD, 0);
    const cacheHits = this.stats.filter(r => r.cacheHit).length;
    const modelDowngrades = this.stats.filter(r => r.modelDowngraded).length;

    const totalConsumed = totalInputTokens + totalSavedTokens;
    const avgSavingsPct = totalConsumed > 0
      ? (totalSavedTokens / totalConsumed) * 100
      : 0;

    return {
      totalRequests,
      totalInputTokens,
      totalOutputTokens,
      totalSavedTokens,
      totalCostUSD,
      totalSavedCostUSD,
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
