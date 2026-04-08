/**
 * Databricks Integration
 * Token strategy: only return failed job run summary + last error.
 * Does not dump notebook cell outputs or full cluster logs.
 */

import { IntegrationProvider } from '../contextBuilder';

export interface DatabricksConfig {
  host: string;   // e.g. https://adb-xxxx.azuredatabricks.net
  token: string;
  defaultClusterId?: string;
}

export class DatabricksIntegration implements IntegrationProvider {
  constructor(private config: DatabricksConfig) {}

  async getMinimalContext(query: string, level: number): Promise<string> {
    const results: string[] = ['## Databricks Context'];
    try {
      results.push(await this.getRecentJobRuns(level));
      if (level >= 2 && this.config.defaultClusterId) {
        results.push(await this.getClusterStatus(this.config.defaultClusterId));
      }
    } catch (e) {
      results.push(`Could not fetch Databricks context: ${e}`);
    }
    return results.join('\n\n');
  }

  private async getRecentJobRuns(level: number): Promise<string> {
    const data = await this.dbFetch('/api/2.1/jobs/runs/list?limit=5');
    const runs: any[] = data.runs || [];
    if (runs.length === 0) return '### No recent job runs';

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

  private async getClusterStatus(clusterId: string): Promise<string> {
    const d = await this.dbFetch(`/api/2.0/clusters/get?cluster_id=${clusterId}`);
    return [
      `### Cluster: ${d.cluster_name || clusterId}`,
      `State: ${d.state} | Workers: ${d.num_workers ?? 0} | Runtime: ${d.spark_version || 'N/A'}`,
    ].join('\n');
  }

  private async dbFetch(apiPath: string): Promise<any> {
    const https = await import('https');
    const urlObj = new URL(this.config.host + apiPath);
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        headers: { 'Authorization': `Bearer ${this.config.token}` }
      }, (res) => {
        let data = '';
        res.on('data', (c: any) => { data += c; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(data); } });
      });
      req.on('error', reject);
      req.end();
    });
  }
}
