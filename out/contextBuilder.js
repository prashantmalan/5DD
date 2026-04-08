"use strict";
/**
 * Context Builder
 * The brain of the optimizer. Assembles the minimal context needed for each Claude request.
 *
 * Strategy:
 *  1. Start with a budget (max tokens for context)
 *  2. For each source (logs, git, Jira, CI, DB...) fetch the minimum slice
 *  3. If Claude's reply indicates it needs more info, fetch the next slice
 *  4. Never dump everything — always ask/fetch incrementally
 *
 * "Progressive disclosure" pattern:
 *  - Level 1: Error summary + last 3 commits + CI status   (~300 tokens)
 *  - Level 2: + relevant file diff + Jira ticket summary    (~600 tokens)
 *  - Level 3: + full stack trace + DB schema snippet        (~1200 tokens)
 *  - Level 4+: Claude asks for specific additional context
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContextBuilder = void 0;
// Keywords that signal which context sources to include automatically
const SOURCE_TRIGGERS = {
    logs: [/\b(error|crash|fail|exception|log|stack trace|traceback)\b/i],
    git: [/\b(commit|branch|diff|merge|pull request|pr|pushed|git)\b/i],
    jira: [/\b(ticket|issue|jira|story|sprint|backlog|[A-Z]{2,}-\d+)\b/],
    confluence: [/\b(wiki|confluence|docs|documentation|runbook)\b/i],
    cicd: [/\b(pipeline|build|deploy|ci|cd|github actions|jenkins|azure devops)\b/i],
    azure: [/\b(azure|resource group|subscription|aks|app service|function app)\b/i],
    databricks: [/\b(databricks|spark|notebook|cluster|delta|mlflow)\b/i],
    terraform: [/\b(terraform|tfstate|plan|apply|infra|resource|provider)\b/i],
    database: [/\b(sql|query|table|schema|database|db|postgres|mysql|mongo)\b/i],
    api: [/\b(api|endpoint|request|response|http|rest|graphql|curl)\b/i],
};
class ContextBuilder {
    constructor(logMonitor, gitMonitor) {
        this.integrations = new Map();
        this.logMonitor = logMonitor;
        this.gitMonitor = gitMonitor;
    }
    registerIntegration(type, provider) {
        this.integrations.set(type, provider);
    }
    /**
     * Builds the minimum context needed for the user's message.
     * Returns sources sorted by relevance, within token budget.
     */
    async build(request) {
        const budget = request.tokenBudget || 1500;
        const level = request.level || 1;
        const sources = [];
        const followUpQuestions = [];
        let totalTokens = 0;
        // Detect which sources are relevant
        const relevantSources = this.detectRelevantSources(request.userMessage, request.include, request.exclude);
        // Level 1: Always include if available and relevant
        if (level >= 1) {
            // Logs (level 1 = error summary only)
            if (relevantSources.has('logs')) {
                const logCtx = this.logMonitor.buildErrorContext(3);
                if (logCtx) {
                    const cost = Math.ceil(logCtx.length / 4);
                    if (totalTokens + cost <= budget) {
                        sources.push({ name: 'logs', level: 1, tokenCost: cost, content: logCtx });
                        totalTokens += cost;
                    }
                }
            }
            // Git (level 1 = last 3 commits + status)
            if (relevantSources.has('git')) {
                const gitCtx = this.gitMonitor.buildContextBlock(3);
                if (gitCtx) {
                    const cost = Math.ceil(gitCtx.length / 4);
                    if (totalTokens + cost <= budget) {
                        sources.push({ name: 'git', level: 1, tokenCost: cost, content: gitCtx });
                        totalTokens += cost;
                    }
                }
            }
        }
        // Level 2+: Pull from registered integrations
        if (level >= 2) {
            for (const sourceType of relevantSources) {
                if (sourceType === 'logs' || sourceType === 'git')
                    continue;
                const provider = this.integrations.get(sourceType);
                if (!provider) {
                    followUpQuestions.push(this.buildFollowUpQuestion(sourceType));
                    continue;
                }
                try {
                    const ctx = await provider.getMinimalContext(request.userMessage, level);
                    if (ctx) {
                        const cost = Math.ceil(ctx.length / 4);
                        if (totalTokens + cost <= budget) {
                            sources.push({ name: sourceType, level: 2, tokenCost: cost, content: ctx });
                            totalTokens += cost;
                        }
                        else {
                            followUpQuestions.push(`Ask for more ${sourceType} details if needed.`);
                        }
                    }
                }
                catch (e) {
                    followUpQuestions.push(`Could not fetch ${sourceType} context: ${e}`);
                }
            }
        }
        return {
            sources,
            totalTokens,
            budget,
            overBudget: totalTokens > budget,
            followUpNeeded: followUpQuestions.length > 0,
            followUpQuestions
        };
    }
    /**
     * Converts built context into a compact system prompt injection.
     */
    toSystemPromptBlock(ctx) {
        if (ctx.sources.length === 0)
            return '';
        const lines = [
            '## Developer Context (auto-fetched, minimized)',
            `*${ctx.totalTokens} tokens used of ${ctx.budget} budget*`,
            ''
        ];
        for (const src of ctx.sources) {
            lines.push(src.content);
            lines.push('');
        }
        if (ctx.followUpNeeded) {
            lines.push('---');
            lines.push('*Additional context available — ask for:*');
            for (const q of ctx.followUpQuestions) {
                lines.push(`- ${q}`);
            }
        }
        return lines.join('\n');
    }
    detectRelevantSources(message, include, exclude) {
        const relevant = new Set();
        if (include) {
            for (const s of include)
                relevant.add(s);
            return relevant;
        }
        for (const [source, patterns] of Object.entries(SOURCE_TRIGGERS)) {
            for (const pattern of patterns) {
                if (pattern.test(message)) {
                    relevant.add(source);
                    break;
                }
            }
        }
        if (exclude) {
            for (const s of exclude)
                relevant.delete(s);
        }
        return relevant;
    }
    buildFollowUpQuestion(source) {
        const questions = {
            jira: 'Jira ticket ID or sprint details',
            confluence: 'Confluence space/page name for relevant docs',
            cicd: 'CI/CD pipeline name or run ID',
            azure: 'Azure resource name or subscription ID',
            databricks: 'Databricks workspace URL or cluster ID',
            terraform: 'Terraform state file path or workspace name',
            database: 'Database connection details and table/query of interest',
            api: 'API endpoint URL and relevant request/response samples',
            logs: 'Log file path',
            git: 'Repository path',
        };
        return questions[source] || `More details about ${source}`;
    }
}
exports.ContextBuilder = ContextBuilder;
