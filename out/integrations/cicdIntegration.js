"use strict";
/**
 * CI/CD Integration
 * Supports: GitHub Actions, Azure DevOps, Jenkins
 *
 * Token strategy:
 *  - Only return the FAILED step + its log tail (last 50 lines)
 *  - Not the full build log (can be megabytes)
 *  - Includes run URL so Claude can reference it
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
exports.CICDIntegration = void 0;
const MAX_LOG_LINES = 50;
class CICDIntegration {
    constructor(config) {
        this.config = config;
    }
    async getMinimalContext(query, level) {
        try {
            const build = await this.getLatestBuild();
            if (!build)
                return '';
            return this.formatBuild(build, level);
        }
        catch (e) {
            return `## CI/CD\nCould not fetch build status: ${e}`;
        }
    }
    async getLatestBuild() {
        switch (this.config.provider) {
            case 'github-actions': return this.getGitHubBuild();
            case 'azure-devops': return this.getAzureBuild();
            case 'jenkins': return this.getJenkinsBuild();
            default: return null;
        }
    }
    async getGitHubBuild() {
        if (!this.config.githubToken || !this.config.githubRepo)
            return null;
        const data = await this.ghFetch(`/repos/${this.config.githubRepo}/actions/runs?per_page=1`);
        const run = data.workflow_runs?.[0];
        if (!run)
            return null;
        let failedLog = '';
        if (run.conclusion === 'failure') {
            failedLog = await this.getGitHubFailedLog(run.id);
        }
        return {
            id: run.id,
            status: this.mapGHStatus(run.conclusion || run.status),
            branch: run.head_branch,
            commit: run.head_sha?.slice(0, 8),
            startedAt: run.created_at?.slice(0, 19),
            url: run.html_url,
            failedLog,
        };
    }
    async getGitHubFailedLog(runId) {
        try {
            // Get failed jobs
            const jobs = await this.ghFetch(`/repos/${this.config.githubRepo}/actions/runs/${runId}/jobs`);
            const failedJob = jobs.jobs?.find((j) => j.conclusion === 'failure');
            if (!failedJob)
                return '';
            // Get the failed step
            const failedStep = failedJob.steps?.find((s) => s.conclusion === 'failure');
            const stepName = failedStep?.name || 'unknown step';
            // Fetch logs (GitHub returns a zip/text)
            // We return the step name as a pointer — logs require separate download
            return `Failed step: "${stepName}" in job "${failedJob.name}"\nURL: ${failedJob.html_url}`;
        }
        catch {
            return '';
        }
    }
    async getAzureBuild() {
        if (!this.config.azureOrgUrl || !this.config.azureProject || !this.config.azurePat)
            return null;
        const url = `${this.config.azureOrgUrl}/${this.config.azureProject}/_apis/build/builds?$top=1&api-version=7.0`;
        const auth = Buffer.from(`:${this.config.azurePat}`).toString('base64');
        const data = await this.httpFetch(url, { 'Authorization': `Basic ${auth}` });
        const build = data.value?.[0];
        if (!build)
            return null;
        return {
            id: build.id,
            status: this.mapAzureStatus(build.result || build.status),
            branch: build.sourceBranch?.replace('refs/heads/', ''),
            commit: build.sourceVersion?.slice(0, 8),
            startedAt: build.startTime?.slice(0, 19),
            url: build._links?.web?.href || '',
            failedLog: build.result === 'failed' ? 'See Azure DevOps for full log' : undefined,
        };
    }
    async getJenkinsBuild() {
        if (!this.config.jenkinsUrl || !this.config.jenkinsJob)
            return null;
        const url = `${this.config.jenkinsUrl}/job/${this.config.jenkinsJob}/lastBuild/api/json`;
        const auth = this.config.jenkinsUser
            ? Buffer.from(`${this.config.jenkinsUser}:${this.config.jenkinsToken}`).toString('base64')
            : undefined;
        const headers = {};
        if (auth)
            headers['Authorization'] = `Basic ${auth}`;
        const data = await this.httpFetch(url, headers);
        let failedLog = '';
        if (data.result === 'FAILURE') {
            try {
                const logUrl = `${this.config.jenkinsUrl}/job/${this.config.jenkinsJob}/lastBuild/consoleText`;
                const rawLog = await this.httpFetchText(logUrl, headers);
                const lines = rawLog.split('\n');
                const tail = lines.slice(-MAX_LOG_LINES).join('\n');
                failedLog = `Last ${MAX_LOG_LINES} lines:\n${tail}`;
            }
            catch { }
        }
        return {
            id: data.number,
            status: this.mapJenkinsStatus(data.result || (data.building ? 'RUNNING' : 'UNKNOWN')),
            branch: data.actions?.find((a) => a.parameters)?.parameters?.find((p) => p.name === 'BRANCH')?.value || 'unknown',
            commit: data.actions?.find((a) => a.lastBuiltRevision)?.lastBuiltRevision?.SHA1?.slice(0, 8) || '',
            startedAt: data.timestamp ? new Date(data.timestamp).toISOString().slice(0, 19) : '',
            duration: data.duration ? `${Math.round(data.duration / 1000)}s` : undefined,
            url: `${this.config.jenkinsUrl}/job/${this.config.jenkinsJob}/lastBuild`,
            failedLog,
        };
    }
    formatBuild(build, level) {
        const statusEmoji = { success: '✅', failure: '❌', running: '🔄', pending: '⏳', cancelled: '⛔' };
        const lines = [
            `## CI/CD Build`,
            `${statusEmoji[build.status] || ''} **${build.status.toUpperCase()}** — Branch: \`${build.branch}\` Commit: \`${build.commit}\``,
            `Started: ${build.startedAt}${build.duration ? ` | Duration: ${build.duration}` : ''}`,
            `URL: ${build.url}`,
        ];
        if (build.failedStep)
            lines.push(`\nFailed Step: ${build.failedStep}`);
        if (level >= 2 && build.failedLog) {
            lines.push(`\n\`\`\``);
            lines.push(build.failedLog);
            lines.push('```');
        }
        return lines.join('\n');
    }
    mapGHStatus(s) {
        const map = {
            success: 'success', failure: 'failure', cancelled: 'cancelled',
            in_progress: 'running', queued: 'pending', neutral: 'success',
        };
        return map[s] || 'pending';
    }
    mapAzureStatus(s) {
        const map = {
            succeeded: 'success', failed: 'failure', cancelled: 'cancelled',
            inProgress: 'running', notStarted: 'pending',
        };
        return map[s] || 'pending';
    }
    mapJenkinsStatus(s) {
        const map = {
            SUCCESS: 'success', FAILURE: 'failure', ABORTED: 'cancelled',
            RUNNING: 'running', UNSTABLE: 'failure',
        };
        return map[s] || 'pending';
    }
    async ghFetch(path) {
        return this.httpFetch(`https://api.github.com${path}`, {
            'Authorization': `Bearer ${this.config.githubToken}`,
            'Accept': 'application/vnd.github+json',
        });
    }
    async httpFetch(url, headers = {}) {
        const text = await this.httpFetchText(url, headers);
        return JSON.parse(text);
    }
    async httpFetchText(url, headers = {}) {
        const https = await Promise.resolve().then(() => __importStar(require('https')));
        const http = await Promise.resolve().then(() => __importStar(require('http')));
        const urlObj = new URL(url);
        const lib = urlObj.protocol === 'https:' ? https : http;
        return new Promise((resolve, reject) => {
            const req = lib.request({
                hostname: urlObj.hostname,
                path: urlObj.pathname + urlObj.search,
                method: 'GET',
                headers: { 'User-Agent': 'claude-optimizer/1.0', ...headers }
            }, (res) => {
                let data = '';
                res.on('data', (c) => { data += c; });
                res.on('end', () => resolve(data));
            });
            req.on('error', reject);
            req.end();
        });
    }
}
exports.CICDIntegration = CICDIntegration;
