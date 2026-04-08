/**
 * Azure Integration
 * Token-efficient Azure resource context.
 * Fetches only: resource status, recent alerts, recent deployments.
 * Does NOT dump full ARM templates or full metric history.
 */

import { IntegrationProvider } from '../contextBuilder';

export interface AzureConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  subscriptionId: string;
  defaultResourceGroup?: string;
}

export class AzureIntegration implements IntegrationProvider {
  private config: AzureConfig;
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;

  constructor(config: AzureConfig) {
    this.config = config;
  }

  async getMinimalContext(query: string, level: number): Promise<string> {
    const results: string[] = ['## Azure Context'];

    try {
      await this.ensureToken();

      // Detect what the query is asking about
      const resourceName = this.extractResourceName(query);

      if (resourceName) {
        const resource = await this.getResource(resourceName);
        if (resource) results.push(this.formatResource(resource));
      }

      if (level >= 2 && this.config.defaultResourceGroup) {
        const alerts = await this.getRecentAlerts(this.config.defaultResourceGroup);
        if (alerts) results.push(alerts);
      }

      if (level >= 3 && this.config.defaultResourceGroup) {
        const deployments = await this.getRecentDeployments(this.config.defaultResourceGroup);
        if (deployments) results.push(deployments);
      }
    } catch (e) {
      results.push(`Could not fetch Azure context: ${e}`);
    }

    return results.join('\n\n');
  }

  private async getResource(nameOrId: string): Promise<any> {
    // Try to find resource by name in the default RG
    if (!this.config.defaultResourceGroup) return null;
    const url = `https://management.azure.com/subscriptions/${this.config.subscriptionId}/resourceGroups/${this.config.defaultResourceGroup}/resources?$filter=name eq '${nameOrId}'&api-version=2021-04-01`;
    const data = await this.azureFetch(url);
    return data.value?.[0] || null;
  }

  private async getRecentAlerts(rg: string): Promise<string> {
    const url = `https://management.azure.com/subscriptions/${this.config.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.AlertsManagement/alerts?api-version=2019-05-05-preview&$top=5&sortBy=lastModifiedDateTime&sortOrder=desc`;
    const data = await this.azureFetch(url);
    const alerts = data.value || [];
    if (alerts.length === 0) return '';

    const lines = ['### Recent Alerts'];
    for (const alert of alerts.slice(0, 5)) {
      const p = alert.properties;
      lines.push(`- [${p.severity}] ${p.alertRule}: ${p.description?.slice(0, 100) || 'No description'}`);
    }
    return lines.join('\n');
  }

  private async getRecentDeployments(rg: string): Promise<string> {
    const url = `https://management.azure.com/subscriptions/${this.config.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Resources/deployments?api-version=2021-04-01&$top=5`;
    const data = await this.azureFetch(url);
    const deployments = data.value || [];
    if (deployments.length === 0) return '';

    const lines = ['### Recent Deployments (last 5)'];
    for (const d of deployments) {
      const p = d.properties;
      const status = p.provisioningState;
      const time = p.timestamp?.slice(0, 16) || '';
      lines.push(`- ${d.name}: ${status} at ${time}`);
    }
    return lines.join('\n');
  }

  private formatResource(resource: any): string {
    return [
      `### Resource: ${resource.name}`,
      `Type: ${resource.type}`,
      `Location: ${resource.location}`,
      `Tags: ${JSON.stringify(resource.tags || {})}`,
    ].join('\n');
  }

  private extractResourceName(query: string): string | null {
    // Look for resource name patterns like "app service myapp", "aks mycluster"
    const patterns = [
      /\b(aks|app service|function app|storage account|sql server|cosmos|vm|vnet)\s+([a-z0-9-]+)/i,
      /resource\s+(?:named?|called?)\s+([a-z0-9-]+)/i,
    ];
    for (const p of patterns) {
      const m = query.match(p);
      if (m) return m[m.length - 1];
    }
    return null;
  }

  private async ensureToken(): Promise<void> {
    if (this.accessToken && Date.now() < this.tokenExpiry) return;

    const url = `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      scope: 'https://management.azure.com/.default',
    }).toString();

    const data = await this.httpPost(url, body, { 'Content-Type': 'application/x-www-form-urlencoded' });
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  }

  private async azureFetch(url: string): Promise<any> {
    return this.httpFetch(url, { 'Authorization': `Bearer ${this.accessToken}` });
  }

  private async httpFetch(url: string, headers: Record<string, string> = {}): Promise<any> {
    const https = await import('https');
    const urlObj = new URL(url);
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        headers: { 'Content-Type': 'application/json', ...headers }
      }, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(data); } });
      });
      req.on('error', reject);
      req.end();
    });
  }

  private async httpPost(url: string, body: string, headers: Record<string, string>): Promise<any> {
    const https = await import('https');
    const urlObj = new URL(url);
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: urlObj.hostname,
        path: urlObj.pathname,
        method: 'POST',
        headers: { 'Content-Length': Buffer.byteLength(body), ...headers }
      }, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(data); } });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}
