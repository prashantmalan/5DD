"use strict";
/**
 * Claude Token Optimizer — VS Code Extension Entry Point
 *
 * Wires together:
 *  - Local proxy server (intercepts Anthropic API calls)
 *  - Token counter + prompt optimizer + semantic cache + model router
 *  - Log monitor + Git monitor
 *  - Context builder with integrations (Jira, CI/CD, Azure, etc.)
 *  - Dashboard webview + status bar
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
exports.out = void 0;
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const tokenCounter_1 = require("./tokenCounter");
const promptOptimizer_1 = require("./promptOptimizer");
const semanticCache_1 = require("./semanticCache");
const modelRouter_1 = require("./modelRouter");
const statsTracker_1 = require("./statsTracker");
const proxyServer_1 = require("./proxyServer");
const logMonitor_1 = require("./logMonitor");
const gitMonitor_1 = require("./gitMonitor");
const contextBuilder_1 = require("./contextBuilder");
const dashboardServer_1 = require("./dashboard/dashboardServer");
// Integrations
const jiraIntegration_1 = require("./integrations/jiraIntegration");
const confluenceIntegration_1 = require("./integrations/confluenceIntegration");
const cicdIntegration_1 = require("./integrations/cicdIntegration");
const azureIntegration_1 = require("./integrations/azureIntegration");
const databricksIntegration_1 = require("./integrations/databricksIntegration");
const terraformIntegration_1 = require("./integrations/terraformIntegration");
const databaseIntegration_1 = require("./integrations/databaseIntegration");
let statusBarItem;
let proxy = null;
let tokenCounter;
let stats;
async function activate(context) {
    exports.out = vscode.window.createOutputChannel('Claude Steward');
    context.subscriptions.push(exports.out);
    exports.out.appendLine('[Claude Steward] Activating...');
    const config = vscode.workspace.getConfiguration('claudeOptimizer');
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    // ── Core modules ──────────────────────────────────────────────────────────
    tokenCounter = new tokenCounter_1.TokenCounter();
    await tokenCounter.init();
    const cache = new semanticCache_1.SemanticCache(config.get('cacheThreshold', 0.92));
    const optimizer = new promptOptimizer_1.PromptOptimizer(tokenCounter);
    const routerConfig = {
        enabled: config.get('enableModelRouter', true),
        apiKey: config.get('anthropicApiKey', '') || process.env.ANTHROPIC_API_KEY || '',
        minimumModel: config.get('minimumModel'),
        allowOpus: config.get('allowOpus', false),
    };
    const router = new modelRouter_1.ModelRouter(routerConfig);
    stats = new statsTracker_1.StatsTracker(context);
    // ── Context system ────────────────────────────────────────────────────────
    const logMonitor = new logMonitor_1.LogMonitor();
    const gitMonitor = new gitMonitor_1.GitMonitor(workspaceRoot);
    const contextBuilder = new contextBuilder_1.ContextBuilder(logMonitor, gitMonitor);
    registerIntegrations(contextBuilder, config, workspaceRoot);
    // Auto-watch logs in workspace
    const logsDir = vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri || vscode.Uri.file(workspaceRoot), 'logs');
    logMonitor.watchDirectory(logsDir.fsPath, '*.log');
    // ── Status bar ────────────────────────────────────────────────────────────
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'claudeOptimizer.toggle';
    statusBarItem.tooltip = 'Click to toggle optimizer ON/OFF';
    updateStatusBar(0, false, true);
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    // Update status bar on every stat update
    stats.onUpdate(s => {
        updateStatusBar(s.totalSavedTokens, proxy?.isRunning() ?? false);
    });
    // ── Proxy server ──────────────────────────────────────────────────────────
    const proxyConfig = {
        port: config.get('proxyPort', 8787),
        enabled: true,
        enableCache: config.get('enableCache', true),
        enableCompression: config.get('enablePromptCompression', true),
        enableModelRouter: config.get('enableModelRouter', true),
        apiKey: config.get('anthropicApiKey', '') || process.env.ANTHROPIC_API_KEY || '',
    };
    proxy = new proxyServer_1.ProxyServer(proxyConfig, cache, optimizer, router, tokenCounter, stats, (msg) => exports.out.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${msg}`));
    // ── Dashboard HTTP server ─────────────────────────────────────────────────
    const dashboardPort = config.get('dashboardPort', 8788);
    const dashboardServer = new dashboardServer_1.DashboardServer(stats, dashboardPort, () => proxy.getTraces());
    let dashboardUrl = `http://localhost:${dashboardPort}`;
    try {
        dashboardUrl = await dashboardServer.start();
        console.log(`[Claude Optimizer] Dashboard at ${dashboardUrl}`);
    }
    catch {
        console.warn('[Claude Optimizer] Dashboard server failed to start');
    }
    context.subscriptions.push({ dispose: () => dashboardServer.stop() });
    // Auto-start proxy. If port is already taken, another VS Code window owns it — attach to it.
    const proxyUrl = `http://localhost:${proxyConfig.port}`;
    try {
        await proxy.start();
        process.env['ANTHROPIC_BASE_URL'] = proxyUrl;
        exports.out.appendLine(`[PROXY UP] Listening on ${proxyUrl} — all Claude Code traffic routes through us`);
        exports.out.appendLine(`[DASHBOARD] ${dashboardUrl}`);
        exports.out.appendLine(`⚠️  IMPORTANT: Reload VS Code window to activate routing through the proxy`);
        exports.out.show(true);
        updateStatusBar(0, true);
        vscode.window.showInformationMessage(`Claude Steward: Proxy ready. Reload window to activate routing.`, 'Reload Now').then(choice => {
            if (choice === 'Reload Now') {
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        });
    }
    catch (err) {
        if (err.message?.includes('already in use')) {
            // Another window's proxy is running — attach to it
            process.env['ANTHROPIC_BASE_URL'] = proxyUrl;
            exports.out.appendLine(`[PROXY] Port ${proxyConfig.port} already in use — attaching to existing proxy`);
            exports.out.show(true);
            updateStatusBar(0, true);
            vscode.window.showInformationMessage(`Claude Steward: Attached to existing proxy on :${proxyConfig.port}`);
        }
        else {
            exports.out.appendLine(`[PROXY ERROR] ${err.message}`);
            vscode.window.showWarningMessage(`Claude Steward: proxy failed to start — ${err.message}.`);
        }
    }
    // ── Commands ──────────────────────────────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('claudeOptimizer.showDashboard', () => {
        vscode.env.openExternal(vscode.Uri.parse(dashboardUrl));
    }), vscode.commands.registerCommand('claudeOptimizer.toggle', () => {
        if (!proxy?.isRunning()) {
            vscode.window.showWarningMessage('Claude Optimizer: Proxy is not running. Press F5 first.');
            return;
        }
        const nowEnabled = proxy.toggle();
        const s = stats.getSessionStats();
        updateStatusBar(s.totalSavedTokens, true, nowEnabled);
        vscode.window.showInformationMessage(nowEnabled
            ? 'Claude Optimizer: ON — optimizing requests'
            : 'Claude Optimizer: PAUSED — passing through unchanged');
    }), vscode.commands.registerCommand('claudeOptimizer.startProxy', async () => {
        if (proxy?.isRunning()) {
            vscode.window.showInformationMessage('Proxy is already running.');
            return;
        }
        try {
            await proxy.start();
            updateStatusBar(stats.getSessionStats().totalSavedTokens, true);
            vscode.window.showInformationMessage(`Proxy started on port ${proxyConfig.port}.`);
        }
        catch (e) {
            vscode.window.showErrorMessage(`Proxy failed: ${e.message}`);
        }
    }), vscode.commands.registerCommand('claudeOptimizer.stopProxy', async () => {
        await proxy?.stop();
        updateStatusBar(stats.getSessionStats().totalSavedTokens, false);
        vscode.window.showInformationMessage('Proxy stopped.');
    }), vscode.commands.registerCommand('claudeOptimizer.clearCache', () => {
        cache.clear();
        vscode.window.showInformationMessage('Cache cleared.');
    }), vscode.commands.registerCommand('claudeOptimizer.clearProxyState', () => {
        cache.clear();
        stats.clear();
        vscode.window.showInformationMessage('Proxy state cleared (cache + stats reset).');
    }), vscode.commands.registerCommand('claudeOptimizer.optimizeSelection', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) {
            vscode.window.showWarningMessage('Select a prompt to optimize.');
            return;
        }
        const selected = editor.document.getText(editor.selection);
        const result = optimizer.optimize({
            model: 'claude-sonnet-4-6',
            messages: [{ role: 'user', content: selected }]
        });
        const savedPct = result.originalTokens > 0
            ? ((result.savedTokens / result.originalTokens) * 100).toFixed(1)
            : '0';
        vscode.window.showInformationMessage(`Optimized: ${result.originalTokens} → ${result.optimizedTokens} tokens (${savedPct}% saved). Techniques: ${result.techniques.join(', ') || 'none'}`);
    }));
    // ── Config change listener ─────────────────────────────────────────────
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (!e.affectsConfiguration('claudeOptimizer'))
            return;
        const c = vscode.workspace.getConfiguration('claudeOptimizer');
        proxy?.updateConfig({
            enableCache: c.get('enableCache'),
            enableCompression: c.get('enablePromptCompression'),
            enableModelRouter: c.get('enableModelRouter'),
        });
        cache.updateThreshold(c.get('cacheThreshold', 0.92));
    }));
    // Cleanup
    context.subscriptions.push({
        dispose: async () => {
            await proxy?.stop();
            delete process.env['ANTHROPIC_BASE_URL'];
            logMonitor.dispose();
            tokenCounter.dispose();
            stats.dispose();
        }
    });
    console.log('[Claude Optimizer] Active. Proxy:', proxy.isRunning() ? 'running' : 'stopped');
}
async function deactivate() {
    delete process.env['ANTHROPIC_BASE_URL'];
    try {
        exports.out.appendLine(`⚠️  IMPORTANT: Reload VS Code window to stop routing through the proxy`);
    }
    catch { }
    await proxy?.stop();
}
// ── Helpers ────────────────────────────────────────────────────────────────
function updateStatusBar(savedTokens, proxyRunning, optimizerEnabled = true) {
    const icon = !proxyRunning ? '$(circle-slash)' : optimizerEnabled ? '$(shield)' : '$(debug-pause)';
    const saved = savedTokens >= 1000 ? `${(savedTokens / 1000).toFixed(1)}k` : String(savedTokens);
    const state = !proxyRunning ? 'OFF' : optimizerEnabled ? `${saved} tokens saved` : 'PAUSED';
    statusBarItem.text = `${icon} Claude Optimizer: ${state}`;
    statusBarItem.backgroundColor = optimizerEnabled && proxyRunning
        ? undefined
        : new vscode.ThemeColor('statusBarItem.warningBackground');
}
function registerIntegrations(builder, config, workspaceRoot) {
    // Jira
    const jiraUrl = config.get('jira.baseUrl', '');
    if (jiraUrl) {
        builder.registerIntegration('jira', new jiraIntegration_1.JiraIntegration({
            baseUrl: jiraUrl,
            email: config.get('jira.email', ''),
            apiToken: config.get('jira.apiToken', '') || process.env.JIRA_API_TOKEN || '',
            defaultProject: config.get('jira.defaultProject'),
        }));
    }
    // Confluence
    const cfUrl = config.get('confluence.baseUrl', '');
    if (cfUrl) {
        builder.registerIntegration('confluence', new confluenceIntegration_1.ConfluenceIntegration({
            baseUrl: cfUrl,
            email: config.get('confluence.email', ''),
            apiToken: config.get('confluence.apiToken', '') || process.env.CONFLUENCE_API_TOKEN || '',
            defaultSpace: config.get('confluence.defaultSpace'),
        }));
    }
    // CI/CD
    const ciProvider = config.get('cicd.provider', '');
    if (ciProvider) {
        builder.registerIntegration('cicd', new cicdIntegration_1.CICDIntegration({
            provider: ciProvider,
            githubToken: process.env.GITHUB_TOKEN || config.get('cicd.githubToken'),
            githubRepo: config.get('cicd.githubRepo'),
            azureOrgUrl: config.get('cicd.azureOrgUrl'),
            azureProject: config.get('cicd.azureProject'),
            azurePat: process.env.AZURE_DEVOPS_PAT || config.get('cicd.azurePat'),
            jenkinsUrl: config.get('cicd.jenkinsUrl'),
            jenkinsUser: config.get('cicd.jenkinsUser'),
            jenkinsToken: process.env.JENKINS_TOKEN || config.get('cicd.jenkinsToken'),
            jenkinsJob: config.get('cicd.jenkinsJob'),
        }));
    }
    // Azure
    const azureTenant = config.get('azure.tenantId', '') || process.env.AZURE_TENANT_ID || '';
    if (azureTenant) {
        builder.registerIntegration('azure', new azureIntegration_1.AzureIntegration({
            tenantId: azureTenant,
            clientId: config.get('azure.clientId', '') || process.env.AZURE_CLIENT_ID || '',
            clientSecret: config.get('azure.clientSecret', '') || process.env.AZURE_CLIENT_SECRET || '',
            subscriptionId: config.get('azure.subscriptionId', '') || process.env.AZURE_SUBSCRIPTION_ID || '',
            defaultResourceGroup: config.get('azure.defaultResourceGroup'),
        }));
    }
    // Databricks
    const dbHost = config.get('databricks.host', '') || process.env.DATABRICKS_HOST || '';
    if (dbHost) {
        builder.registerIntegration('databricks', new databricksIntegration_1.DatabricksIntegration({
            host: dbHost,
            token: config.get('databricks.token', '') || process.env.DATABRICKS_TOKEN || '',
            defaultClusterId: config.get('databricks.defaultClusterId'),
        }));
    }
    // Terraform
    const tfPath = config.get('terraform.workspacePath', workspaceRoot);
    builder.registerIntegration('terraform', new terraformIntegration_1.TerraformIntegration({ workspacePath: tfPath }));
    // Database
    const dbConnStr = config.get('database.connectionString', '') || process.env.DATABASE_URL || '';
    if (dbConnStr) {
        builder.registerIntegration('database', new databaseIntegration_1.DatabaseIntegration({
            type: config.get('database.type', 'postgres'),
            connectionString: dbConnStr,
            maxSampleRows: 3,
        }));
    }
}
