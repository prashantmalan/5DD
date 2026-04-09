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

import * as vscode from 'vscode';
import { TokenCounter } from './tokenCounter';
import { PromptOptimizer } from './promptOptimizer';
import { SemanticCache } from './semanticCache';
import { ModelRouter } from './modelRouter';
import { StatsTracker } from './statsTracker';
import { ProxyServer, ProxyConfig } from './proxyServer';
import { LogMonitor } from './logMonitor';
import { GitMonitor } from './gitMonitor';
import { ContextBuilder } from './contextBuilder';
import { DashboardPanel } from './dashboard/dashboardPanel';

// Integrations
import { JiraIntegration } from './integrations/jiraIntegration';
import { ConfluenceIntegration } from './integrations/confluenceIntegration';
import { CICDIntegration } from './integrations/cicdIntegration';
import { AzureIntegration } from './integrations/azureIntegration';
import { DatabricksIntegration } from './integrations/databricksIntegration';
import { TerraformIntegration } from './integrations/terraformIntegration';
import { DatabaseIntegration } from './integrations/databaseIntegration';

let statusBarItem: vscode.StatusBarItem;
let proxy: ProxyServer | null = null;
let tokenCounter: TokenCounter;
let stats: StatsTracker;

export async function activate(context: vscode.ExtensionContext) {
  console.log('[Claude Optimizer] Activating...');

  const config = vscode.workspace.getConfiguration('claudeOptimizer');
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

  // ── Core modules ──────────────────────────────────────────────────────────
  tokenCounter = new TokenCounter();
  await tokenCounter.init();

  const cache = new SemanticCache(
    config.get<number>('cacheThreshold', 0.92)
  );

  const optimizer = new PromptOptimizer(tokenCounter);
  const routerConfig = {
    enabled: config.get<boolean>('enableModelRouter', true),
    apiKey: config.get<string>('anthropicApiKey', '') || process.env.ANTHROPIC_API_KEY || '',
    minimumModel: config.get<string | undefined>('minimumModel'),
    allowOpus: config.get<boolean>('allowOpus', false),
  };
  const router = new ModelRouter(routerConfig);
  stats = new StatsTracker(context);

  // ── Context system ────────────────────────────────────────────────────────
  const logMonitor = new LogMonitor();
  const gitMonitor = new GitMonitor(workspaceRoot);
  const contextBuilder = new ContextBuilder(logMonitor, gitMonitor);

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
  const proxyConfig: ProxyConfig = {
    port: config.get<number>('proxyPort', 8787),
    enabled: true,
    enableCache: config.get<boolean>('enableCache', true),
    enableCompression: config.get<boolean>('enablePromptCompression', true),
    enableModelRouter: config.get<boolean>('enableModelRouter', true),
    apiKey: config.get<string>('anthropicApiKey', '') || process.env.ANTHROPIC_API_KEY || '',
  };

  proxy = new ProxyServer(proxyConfig, cache, optimizer, router, tokenCounter, stats);

  // Auto-start proxy
  try {
    await proxy.start();
    updateStatusBar(0, true);
    vscode.window.showInformationMessage(
      `Claude Optimizer: Proxy running on port ${proxyConfig.port}. Set ANTHROPIC_BASE_URL=http://localhost:${proxyConfig.port}`
    );
  } catch (err: any) {
    vscode.window.showWarningMessage(`Claude Optimizer: ${err.message}`);
  }

  // ── Commands ──────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeOptimizer.showDashboard', () => {
      DashboardPanel.show(context, stats);
    }),

    vscode.commands.registerCommand('claudeOptimizer.toggle', () => {
      if (!proxy?.isRunning()) {
        vscode.window.showWarningMessage('Claude Optimizer: Proxy is not running. Press F5 first.');
        return;
      }
      const nowEnabled = proxy!.toggle();
      const s = stats.getSessionStats();
      updateStatusBar(s.totalSavedTokens, true, nowEnabled);
      vscode.window.showInformationMessage(
        nowEnabled
          ? 'Claude Optimizer: ON — optimizing requests'
          : 'Claude Optimizer: PAUSED — passing through unchanged'
      );
    }),

    vscode.commands.registerCommand('claudeOptimizer.startProxy', async () => {
      if (proxy?.isRunning()) {
        vscode.window.showInformationMessage('Proxy is already running.');
        return;
      }
      try {
        await proxy!.start();
        updateStatusBar(stats.getSessionStats().totalSavedTokens, true);
        vscode.window.showInformationMessage(`Proxy started on port ${proxyConfig.port}.`);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Proxy failed: ${e.message}`);
      }
    }),

    vscode.commands.registerCommand('claudeOptimizer.stopProxy', async () => {
      await proxy?.stop();
      updateStatusBar(stats.getSessionStats().totalSavedTokens, false);
      vscode.window.showInformationMessage('Proxy stopped.');
    }),

    vscode.commands.registerCommand('claudeOptimizer.clearCache', () => {
      cache.clear();
      vscode.window.showInformationMessage('Cache cleared.');
    }),

    vscode.commands.registerCommand('claudeOptimizer.clearProxyState', () => {
      cache.clear();
      stats.clear();
      vscode.window.showInformationMessage('Proxy state cleared (cache + stats reset).');
    }),

    vscode.commands.registerCommand('claudeOptimizer.optimizeSelection', async () => {
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

      vscode.window.showInformationMessage(
        `Optimized: ${result.originalTokens} → ${result.optimizedTokens} tokens (${savedPct}% saved). Techniques: ${result.techniques.join(', ') || 'none'}`
      );
    })
  );

  // ── Config change listener ─────────────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('claudeOptimizer')) return;
      const c = vscode.workspace.getConfiguration('claudeOptimizer');
      proxy?.updateConfig({
        enableCache: c.get('enableCache'),
        enableCompression: c.get('enablePromptCompression'),
        enableModelRouter: c.get('enableModelRouter'),
      });
      cache.updateThreshold(c.get<number>('cacheThreshold', 0.92));
    })
  );

  // Cleanup
  context.subscriptions.push({
    dispose: async () => {
      await proxy?.stop();
      logMonitor.dispose();
      tokenCounter.dispose();
      stats.dispose();
    }
  });

  console.log('[Claude Optimizer] Active. Proxy:', proxy.isRunning() ? 'running' : 'stopped');
}

export function deactivate() {
  proxy?.stop();
}

// ── Helpers ────────────────────────────────────────────────────────────────

function updateStatusBar(savedTokens: number, proxyRunning: boolean, optimizerEnabled = true): void {
  const icon = !proxyRunning ? '$(circle-slash)' : optimizerEnabled ? '$(shield)' : '$(debug-pause)';
  const saved = savedTokens >= 1000 ? `${(savedTokens / 1000).toFixed(1)}k` : String(savedTokens);
  const state = !proxyRunning ? 'OFF' : optimizerEnabled ? `${saved} tokens saved` : 'PAUSED';
  statusBarItem.text = `${icon} Claude Optimizer: ${state}`;
  statusBarItem.backgroundColor = optimizerEnabled && proxyRunning
    ? undefined
    : new vscode.ThemeColor('statusBarItem.warningBackground');
}

function registerIntegrations(
  builder: ContextBuilder,
  config: vscode.WorkspaceConfiguration,
  workspaceRoot: string
): void {
  // Jira
  const jiraUrl = config.get<string>('jira.baseUrl', '');
  if (jiraUrl) {
    builder.registerIntegration('jira', new JiraIntegration({
      baseUrl: jiraUrl,
      email: config.get<string>('jira.email', ''),
      apiToken: config.get<string>('jira.apiToken', '') || process.env.JIRA_API_TOKEN || '',
      defaultProject: config.get<string>('jira.defaultProject'),
    }));
  }

  // Confluence
  const cfUrl = config.get<string>('confluence.baseUrl', '');
  if (cfUrl) {
    builder.registerIntegration('confluence', new ConfluenceIntegration({
      baseUrl: cfUrl,
      email: config.get<string>('confluence.email', ''),
      apiToken: config.get<string>('confluence.apiToken', '') || process.env.CONFLUENCE_API_TOKEN || '',
      defaultSpace: config.get<string>('confluence.defaultSpace'),
    }));
  }

  // CI/CD
  const ciProvider = config.get<string>('cicd.provider', '');
  if (ciProvider) {
    builder.registerIntegration('cicd', new CICDIntegration({
      provider: ciProvider as any,
      githubToken: process.env.GITHUB_TOKEN || config.get<string>('cicd.githubToken'),
      githubRepo: config.get<string>('cicd.githubRepo'),
      azureOrgUrl: config.get<string>('cicd.azureOrgUrl'),
      azureProject: config.get<string>('cicd.azureProject'),
      azurePat: process.env.AZURE_DEVOPS_PAT || config.get<string>('cicd.azurePat'),
      jenkinsUrl: config.get<string>('cicd.jenkinsUrl'),
      jenkinsUser: config.get<string>('cicd.jenkinsUser'),
      jenkinsToken: process.env.JENKINS_TOKEN || config.get<string>('cicd.jenkinsToken'),
      jenkinsJob: config.get<string>('cicd.jenkinsJob'),
    }));
  }

  // Azure
  const azureTenant = config.get<string>('azure.tenantId', '') || process.env.AZURE_TENANT_ID || '';
  if (azureTenant) {
    builder.registerIntegration('azure', new AzureIntegration({
      tenantId: azureTenant,
      clientId: config.get<string>('azure.clientId', '') || process.env.AZURE_CLIENT_ID || '',
      clientSecret: config.get<string>('azure.clientSecret', '') || process.env.AZURE_CLIENT_SECRET || '',
      subscriptionId: config.get<string>('azure.subscriptionId', '') || process.env.AZURE_SUBSCRIPTION_ID || '',
      defaultResourceGroup: config.get<string>('azure.defaultResourceGroup'),
    }));
  }

  // Databricks
  const dbHost = config.get<string>('databricks.host', '') || process.env.DATABRICKS_HOST || '';
  if (dbHost) {
    builder.registerIntegration('databricks', new DatabricksIntegration({
      host: dbHost,
      token: config.get<string>('databricks.token', '') || process.env.DATABRICKS_TOKEN || '',
      defaultClusterId: config.get<string>('databricks.defaultClusterId'),
    }));
  }

  // Terraform
  const tfPath = config.get<string>('terraform.workspacePath', workspaceRoot);
  builder.registerIntegration('terraform', new TerraformIntegration({ workspacePath: tfPath }));

  // Database
  const dbConnStr = config.get<string>('database.connectionString', '') || process.env.DATABASE_URL || '';
  if (dbConnStr) {
    builder.registerIntegration('database', new DatabaseIntegration({
      type: config.get<any>('database.type', 'postgres'),
      connectionString: dbConnStr,
      maxSampleRows: 3,
    }));
  }
}
