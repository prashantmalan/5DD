/**
 * Jira Integration
 * Fetches minimal ticket context — title, status, priority, description summary.
 * Does NOT dump full comment history (huge token waste).
 * Extracts Jira ticket IDs from the user's message automatically.
 */

import { IntegrationProvider } from '../contextBuilder';

export interface JiraConfig {
  baseUrl: string;       // e.g. https://mycompany.atlassian.net
  email: string;
  apiToken: string;
  defaultProject?: string;
}

export interface JiraTicket {
  key: string;
  summary: string;
  status: string;
  priority: string;
  assignee: string;
  reporter: string;
  created: string;
  updated: string;
  description: string;  // truncated
  labels: string[];
  sprint?: string;
  storyPoints?: number;
}

const TICKET_PATTERN = /\b([A-Z][A-Z0-9]+-\d+)\b/g;
const MAX_DESCRIPTION_CHARS = 500;

export class JiraIntegration implements IntegrationProvider {
  private config: JiraConfig;

  constructor(config: JiraConfig) {
    this.config = config;
  }

  async getMinimalContext(query: string, level: number): Promise<string> {
    const ticketIds = this.extractTicketIds(query);
    if (ticketIds.length === 0 && !this.config.defaultProject) return '';

    const results: string[] = ['## Jira Context'];

    if (ticketIds.length > 0) {
      for (const id of ticketIds.slice(0, 3)) {  // max 3 tickets
        try {
          const ticket = await this.fetchTicket(id);
          results.push(this.formatTicket(ticket, level));
        } catch (e) {
          results.push(`- ${id}: Could not fetch (${e})`);
        }
      }
    }

    // Level 2+: also include active sprint overview
    if (level >= 2 && this.config.defaultProject) {
      try {
        const sprint = await this.fetchActiveSprint(this.config.defaultProject);
        if (sprint) results.push(sprint);
      } catch {}
    }

    return results.join('\n\n');
  }

  private extractTicketIds(text: string): string[] {
    const matches = text.match(TICKET_PATTERN) || [];
    return [...new Set(matches)];
  }

  private async fetchTicket(ticketId: string): Promise<JiraTicket> {
    const url = `${this.config.baseUrl}/rest/api/3/issue/${ticketId}?fields=summary,status,priority,assignee,reporter,created,updated,description,labels,customfield_10016,customfield_10020`;
    const response = await this.apiFetch(url);
    const f = response.fields;

    return {
      key: ticketId,
      summary: f.summary || '',
      status: f.status?.name || 'Unknown',
      priority: f.priority?.name || 'None',
      assignee: f.assignee?.displayName || 'Unassigned',
      reporter: f.reporter?.displayName || '',
      created: f.created?.slice(0, 10) || '',
      updated: f.updated?.slice(0, 10) || '',
      description: this.extractDescription(f.description),
      labels: f.labels || [],
      storyPoints: f.customfield_10016,
      sprint: f.customfield_10020?.[0]?.name,
    };
  }

  private async fetchActiveSprint(projectKey: string): Promise<string> {
    const url = `${this.config.baseUrl}/rest/agile/1.0/board?projectKeyOrId=${projectKey}`;
    const boards = await this.apiFetch(url);
    if (!boards.values?.length) return '';

    const boardId = boards.values[0].id;
    const sprintUrl = `${this.config.baseUrl}/rest/agile/1.0/board/${boardId}/sprint?state=active`;
    const sprints = await this.apiFetch(sprintUrl);
    if (!sprints.values?.length) return '';

    const sprint = sprints.values[0];
    return `### Active Sprint: ${sprint.name}\nGoal: ${sprint.goal || 'None'}\nEnd: ${sprint.endDate?.slice(0, 10) || 'N/A'}`;
  }

  private formatTicket(t: JiraTicket, level: number): string {
    const lines = [
      `### ${t.key}: ${t.summary}`,
      `Status: ${t.status} | Priority: ${t.priority} | Assignee: ${t.assignee}`,
      `Updated: ${t.updated}`,
    ];

    if (t.sprint) lines.push(`Sprint: ${t.sprint}`);
    if (t.storyPoints) lines.push(`Story Points: ${t.storyPoints}`);
    if (t.labels.length > 0) lines.push(`Labels: ${t.labels.join(', ')}`);

    if (level >= 2 && t.description) {
      lines.push(`\nDescription:\n${t.description}`);
    }

    return lines.join('\n');
  }

  private extractDescription(desc: any): string {
    if (!desc) return '';
    if (typeof desc === 'string') return desc.slice(0, MAX_DESCRIPTION_CHARS);

    // Jira Atlassian Document Format (ADF)
    try {
      const text = this.adfToText(desc);
      return text.slice(0, MAX_DESCRIPTION_CHARS);
    } catch {
      return JSON.stringify(desc).slice(0, MAX_DESCRIPTION_CHARS);
    }
  }

  private adfToText(node: any): string {
    if (!node) return '';
    if (node.type === 'text') return node.text || '';
    if (node.content) return node.content.map((n: any) => this.adfToText(n)).join(' ');
    return '';
  }

  private async apiFetch(url: string): Promise<any> {
    const auth = Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString('base64');
    const https = await import('https');
    const urlObj = new URL(url);

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Accept': 'application/json',
        }
      }, (res) => {
        let data = '';
        res.on('data', (c: any) => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { reject(new Error(data)); }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }
}
