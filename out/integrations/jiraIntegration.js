"use strict";
/**
 * Jira Integration
 * Fetches minimal ticket context — title, status, priority, description summary.
 * Does NOT dump full comment history (huge token waste).
 * Extracts Jira ticket IDs from the user's message automatically.
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
exports.JiraIntegration = void 0;
const TICKET_PATTERN = /\b([A-Z][A-Z0-9]+-\d+)\b/g;
const MAX_DESCRIPTION_CHARS = 500;
class JiraIntegration {
    constructor(config) {
        this.config = config;
    }
    async getMinimalContext(query, level) {
        const ticketIds = this.extractTicketIds(query);
        if (ticketIds.length === 0 && !this.config.defaultProject)
            return '';
        const results = ['## Jira Context'];
        if (ticketIds.length > 0) {
            for (const id of ticketIds.slice(0, 3)) { // max 3 tickets
                try {
                    const ticket = await this.fetchTicket(id);
                    results.push(this.formatTicket(ticket, level));
                }
                catch (e) {
                    results.push(`- ${id}: Could not fetch (${e})`);
                }
            }
        }
        // Level 2+: also include active sprint overview
        if (level >= 2 && this.config.defaultProject) {
            try {
                const sprint = await this.fetchActiveSprint(this.config.defaultProject);
                if (sprint)
                    results.push(sprint);
            }
            catch { }
        }
        return results.join('\n\n');
    }
    extractTicketIds(text) {
        const matches = text.match(TICKET_PATTERN) || [];
        return [...new Set(matches)];
    }
    async fetchTicket(ticketId) {
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
    async fetchActiveSprint(projectKey) {
        const url = `${this.config.baseUrl}/rest/agile/1.0/board?projectKeyOrId=${projectKey}`;
        const boards = await this.apiFetch(url);
        if (!boards.values?.length)
            return '';
        const boardId = boards.values[0].id;
        const sprintUrl = `${this.config.baseUrl}/rest/agile/1.0/board/${boardId}/sprint?state=active`;
        const sprints = await this.apiFetch(sprintUrl);
        if (!sprints.values?.length)
            return '';
        const sprint = sprints.values[0];
        return `### Active Sprint: ${sprint.name}\nGoal: ${sprint.goal || 'None'}\nEnd: ${sprint.endDate?.slice(0, 10) || 'N/A'}`;
    }
    formatTicket(t, level) {
        const lines = [
            `### ${t.key}: ${t.summary}`,
            `Status: ${t.status} | Priority: ${t.priority} | Assignee: ${t.assignee}`,
            `Updated: ${t.updated}`,
        ];
        if (t.sprint)
            lines.push(`Sprint: ${t.sprint}`);
        if (t.storyPoints)
            lines.push(`Story Points: ${t.storyPoints}`);
        if (t.labels.length > 0)
            lines.push(`Labels: ${t.labels.join(', ')}`);
        if (level >= 2 && t.description) {
            lines.push(`\nDescription:\n${t.description}`);
        }
        return lines.join('\n');
    }
    extractDescription(desc) {
        if (!desc)
            return '';
        if (typeof desc === 'string')
            return desc.slice(0, MAX_DESCRIPTION_CHARS);
        // Jira Atlassian Document Format (ADF)
        try {
            const text = this.adfToText(desc);
            return text.slice(0, MAX_DESCRIPTION_CHARS);
        }
        catch {
            return JSON.stringify(desc).slice(0, MAX_DESCRIPTION_CHARS);
        }
    }
    adfToText(node) {
        if (!node)
            return '';
        if (node.type === 'text')
            return node.text || '';
        if (node.content)
            return node.content.map((n) => this.adfToText(n)).join(' ');
        return '';
    }
    async apiFetch(url) {
        const auth = Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString('base64');
        const https = await Promise.resolve().then(() => __importStar(require('https')));
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
                res.on('data', (c) => { data += c; });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    }
                    catch {
                        reject(new Error(data));
                    }
                });
            });
            req.on('error', reject);
            req.end();
        });
    }
}
exports.JiraIntegration = JiraIntegration;
