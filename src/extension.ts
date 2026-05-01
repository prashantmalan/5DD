/**
 * Claude Steward — VS Code Extension Entry Point
 *
 * Spawns a detached proxy worker process (proxyWorker.js) that outlives
 * extension host restarts. The extension host manages env vars, status bar,
 * and workspaceState persistence; all proxy/dashboard logic lives in the worker.
 */

import * as vscode from 'vscode';
import * as net from 'net';
import * as http from 'http';
import * as path from 'path';
import { fork } from 'child_process';
import { exec, execSync } from 'child_process';
import { NetworkInterceptor } from './networkInterceptor';
import { PromptOptimizer } from './promptOptimizer';
import { TokenCounter } from './tokenCounter';
import { LogMonitor } from './logMonitor';
import { GitMonitor } from './gitMonitor';
import { ContextBuilder } from './contextBuilder';
import { WorkerConfig } from './proxyWorker';

// Integrations
import { JiraIntegration } from './integrations/jiraIntegration';
import { ConfluenceIntegration } from './integrations/confluenceIntegration';
import { CICDIntegration } from './integrations/cicdIntegration';
import { AzureIntegration } from './integrations/azureIntegration';
import { DatabricksIntegration } from './integrations/databricksIntegration';
import { TerraformIntegration } from './integrations/terraformIntegration';
import { DatabaseIntegration } from './integrations/databaseIntegration';

// Broadcasts WM_SETTINGCHANGE so running apps pick up the env change immediately.
const WIN_CLEAR_BASE_URL = `powershell -NoProfile -Command "[System.Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL',$null,'User')"`;
const WIN_SET_BASE_URL   = (v: string) => `powershell -NoProfile -Command "[System.Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL','${v}','User')"`;

let statusBarItem: vscode.StatusBarItem;
let statsPollingInterval: NodeJS.Timeout | null = null;
let healthCheckInterval:  NodeJS.Timeout | null = null;
let interceptor: NetworkInterceptor | null = null;
let proxyEnabled = true;
let proxyPort = 8787;
let dashboardPort = 8788;
let dashboardUrl = '';

export let out: vscode.OutputChannel;

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function proxyHttp(method: string, urlPath: string, body?: object): Promise<any> {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const headers: Record<string, string | number> = {};
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request(
      { host: '127.0.0.1', port: proxyPort, path: urlPath, method, headers },
      (res) => {
        let buf = '';
        res.on('data', (c: Buffer) => buf += c);
        res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve({}); } });
      }
    );
    req.on('error', () => resolve({}));
    if (data) { req.write(data); }
    req.end();
  });
}

function isProxyAlive(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 2000);
    socket.connect(port, '127.0.0.1', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

function waitForProxy(port: number, maxMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + maxMs;
    const poll = () => {
      isProxyAlive(port).then(alive => {
        if (alive) { resolve(true); return; }
        if (Date.now() > deadline) { resolve(false); return; }
        setTimeout(poll, 300);
      });
    };
    poll();
  });
}

// ── Worker spawning ───────────────────────────────────────────────────────────

function spawnWorker(cfg: WorkerConfig): void {
  const configArg = Buffer.from(JSON.stringify(cfg)).toString('base64');
  const workerPath = path.join(__dirname, 'proxyWorker.js');

  const worker = fork(workerPath, [configArg], {
    detached: true,
    silent: true,   // capture stdout/stderr via events, don't inherit
  });

  worker.stdout?.on('data', (d: Buffer) => out.appendLine(d.toString().trimEnd()));
  worker.stderr?.on('data', (d: Buffer) => out.appendLine(d.toString().trimEnd()));

  worker.once('message', (msg: any) => {
    if (msg?.type === 'ready') {
      out.appendLine(`[WORKER] Ready on :${msg.port} PID=${worker.pid}`);
      worker.disconnect();  // close IPC — worker is now truly independent
      worker.unref();       // don't keep extension host alive for this child
    }
  });

  worker.on('exit', () => {
    try { worker.disconnect(); } catch {}
  });

  worker.on('error', (err) => out.appendLine(`[WORKER] Spawn error: ${err.message}`));
}

// ── Env-var routing ───────────────────────────────────────────────────────────

function activateRouting(proxyUrl: string, envColl: vscode.EnvironmentVariableCollection): void {
  process.env['ANTHROPIC_BASE_URL'] = proxyUrl;
  envColl.replace('ANTHROPIC_BASE_URL', proxyUrl);
  if (process.platform === 'win32') {
    exec(WIN_SET_BASE_URL(proxyUrl), () => {});
  }
  interceptor?.install();
}

function deactivateRouting(envColl: vscode.EnvironmentVariableCollection): void {
  delete process.env['ANTHROPIC_BASE_URL'];
  envColl.delete('ANTHROPIC_BASE_URL');
  if (process.platform === 'win32') {
    try { execSync(WIN_CLEAR_BASE_URL, { stdio: 'ignore' }); } catch {}
  }
  interceptor?.uninstall();
}

function isGloballyEnabled(): Promise<boolean> {
  if (process.platform !== 'win32') { return Promise.resolve(true); }
  return new Promise(resolve =>
    exec('reg query HKCU\\Environment /v ANTHROPIC_BASE_URL', { windowsHide: true },
      (err) => resolve(!err))
  );
}

// ── Status bar ────────────────────────────────────────────────────────────────

function updateStatusBar(savedTokens: number, running: boolean, enabled = true): void {
  const icon  = !running ? '$(circle-slash)' : enabled ? '$(shield)' : '$(debug-pause)';
  const saved = savedTokens >= 1000 ? `${(savedTokens / 1000).toFixed(1)}k` : String(savedTokens);
  const state = !running ? 'OFF' : enabled ? `${saved} tokens saved` : 'PAUSED';
  statusBarItem.text = `${icon} Claude Optimizer: ${state}`;
  statusBarItem.backgroundColor = enabled && running
    ? undefined
    : new vscode.ThemeColor('statusBarItem.warningBackground');
}

// ── Worker config builder ─────────────────────────────────────────────────────

function buildWorkerCfg(cfg: vscode.WorkspaceConfiguration): WorkerConfig {
  return {
    proxy: {
      port:               proxyPort,
      enabled:            true,
      enableCache:        cfg.get<boolean>('enableCache', true),
      enableCompression:  cfg.get<boolean>('enablePromptCompression', true),
      enableModelRouter:  cfg.get<boolean>('enableModelRouter', true),
      enablePiiRedaction: cfg.get<boolean>('enablePiiRedaction', true),
      apiKey:             cfg.get<string>('anthropicApiKey', '') || process.env.ANTHROPIC_API_KEY || '',
    },
    dashboardPort,
    cacheThreshold: cfg.get<number>('cacheThreshold', 0.92),
    routerConfig: {
      enabled:      cfg.get<boolean>('enableModelRouter', true),
      apiKey:       cfg.get<string>('anthropicApiKey', '') || process.env.ANTHROPIC_API_KEY || '',
      minimumModel: cfg.get<string | undefined>('minimumModel'),
      allowOpus:    cfg.get<boolean>('allowOpus', false),
      mode:         cfg.get<'balanced' | 'aggressive' | 'conservative'>('modelRouterMode', 'balanced'),
    },
  };
}

// ── Main activation ───────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  out = vscode.window.createOutputChannel('Claude Steward');
  context.subscriptions.push(out);
  out.appendLine('[Claude Steward] Activating...');

  const cfg = vscode.workspace.getConfiguration('claudeOptimizer');
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

  proxyPort    = cfg.get<number>('proxyPort', 8787);
  dashboardPort = cfg.get<number>('dashboardPort', 8788);
  dashboardUrl  = `http://localhost:${dashboardPort}`;

  // ── Context modules (kept in extension host for log/git monitoring) ───────
  const logMonitor    = new LogMonitor();
  const gitMonitor    = new GitMonitor(workspaceRoot);
  const contextBuilder = new ContextBuilder(logMonitor, gitMonitor);
  registerIntegrations(contextBuilder, cfg, workspaceRoot);
  const logsDir = vscode.Uri.joinPath(
    vscode.workspace.workspaceFolders?.[0]?.uri || vscode.Uri.file(workspaceRoot), 'logs');
  logMonitor.watchDirectory(logsDir.fsPath, '*.log');

  // ── Status bar ────────────────────────────────────────────────────────────
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'claudeOptimizer.toggle';
  statusBarItem.tooltip  = 'Click to toggle optimizer ON/OFF';
  updateStatusBar(0, false, true);
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // ── Network interceptor ───────────────────────────────────────────────────
  interceptor = new NetworkInterceptor(proxyPort);

  // ── Windows SIGTERM/exit cleanup ──────────────────────────────────────────
  if (process.platform === 'win32') {
    process.on('SIGTERM', () => {
      try { execSync(WIN_CLEAR_BASE_URL, { stdio: 'ignore' }); } catch {}
      process.exit(0);
    });
    process.on('exit', () => {
      try { execSync(WIN_CLEAR_BASE_URL, { stdio: 'ignore' }); } catch {}
    });
  }

  // ── Build worker config ───────────────────────────────────────────────────
  const workerCfg = buildWorkerCfg(cfg);

  // ── Startup cleanup — clear stale registry value ──────────────────────────
  if (process.platform === 'win32') {
    exec(
      `powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable('ANTHROPIC_BASE_URL','User')"`,
      (_err, stdout) => {
        const existing = stdout.trim();
        const expected = `http://localhost:${proxyPort}`;
        if (existing && existing !== expected) {
          exec(WIN_CLEAR_BASE_URL, () =>
            out.appendLine(`[CLEANUP] Cleared stale ANTHROPIC_BASE_URL (was: ${existing})`));
        }
      }
    );
  }

  // ── Env-var collection ────────────────────────────────────────────────────
  const proxyUrl  = `http://localhost:${proxyPort}`;
  const envColl   = context.environmentVariableCollection;
  envColl.description = new vscode.MarkdownString(
    'Set by **Claude Steward** to route Claude Code traffic through the local optimising proxy.');

  // ── Attach or spawn worker ────────────────────────────────────────────────
  const wasAlive = await isProxyAlive(proxyPort);
  if (wasAlive) {
    out.appendLine('[PROXY] Worker already running — attached');
    activateRouting(proxyUrl, envColl);
    updateStatusBar(0, true);
  } else {
    out.appendLine('[PROXY] Spawning proxy worker...');
    statusBarItem.text = '$(loading~spin) Claude Optimizer: Starting...';
    spawnWorker(workerCfg);

    const started = await waitForProxy(proxyPort, 10_000);
    if (started) {
      // Load persisted traces into the fresh worker
      const savedTraces = context.workspaceState.get<object[]>('claudeOptimizer.traces', []);
      if (savedTraces.length > 0) {
        await proxyHttp('POST', '/proxy-load-traces', savedTraces);
        out.appendLine(`[TRACE-RESTORE] loaded ${savedTraces.length} traces into worker`);
      }
      activateRouting(proxyUrl, envColl);
      updateStatusBar(0, true);
      out.appendLine(`[PROXY UP] :${proxyPort} | dashboard: ${dashboardUrl}`);
      vscode.window.showInformationMessage(
        `Claude Steward active — proxy :${proxyPort}, dashboard ${dashboardUrl}`);
    } else {
      out.appendLine('[PROXY ERROR] Worker did not start in time');
      updateStatusBar(0, false);
      vscode.window.showWarningMessage('Claude Steward: proxy worker failed to start.');
    }
  }

  // ── Poll proxy stats for status bar + workspaceState persistence ──────────
  function startStatsPolling(): void {
    statsPollingInterval = setInterval(async () => {
      try {
        const s = await proxyHttp('GET', '/proxy-stats');
        if (s?.totalRequests !== undefined) {
          updateStatusBar(s.totalSavedTokens ?? 0, true, proxyEnabled);
        }
        const traces = await proxyHttp('GET', '/proxy-traces');
        if (Array.isArray(traces) && traces.length > 0) {
          context.workspaceState.update('claudeOptimizer.traces', traces);
        }
      } catch {}
    }, 5_000);
  }
  startStatsPolling();

  // ── Health check — respawn worker if it dies unexpectedly ─────────────────
  function startHealthCheck(): void {
    healthCheckInterval = setInterval(async () => {
      if (await isProxyAlive(proxyPort)) { return; }
      if (!await isGloballyEnabled()) {
        out.appendLine('[HEALTH] Proxy gone + registry cleared — staying disabled');
        clearInterval(healthCheckInterval!); healthCheckInterval = null;
        return;
      }
      out.appendLine('[HEALTH] Proxy died — respawning worker...');
      spawnWorker(buildWorkerCfg(vscode.workspace.getConfiguration('claudeOptimizer')));
      const ok = await waitForProxy(proxyPort, 10_000);
      if (ok) {
        out.appendLine('[HEALTH] Worker respawned');
        vscode.window.showInformationMessage('Claude Steward: proxy restarted automatically.');
      } else {
        out.appendLine('[HEALTH] Respawn failed');
      }
    }, 15_000);
  }
  startHealthCheck();

  // ── Commands ──────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeOptimizer.showDashboard', () => {
      vscode.env.openExternal(vscode.Uri.parse(dashboardUrl));
    }),

    vscode.commands.registerCommand('claudeOptimizer.toggle', async () => {
      const result = await proxyHttp('POST', '/proxy-toggle');
      proxyEnabled = result?.enabled ?? !proxyEnabled;
      updateStatusBar(0, true, proxyEnabled);
      vscode.window.showInformationMessage(
        proxyEnabled
          ? 'Claude Optimizer: ON — optimizing requests'
          : 'Claude Optimizer: PAUSED — passing through unchanged'
      );
    }),

    vscode.commands.registerCommand('claudeOptimizer.startProxy', async () => {
      if (await isProxyAlive(proxyPort)) {
        vscode.window.showInformationMessage('Proxy is already running.');
        return;
      }
      spawnWorker(buildWorkerCfg(vscode.workspace.getConfiguration('claudeOptimizer')));
      const ok = await waitForProxy(proxyPort, 10_000);
      if (ok) {
        activateRouting(proxyUrl, envColl);
        updateStatusBar(0, true);
        vscode.window.showInformationMessage(`Proxy started on port ${proxyPort}.`);
      } else {
        vscode.window.showErrorMessage('Proxy failed to start.');
      }
    }),

    vscode.commands.registerCommand('claudeOptimizer.stopProxy', async () => {
      await proxyHttp('POST', '/proxy-shutdown');
      deactivateRouting(envColl);
      updateStatusBar(0, false);
      vscode.window.showInformationMessage('Proxy stopped.');
    }),

    vscode.commands.registerCommand('claudeOptimizer.clearCache', () => {
      proxyHttp('POST', '/proxy-clear');
      vscode.window.showInformationMessage('Cache cleared.');
    }),

    vscode.commands.registerCommand('claudeOptimizer.clearProxyState', () => {
      proxyHttp('POST', '/proxy-clear');
      context.workspaceState.update('claudeOptimizer.traces', []);
      vscode.window.showInformationMessage('Proxy state cleared.');
    }),

    vscode.commands.registerCommand('claudeOptimizer.emergencyCleanup', async () => {
      const pick = await vscode.window.showWarningMessage(
        'Remove ANTHROPIC_BASE_URL from registry and stop the proxy. Run before uninstalling.',
        'Run Cleanup', 'Cancel'
      );
      if (pick !== 'Run Cleanup') { return; }
      deactivateRouting(envColl);
      await proxyHttp('POST', '/proxy-shutdown');
      vscode.window.showInformationMessage('Cleanup done. You can now uninstall safely.');
    }),

    vscode.commands.registerCommand('claudeOptimizer.optimizeSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showWarningMessage('Select a prompt to optimize.');
        return;
      }
      const tc = new TokenCounter();
      await tc.init();
      const optimizer = new PromptOptimizer(tc);
      const selected = editor.document.getText(editor.selection);
      const result = optimizer.optimize({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: selected }]
      });
      const savedPct = result.originalTokens > 0
        ? ((result.savedTokens / result.originalTokens) * 100).toFixed(1) : '0';
      vscode.window.showInformationMessage(
        `Optimized: ${result.originalTokens} → ${result.optimizedTokens} tokens (${savedPct}% saved). ` +
        `Techniques: ${result.techniques.join(', ') || 'none'}`
      );
    })
  );

  // ── Config change → forward to worker ────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('claudeOptimizer')) { return; }
      const c = vscode.workspace.getConfiguration('claudeOptimizer');
      proxyHttp('POST', '/proxy-config', {
        enableCache:       c.get('enableCache'),
        enableCompression: c.get('enablePromptCompression'),
        enableModelRouter: c.get('enableModelRouter'),
        modelRouterMode:   c.get('modelRouterMode', 'balanced'),
      });
    })
  );

  // ── Dispose ───────────────────────────────────────────────────────────────
  // On extension host restart: clear timers but do NOT kill worker (it persists).
  // Worker is only killed via emergencyCleanup / stopProxy commands.
  context.subscriptions.push({
    dispose: () => {
      if (statsPollingInterval)  { clearInterval(statsPollingInterval);  statsPollingInterval = null; }
      if (healthCheckInterval)   { clearInterval(healthCheckInterval);   healthCheckInterval  = null; }
      // env vars: keep ANTHROPIC_BASE_URL set — worker is still running.
      // Only clear on intentional disable (stopProxy / emergencyCleanup).
      logMonitor.dispose();
    }
  });

  out.appendLine('[Claude Steward] Active.');
}

export async function deactivate(): Promise<void> {
  // Intentional VS Code shutdown — clear env var so new processes don't try dead proxy.
  // Worker process itself keeps running until killed by the OS or emergencyCleanup.
  if (process.platform === 'win32') {
    try { execSync(WIN_CLEAR_BASE_URL, { stdio: 'ignore' }); } catch {}
  }
}

// ── Integration registration ──────────────────────────────────────────────────

function registerIntegrations(
  builder: ContextBuilder,
  config: vscode.WorkspaceConfiguration,
  workspaceRoot: string
): void {
  const jiraUrl = config.get<string>('jira.baseUrl', '');
  if (jiraUrl) {
    builder.registerIntegration('jira', new JiraIntegration({
      baseUrl: jiraUrl,
      email:      config.get<string>('jira.email', ''),
      apiToken:   config.get<string>('jira.apiToken', '') || process.env.JIRA_API_TOKEN || '',
      defaultProject: config.get<string>('jira.defaultProject'),
    }));
  }

  const cfUrl = config.get<string>('confluence.baseUrl', '');
  if (cfUrl) {
    builder.registerIntegration('confluence', new ConfluenceIntegration({
      baseUrl:  cfUrl,
      email:    config.get<string>('confluence.email', ''),
      apiToken: config.get<string>('confluence.apiToken', '') || process.env.CONFLUENCE_API_TOKEN || '',
      defaultSpace: config.get<string>('confluence.defaultSpace'),
    }));
  }

  const ciProvider = config.get<string>('cicd.provider', '');
  if (ciProvider) {
    builder.registerIntegration('cicd', new CICDIntegration({
      provider:    ciProvider as any,
      githubToken: process.env.GITHUB_TOKEN || config.get<string>('cicd.githubToken'),
      githubRepo:  config.get<string>('cicd.githubRepo'),
      azureOrgUrl: config.get<string>('cicd.azureOrgUrl'),
      azureProject: config.get<string>('cicd.azureProject'),
      azurePat:    process.env.AZURE_DEVOPS_PAT || config.get<string>('cicd.azurePat'),
      jenkinsUrl:  config.get<string>('cicd.jenkinsUrl'),
      jenkinsUser: config.get<string>('cicd.jenkinsUser'),
      jenkinsToken: process.env.JENKINS_TOKEN || config.get<string>('cicd.jenkinsToken'),
      jenkinsJob:  config.get<string>('cicd.jenkinsJob'),
    }));
  }

  const azureTenant = config.get<string>('azure.tenantId', '') || process.env.AZURE_TENANT_ID || '';
  if (azureTenant) {
    builder.registerIntegration('azure', new AzureIntegration({
      tenantId:          azureTenant,
      clientId:          config.get<string>('azure.clientId', '')          || process.env.AZURE_CLIENT_ID || '',
      clientSecret:      config.get<string>('azure.clientSecret', '')      || process.env.AZURE_CLIENT_SECRET || '',
      subscriptionId:    config.get<string>('azure.subscriptionId', '')    || process.env.AZURE_SUBSCRIPTION_ID || '',
      defaultResourceGroup: config.get<string>('azure.defaultResourceGroup'),
    }));
  }

  const dbHost = config.get<string>('databricks.host', '') || process.env.DATABRICKS_HOST || '';
  if (dbHost) {
    builder.registerIntegration('databricks', new DatabricksIntegration({
      host:             dbHost,
      token:            config.get<string>('databricks.token', '') || process.env.DATABRICKS_TOKEN || '',
      defaultClusterId: config.get<string>('databricks.defaultClusterId'),
    }));
  }

  builder.registerIntegration('terraform', new TerraformIntegration({
    workspacePath: config.get<string>('terraform.workspacePath', workspaceRoot),
  }));

  const dbConnStr = config.get<string>('database.connectionString', '') || process.env.DATABASE_URL || '';
  if (dbConnStr) {
    builder.registerIntegration('database', new DatabaseIntegration({
      type:             config.get<any>('database.type', 'postgres'),
      connectionString: dbConnStr,
      maxSampleRows:    3,
    }));
  }
}
