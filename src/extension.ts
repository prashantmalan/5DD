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
import * as net from 'net';
import { exec } from 'child_process';
import { TokenCounter } from './tokenCounter';
import { PromptOptimizer } from './promptOptimizer';
import { SemanticCache } from './semanticCache';
import { ModelRouter } from './modelRouter';
import { StatsTracker } from './statsTracker';
import { ProxyServer, ProxyConfig } from './proxyServer';
import { NetworkInterceptor } from './networkInterceptor';
import { LogMonitor } from './logMonitor';
import { GitMonitor } from './gitMonitor';
import { ContextBuilder } from './contextBuilder';
import { DashboardServer } from './dashboard/dashboardServer';

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
let healthCheckInterval: NodeJS.Timeout | null = null;
let isAttachedToExistingProxy = false;
let interceptor: NetworkInterceptor | null = null;

export let out: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext) {
  out = vscode.window.createOutputChannel('Claude Steward');
  context.subscriptions.push(out);
  out.appendLine('[Claude Steward] Activating...');

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
    updateStatusBar(s.totalSavedTokens, proxy?.isRunning() || isAttachedToExistingProxy);
  });

  // ── Proxy server ──────────────────────────────────────────────────────────
  const proxyConfig: ProxyConfig = {
    port: config.get<number>('proxyPort', 8787),
    enabled: true,
    enableCache: config.get<boolean>('enableCache', true),
    enableCompression: config.get<boolean>('enablePromptCompression', true),
    enableModelRouter: config.get<boolean>('enableModelRouter', true),
    enablePiiRedaction: config.get<boolean>('enablePiiRedaction', true),
    apiKey: config.get<string>('anthropicApiKey', '') || process.env.ANTHROPIC_API_KEY || '',
  };

  proxy = new ProxyServer(proxyConfig, cache, optimizer, router, tokenCounter, stats,
    (msg) => out.appendLine(`[${new Date().toISOString().slice(11,19)}] ${msg}`)
  );

  setStatusBarLoading();

  // ── Dashboard HTTP server ─────────────────────────────────────────────────
  const dashboardPort = config.get<number>('dashboardPort', 8788);
  const dashboardServer = new DashboardServer(stats, dashboardPort, () => proxy!.getTraces());
  proxy.setOnTrace(trace => dashboardServer.pushEvent('request', {
    cacheHit: trace.cacheHit,
    modelDowngraded: trace.originalModel !== trace.finalModel,
    savedCostUSD: trace.savedCostUSD,
  }));
  let lastPiiWarnAt = 0;
  proxy.setOnPiiDetected(types => {
    const now = Date.now();
    if (now - lastPiiWarnAt < 30_000) { return; } // throttle: once per 30 s
    lastPiiWarnAt = now;
    vscode.window.showWarningMessage(
      `Claude Steward detected and masked PII in your prompt (${types.join(', ')}). ` +
      'It was replaced with readable placeholders before being sent to Claude — your real data was not transmitted.',
    );
  });
  let dashboardUrl = `http://localhost:${dashboardPort}`;
  try {
    dashboardUrl = await dashboardServer.start();
    console.log(`[Claude Optimizer] Dashboard at ${dashboardUrl}`);
  } catch {
    console.warn('[Claude Optimizer] Dashboard server failed to start');
  }
  context.subscriptions.push({ dispose: () => dashboardServer.stop() });

  // ── Env-var helpers — use environmentVariableCollection so ALL terminals (existing + new)
  //    get ANTHROPIC_BASE_URL immediately, and VS Code clears it automatically on disable/uninstall.
  const proxyUrl = `http://localhost:${proxyConfig.port}`;
  const envColl = context.environmentVariableCollection;
  envColl.description = new vscode.MarkdownString('Set by **Claude Steward** to route Claude Code traffic through the local optimising proxy.');

  interceptor = new NetworkInterceptor(proxyConfig.port);

  function setUserEnvVar(value: string | null) {
    // Use setx to persist at Windows user level — same as set_env.bat but automatic.
    // setx writes to HKCU; no admin required. New processes pick it up immediately.
    if (process.platform === 'win32') {
      const cmd = value
        ? `setx ANTHROPIC_BASE_URL "${value}"`
        : `reg delete HKCU\\Environment /v ANTHROPIC_BASE_URL /f`;
      exec(cmd, (err) => {
        if (err) out.appendLine(`[ENV] setx failed: ${err.message}`);
        else out.appendLine(`[ENV] ANTHROPIC_BASE_URL ${value ? `set to ${value}` : 'cleared'} (user env)`);
      });
    }
  }

  function activateRouting() {
    process.env['ANTHROPIC_BASE_URL'] = proxyUrl;
    envColl.replace('ANTHROPIC_BASE_URL', proxyUrl);
    setUserEnvVar(proxyUrl);
    interceptor!.install();
  }
  function deactivateRouting() {
    delete process.env['ANTHROPIC_BASE_URL'];
    envColl.delete('ANTHROPIC_BASE_URL');
    setUserEnvVar(null);
    interceptor!.uninstall();
  }

  // Start health-check loop for the attached-window case (extracted to avoid duplication)
  function startHealthCheck() {
    healthCheckInterval = setInterval(async () => {
      if (await isProxyAlive(proxyConfig.port)) return;

      clearInterval(healthCheckInterval!);
      healthCheckInterval = null;
      isAttachedToExistingProxy = false;
      out.appendLine('[PROXY] Attached proxy died — attempting to take ownership');

      try {
        await proxy!.start();
        activateRouting();
        updateStatusBar(stats.getSessionStats().totalSavedTokens, true);
        out.appendLine('[PROXY] Took ownership — now the primary proxy');
        vscode.window.showInformationMessage('Claude Steward: Proxy restarted — this window is now the owner.');
      } catch {
        // Race: another window may have beaten us — give it a moment then check
        await new Promise(r => setTimeout(r, 500));
        if (await isProxyAlive(proxyConfig.port)) {
          isAttachedToExistingProxy = true;
          activateRouting();
          out.appendLine('[PROXY] Another window restarted the proxy — re-attached');
          startHealthCheck();
        } else {
          deactivateRouting();
          updateStatusBar(0, false);
          out.appendLine('[PROXY] Could not restart proxy — routing deactivated');
          vscode.window.showWarningMessage('Claude Steward: Proxy stopped and could not restart.');
        }
      }
    }, 10_000);
  }

  // Auto-start proxy. If port is already taken, another VS Code window owns it — attach to it.
  try {
    await proxy.start();
    activateRouting();
    out.appendLine(`[PROXY UP] Listening on ${proxyUrl} — all Claude Code traffic routes through us`);
    out.appendLine(`[DASHBOARD] ${dashboardUrl}`);
    updateStatusBar(0, true);
    vscode.window.showInformationMessage(`Claude Steward active — proxy on :${proxyConfig.port}, dashboard at ${dashboardUrl}`);
  } catch (err: any) {
    if ((err as any).message?.includes('already in use')) {
      isAttachedToExistingProxy = true;
      activateRouting();
      out.appendLine(`[PROXY] Port ${proxyConfig.port} already in use — attaching to existing proxy`);
      updateStatusBar(0, true);
      vscode.window.showInformationMessage(`Claude Steward: Attached to existing proxy on :${proxyConfig.port}`);
      startHealthCheck();
    } else {
      out.appendLine(`[PROXY ERROR] ${err.message}`);
      vscode.window.showWarningMessage(`Claude Steward: proxy failed to start — ${err.message}.`);
    }
  }

  // ── Commands ──────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeOptimizer.showDashboard', () => {
      vscode.env.openExternal(vscode.Uri.parse(dashboardUrl));
    }),

    vscode.commands.registerCommand('claudeOptimizer.toggle', () => {
      if (!proxy?.isRunning() && !isAttachedToExistingProxy) {
        vscode.window.showWarningMessage('Claude Optimizer: Proxy is not running. Press F5 first.');
        return;
      }
      if (isAttachedToExistingProxy && !proxy?.isRunning()) {
        vscode.window.showInformationMessage('Claude Optimizer: Routing active via proxy owned by another window.');
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
        activateRouting();
        updateStatusBar(stats.getSessionStats().totalSavedTokens, true);
        vscode.window.showInformationMessage(`Proxy started on port ${proxyConfig.port}.`);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Proxy failed: ${e.message}`);
      }
    }),

    vscode.commands.registerCommand('claudeOptimizer.stopProxy', async () => {
      await proxy?.stop();
      deactivateRouting();
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

  // Cleanup — VS Code calls dispose() synchronously (no await), so only sync work here.
  // Async proxy stop is handled in deactivate() which VS Code does await.
  context.subscriptions.push({
    dispose: () => {
      if (healthCheckInterval) { clearInterval(healthCheckInterval); healthCheckInterval = null; }
      deactivateRouting();          // envColl.delete clears env from all terminals immediately
      logMonitor.dispose();
      tokenCounter.dispose();
      stats.dispose();
    }
  });

  console.log('[Claude Optimizer] Active. Proxy:', proxy.isRunning() ? 'running' : 'stopped');
}

export async function deactivate(): Promise<void> {
  // healthCheckInterval and ANTHROPIC_BASE_URL are cleared by the subscription dispose above.
  // Only async work goes here — VS Code awaits the returned promise.
  await proxy?.stop();
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isProxyAlive(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 2000);
    socket.connect(port, '127.0.0.1', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

function updateStatusBar(savedTokens: number, proxyRunning: boolean, optimizerEnabled = true): void {
  const icon = !proxyRunning ? '$(circle-slash)' : optimizerEnabled ? '$(shield)' : '$(debug-pause)';
  const saved = savedTokens >= 1000 ? `${(savedTokens / 1000).toFixed(1)}k` : String(savedTokens);
  const state = !proxyRunning ? 'OFF' : optimizerEnabled ? `${saved} tokens saved` : 'PAUSED';
  statusBarItem.text = `${icon} Claude Optimizer: ${state}`;
  statusBarItem.backgroundColor = optimizerEnabled && proxyRunning
    ? undefined
    : new vscode.ThemeColor('statusBarItem.warningBackground');
}

function setStatusBarLoading(): void {
  statusBarItem.text = '$(loading~spin) Claude Optimizer: Starting...';
  statusBarItem.backgroundColor = undefined;
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
