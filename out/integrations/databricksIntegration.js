"use strict";
/**
 * Databricks Integration
 * Token strategy: only return failed job run summary + last error.
 * Does not dump notebook cell outputs or full cluster logs.
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
exports.DatabricksIntegration = void 0;
class DatabricksIntegration {
    constructor(config) {
        this.config = config;
    }
    async getMinimalContext(query, level) {
        const results = ['## Databricks Context'];
        try {
            results.push(await this.getRecentJobRuns(level));
            if (level >= 2 && this.config.defaultClusterId) {
                results.push(await this.getClusterStatus(this.config.defaultClusterId));
            }
        }
        catch (e) {
            results.push(`Could not fetch Databricks context: ${e}`);
        }
        return results.join('\n\n');
    }
    async getRecentJobRuns(level) {
        const data = await this.dbFetch('/api/2.1/jobs/runs/list?limit=5');
        const runs = data.runs || [];
        if (runs.length === 0)
            return '### No recent job runs';
        const lines = ['### Recent Job Runs'];
        for (const run of runs) {
            const state = run.state?.life_cycle_state || 'UNKNOWN';
            const result = run.state?.result_state || '';
            const name = run.run_name || `Run ${run.run_id}`;
            const time = run.start_time ? new Date(run.start_time).toISOString().slice(0, 19) : '';
            lines.push(`- ${name}: ${state}${result ? '/' + result : ''} at ${time}`);
            if (result === 'FAILED' && level >= 2) {
                const msg = (run.state?.state_message || 'No error message').slice(0, 200);
                lines.push(`  Error: ${msg}`);
            }
        }
        return lines.join('\n');
    }
    async getClusterStatus(clusterId) {
        const d = await this.dbFetch(`/api/2.0/clusters/get?cluster_id=${clusterId}`);
        return [
            `### Cluster: ${d.cluster_name || clusterId}`,
            `State: ${d.state} | Workers: ${d.num_workers ?? 0} | Runtime: ${d.spark_version || 'N/A'}`,
        ].join('\n');
    }
    async dbFetch(apiPath) {
        const https = await Promise.resolve().then(() => __importStar(require('https')));
        const urlObj = new URL(this.config.host + apiPath);
        return new Promise((resolve, reject) => {
            const req = https.request({
                hostname: urlObj.hostname,
                path: urlObj.pathname + urlObj.search,
                headers: { 'Authorization': `Bearer ${this.config.token}` }
            }, (res) => {
                let data = '';
                res.on('data', (c) => { data += c; });
                res.on('end', () => { try {
                    resolve(JSON.parse(data));
                }
                catch {
                    reject(data);
                } });
            });
            req.on('error', reject);
            req.end();
        });
    }
}
exports.DatabricksIntegration = DatabricksIntegration;
