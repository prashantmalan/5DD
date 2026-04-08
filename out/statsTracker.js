"use strict";
/**
 * Stats Tracker
 * Tracks all token usage, savings, and costs across sessions.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.StatsTracker = void 0;
const vscode = __importStar(require("vscode"));
class StatsTracker {
    constructor(context) {
        this.stats = [];
        this._onUpdate = new vscode.EventEmitter();
        this.onUpdate = this._onUpdate.event;
        this.context = context;
        this.load();
    }
    record(stat) {
        this.stats.push(stat);
        this.save();
        this._onUpdate.fire(this.getSessionStats());
    }
    getSessionStats() {
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
    getRecentActivity(n = 10) {
        return this.stats.slice(-n).reverse();
    }
    clear() {
        this.stats = [];
        this.save();
        this._onUpdate.fire(this.getSessionStats());
    }
    save() {
        // Keep last 1000 records in workspace state
        const trimmed = this.stats.slice(-1000);
        this.context.workspaceState.update('claudeOptimizer.stats', trimmed);
    }
    load() {
        this.stats = this.context.workspaceState.get('claudeOptimizer.stats', []);
    }
    dispose() {
        this._onUpdate.dispose();
    }
}
exports.StatsTracker = StatsTracker;
