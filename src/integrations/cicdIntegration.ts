/**
 * CI/CD Integration
 * Supports: GitHub Actions, Azure DevOps, Jenkins
 *
 * Token strategy:
 *  - Only return the FAILED step + its log tail (last 50 lines)
 *  - Not the full build log (can be megabytes)
 *  - Includes run URL so Claude can reference it
 */

import { IntegrationProvider } from '../contextBuilder';

export type CICDProvider = 'github-actions' | 'azure-devops' | 'jenkins';

export interface CICDConfig {
  provider: CICDProvider;
  // GitHub Actions
  githubToken?: string;
  githubRepo?: string;          // owner/repo

  // Azure DevOps
  azureOrgUrl?: string;         // https://dev.azure.com/myorg
  azureProject?: string;
  azurePat?: string;

  // Jenkins
  jenkinsUrl?: string;
  jenkinsUser?: string;
  jenkinsToken?: string;
  jenkinsJob?: string;
}

export interface BuildResult {
  id: string | number;
  status: 'success' | 'failure' | 'running' | 'pending' | 'cancelled';
  branch: string;
  commit: string;
  startedAt: string;
  duration?: string;
  url: string;
  failedStep?: string;
  failedLog?: string;   // truncated to last N lines
}

const MAX_LOG_LINES = 50;

export class CICDIntegration implements IntegrationProvider {
  private config: CICDConfig;

  constructor(config: CICDConfig) {
    this.config = config;
  }

  async getMinimalContext(query: string, level: number): Promise<string> {
    try {
      const build = await this.getLatestBuild();
      if (!build) return '';
      return this.formatBuild(build, level);
    } catch (e) {
      return `## CI/CD\nCould not fetch build status: ${e}`;
    }
  }

  async getLatestBuild(): Promise<BuildResult | null> {
    switch (this.config.provider) {
      case 'github-actions': return this.getGitHubBuild();
      case 'azure-devops':   return this.getAzureBuild();
      case 'jenkins':        return this.getJenkinsBuild();
      default: return null;
    }
  }

  private async getGitHubBuild(): Promise<BuildResult | null> {
    if (!this.config.githubToken || !this.config.githubRepo) return null;

    const data = await this.ghFetch(`/repos/${this.config.githubRepo}/actions/runs?per_page=1`);
    const run = data.workflow_runs?.[0];
    if (!run) return null;

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

  private async getGitHubFailedLog(runId: number): Promise<string> {
    try {
      // Get failed jobs
      const jobs = await this.ghFetch(`/repos/${this.config.githubRepo}/actions/runs/${runId}/jobs`);
      const failedJob = jobs.jobs?.find((j: any) => j.conclusion === 'failure');
      if (!failedJob) return '';

      // Get the failed step
      const failedStep = failedJob.steps?.find((s: any) => s.conclusion === 'failure');
      const stepName = failedStep?.name || 'unknown step';

      // Fetch logs (GitHub returns a zip/text)
      // We return the step name as a pointer — logs require separate download
      return `Failed step: "${stepName}" in job "${failedJob.name}"\nURL: ${failedJob.html_url}`;
    } catch {
      return '';
    }
  }

  private async getAzureBuild(): Promise<BuildResult | null> {
    if (!this.config.azureOrgUrl || !this.config.azureProject || !this.config.azurePat) return null;

    const url = `${this.config.azureOrgUrl}/${this.config.azureProject}/_apis/build/builds?$top=1&api-version=7.0`;
    const auth = Buffer.from(`:${this.config.azurePat}`).toString('base64');
    const data = await this.httpFetch(url, { 'Authorization': `Basic ${auth}` });

    const build = data.value?.[0];
    if (!build) return null;

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

  private async getJenkinsBuild(): Promise<BuildResult | null> {
    if (!this.config.jenkinsUrl || !this.config.jenkinsJob) return null;

    const url = `${this.config.jenkinsUrl}/job/${this.config.jenkinsJob}/lastBuild/api/json`;
    const auth = this.config.jenkinsUser
      ? Buffer.from(`${this.config.jenkinsUser}:${this.config.jenkinsToken}`).toString('base64')
      : undefined;

    const headers: Record<string, string> = {};
    if (auth) headers['Authorization'] = `Basic ${auth}`;

    const data = await this.httpFetch(url, headers);

    let failedLog = '';
    if (data.result === 'FAILURE') {
      try {
        const logUrl = `${this.config.jenkinsUrl}/job/${this.config.jenkinsJob}/lastBuild/consoleText`;
        const rawLog = await this.httpFetchText(logUrl, headers);
        const lines = rawLog.split('\n');
        const tail = lines.slice(-MAX_LOG_LINES).join('\n');
        failedLog = `Last ${MAX_LOG_LINES} lines:\n${tail}`;
      } catch {}
    }

    return {
      id: data.number,
      status: this.mapJenkinsStatus(data.result || (data.building ? 'RUNNING' : 'UNKNOWN')),
      branch: data.actions?.find((a: any) => a.parameters)?.parameters?.find((p: any) => p.name === 'BRANCH')?.value || 'unknown',
      commit: data.actions?.find((a: any) => a.lastBuiltRevision)?.lastBuiltRevision?.SHA1?.slice(0, 8) || '',
      startedAt: data.timestamp ? new Date(data.timestamp).toISOString().slice(0, 19) : '',
      duration: data.duration ? `${Math.round(data.duration / 1000)}s` : undefined,
      url: `${this.config.jenkinsUrl}/job/${this.config.jenkinsJob}/lastBuild`,
      failedLog,
    };
  }

  private formatBuild(build: BuildResult, level: number): string {
    const statusEmoji = { success: '✅', failure: '❌', running: '🔄', pending: '⏳', cancelled: '⛔' };
    const lines = [
      `## CI/CD Build`,
      `${statusEmoji[build.status] || ''} **${build.status.toUpperCase()}** — Branch: \`${build.branch}\` Commit: \`${build.commit}\``,
      `Started: ${build.startedAt}${build.duration ? ` | Duration: ${build.duration}` : ''}`,
      `URL: ${build.url}`,
    ];

    if (build.failedStep) lines.push(`\nFailed Step: ${build.failedStep}`);

    if (level >= 2 && build.failedLog) {
      lines.push(`\n\`\`\``);
      lines.push(build.failedLog);
      lines.push('```');
    }

    return lines.join('\n');
  }

  private mapGHStatus(s: string): BuildResult['status'] {
    const map: Record<string, BuildResult['status']> = {
      success: 'success', failure: 'failure', cancelled: 'cancelled',
      in_progress: 'running', queued: 'pending', neutral: 'success',
    };
    return map[s] || 'pending';
  }

  private mapAzureStatus(s: string): BuildResult['status'] {
    const map: Record<string, BuildResult['status']> = {
      succeeded: 'success', failed: 'failure', cancelled: 'cancelled',
      inProgress: 'running', notStarted: 'pending',
    };
    return map[s] || 'pending';
  }

  private mapJenkinsStatus(s: string): BuildResult['status'] {
    const map: Record<string, BuildResult['status']> = {
      SUCCESS: 'success', FAILURE: 'failure', ABORTED: 'cancelled',
      RUNNING: 'running', UNSTABLE: 'failure',
    };
    return map[s] || 'pending';
  }

  private async ghFetch(path: string): Promise<any> {
    return this.httpFetch(`https://api.github.com${path}`, {
      'Authorization': `Bearer ${this.config.githubToken}`,
      'Accept': 'application/vnd.github+json',
    });
  }

  private async httpFetch(url: string, headers: Record<string, string> = {}): Promise<any> {
    const text = await this.httpFetchText(url, headers);
    return JSON.parse(text);
  }

  private async httpFetchText(url: string, headers: Record<string, string> = {}): Promise<string> {
    const https = await import('https');
    const http = await import('http');
    const urlObj = new URL(url);
    const lib = urlObj.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      const req = (lib as any).request({
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: { 'User-Agent': 'claude-optimizer/1.0', ...headers }
      }, (res: any) => {
        let data = '';
        res.on('data', (c: any) => { data += c; });
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.end();
    });
  }
}
