"use strict";
/**
 * Confluence Integration
 * Fetches page summaries, not full page content.
 * Token strategy: title + first 300 chars of body + labels.
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
exports.ConfluenceIntegration = void 0;
class ConfluenceIntegration {
    constructor(config) {
        this.config = config;
    }
    async getMinimalContext(query, level) {
        const results = ['## Confluence Context'];
        try {
            const pages = await this.searchPages(query, level >= 2 ? 3 : 1);
            if (pages.length === 0) {
                results.push('No relevant pages found.');
            }
            else {
                for (const page of pages) {
                    results.push(this.formatPage(page, level));
                }
            }
        }
        catch (e) {
            results.push(`Could not fetch Confluence: ${e}`);
        }
        return results.join('\n\n');
    }
    async searchPages(query, limit) {
        // Use CQL (Confluence Query Language) for targeted search
        const cql = encodeURIComponent(`text ~ "${query.slice(0, 60)}" AND type = "page"` +
            (this.config.defaultSpace ? ` AND space = "${this.config.defaultSpace}"` : ''));
        const url = `${this.config.baseUrl}/rest/api/content/search?cql=${cql}&limit=${limit}&expand=body.view,metadata.labels`;
        const data = await this.cfFetch(url);
        return data.results || [];
    }
    formatPage(page, level) {
        const title = page.title || 'Untitled';
        const url = `${this.config.baseUrl}${page._links?.webui || ''}`;
        const labels = (page.metadata?.labels?.results || []).map((l) => l.name).join(', ');
        const lines = [`### ${title}`, `URL: ${url}`];
        if (labels)
            lines.push(`Labels: ${labels}`);
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
    async cfFetch(url) {
        const https = await Promise.resolve().then(() => __importStar(require('https')));
        const auth = Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString('base64');
        const urlObj = new URL(url);
        return new Promise((resolve, reject) => {
            const req = https.request({
                hostname: urlObj.hostname,
                path: urlObj.pathname + urlObj.search,
                headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' }
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
exports.ConfluenceIntegration = ConfluenceIntegration;
