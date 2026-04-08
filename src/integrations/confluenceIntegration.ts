/**
 * Confluence Integration
 * Fetches page summaries, not full page content.
 * Token strategy: title + first 300 chars of body + labels.
 */

import { IntegrationProvider } from '../contextBuilder';

export interface ConfluenceConfig {
  baseUrl: string;    // e.g. https://mycompany.atlassian.net/wiki
  email: string;
  apiToken: string;
  defaultSpace?: string;
}

export class ConfluenceIntegration implements IntegrationProvider {
  constructor(private config: ConfluenceConfig) {}

  async getMinimalContext(query: string, level: number): Promise<string> {
    const results: string[] = ['## Confluence Context'];

    try {
      const pages = await this.searchPages(query, level >= 2 ? 3 : 1);
      if (pages.length === 0) {
        results.push('No relevant pages found.');
      } else {
        for (const page of pages) {
          results.push(this.formatPage(page, level));
        }
      }
    } catch (e) {
      results.push(`Could not fetch Confluence: ${e}`);
    }

    return results.join('\n\n');
  }

  private async searchPages(query: string, limit: number): Promise<any[]> {
    // Use CQL (Confluence Query Language) for targeted search
    const cql = encodeURIComponent(
      `text ~ "${query.slice(0, 60)}" AND type = "page"` +
      (this.config.defaultSpace ? ` AND space = "${this.config.defaultSpace}"` : '')
    );
    const url = `${this.config.baseUrl}/rest/api/content/search?cql=${cql}&limit=${limit}&expand=body.view,metadata.labels`;
    const data = await this.cfFetch(url);
    return data.results || [];
  }

  private formatPage(page: any, level: number): string {
    const title = page.title || 'Untitled';
    const url = `${this.config.baseUrl}${page._links?.webui || ''}`;
    const labels = (page.metadata?.labels?.results || []).map((l: any) => l.name).join(', ');

    const lines = [`### ${title}`, `URL: ${url}`];
    if (labels) lines.push(`Labels: ${labels}`);

    if (level >= 2 && page.body?.view?.value) {
      // Strip HTML tags and truncate
      const text = page.body.view.value
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 400);
      lines.push(`\nExcerpt: ${text}...`);
    }

    return lines.join('\n');
  }

  private async cfFetch(url: string): Promise<any> {
    const https = await import('https');
    const auth = Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString('base64');
    const urlObj = new URL(url);

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' }
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
