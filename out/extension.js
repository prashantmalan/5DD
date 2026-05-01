"use strict";
/**
 * Claude Steward — VS Code Extension Entry Point
 *
 * Spawns a detached proxy worker process (proxyWorker.js) that outlives
 * extension host restarts. The extension host manages env vars, status bar,
 * and workspaceState persistence; all proxy/dashboard logic lives in the worker.
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
const net = __importStar(require("net"));
const http = __importStar(require("http"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const child_process_2 = require("child_process");
const networkInterceptor_1 = require("./networkInterceptor");
const promptOptimizer_1 = require("./promptOptimizer");
const tokenCounter_1 = require("./tokenCounter");
const logMonitor_1 = require("./logMonitor");
const gitMonitor_1 = require("./gitMonitor");
const contextBuilder_1 = require("./contextBuilder");
// Integrations
const jiraIntegration_1 = require("./integrations/jiraIntegration");
const confluenceIntegration_1 = require("./integrations/confluenceIntegration");
const cicdIntegration_1 = require("./integrations/cicdIntegration");
const azureIntegration_1 = require("./integrations/azureIntegration");
const databricksIntegration_1 = require("./integrations/databricksIntegration");
const terraformIntegration_1 = require("./integrations/terraformIntegration");
const databaseIntegration_1 = require("./integrations/databaseIntegration");
// Broadcasts WM_SETTINGCHANGE so running apps pick up the env change immediately.
const WIN_CLEAR_BASE_URL = `powershell -NoProfile -Command "[System.Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL',$null,'User')"`;
const WIN_SET_BASE_URL = (v) => `powershell -NoProfile -Command "[System.Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL','${v}','User')"`;
let statusBarItem;
let statsPollingInterval = null;
let healthCheckInterval = null;
let interceptor = null;
let proxyEnabled = true;
let proxyPort = 8787;
let dashboardPort = 8788;
let dashboardUrl = '';
// ── HTTP helpers ──────────────────────────────────────────────────────────────
function proxyHttp(method, urlPath, body) {
    return new Promise((resolve) => {
        const data = body ? JSON.stringify(body) : '';
        const headers = {};
        if (data) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(data);
        }
        const req = http.request({ host: '127.0.0.1', port: proxyPort, path: urlPath, method, headers }, (res) => {
            let buf = '';
            res.on('data', (c) => buf += c);
            res.on('end', () => { try {
                resolve(JSON.parse(buf));
            }
            catch {
                resolve({});
            } });
        });
        req.on('error', () => resolve({}));
        if (data) {
            req.write(data);
        }
        req.end();
    });
}
function isProxyAlive(port) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 2000);
        socket.connect(port, '127.0.0.1', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
        socket.on('error', () => { clearTimeout(timer); resolve(false); });
    });
}
function waitForProxy(port, maxMs = 8000) {
    return new Promise((resolve) => {
        const deadline = Date.now() + maxMs;
        const poll = () => {
            isProxyAlive(port).then(alive => {
                if (alive) {
                    resolve(true);
                    return;
                }
                if (Date.now() > deadline) {
                    resolve(false);
                    return;
                }
                setTimeout(poll, 300);
            });
        };
        poll();
    });
}
// ── Worker spawning ───────────────────────────────────────────────────────────
function spawnWorker(cfg) {
    const configArg = Buffer.from(JSON.stringify(cfg)).toString('base64');
    const workerPath = path.join(__dirname, 'proxyWorker.js');
    const worker = (0, child_process_1.fork)(workerPath, [configArg], {
        detached: true,
        silent: true, // capture stdout/stderr via events, don't inherit
    });
    worker.stdout?.on('data', (d) => exports.out.appendLine(d.toString().trimEnd()));
    worker.stderr?.on('data', (d) => exports.out.appendLine(d.toString().trimEnd()));
    worker.once('message', (msg) => {
        if (msg?.type === 'ready') {
            exports.out.appendLine(`[WORKER] Ready on :${msg.port} PID=${worker.pid}`);
            worker.disconnect(); // close IPC — worker is now truly independent
            worker.unref(); // don't keep extension host alive for this child
        }
    });
    worker.on('exit', () => {
        try {
            worker.disconnect();
        }
        catch { }
    });
    worker.on('error', (err) => exports.out.appendLine(`[WORKER] Spawn error: ${err.message}`));
}
// ── Env-var routing ───────────────────────────────────────────────────────────
function activateRouting(proxyUrl, envColl) {
    process.env['ANTHROPIC_BASE_URL'] = proxyUrl;
    envColl.replace('ANTHROPIC_BASE_URL', proxyUrl);
    if (process.platform === 'win32') {
        (0, child_process_2.exec)(WIN_SET_BASE_URL(proxyUrl), () => { });
    }
    interceptor?.install();
}
function deactivateRouting(envColl) {
    delete process.env['ANTHROPIC_BASE_URL'];
    envColl.delete('ANTHROPIC_BASE_URL');
    if (process.platform === 'win32') {
        try {
            (0, child_process_2.execSync)(WIN_CLEAR_BASE_URL, { stdio: 'ignore' });
        }
        catch { }
    }
    interceptor?.uninstall();
}
function isGloballyEnabled() {
    if (process.platform !== 'win32') {
        return Promise.resolve(true);
    }
    return new Promise(resolve => (0, child_process_2.exec)('reg query HKCU\\Environment /v ANTHROPIC_BASE_URL', { windowsHide: true }, (err) => resolve(!err)));
}
// ── Status bar ────────────────────────────────────────────────────────────────
function updateStatusBar(savedTokens, running, enabled = true) {
    const icon = !running ? '$(circle-slash)' : enabled ? '$(shield)' : '$(debug-pause)';
    const saved = savedTokens >= 1000 ? `${(savedTokens / 1000).toFixed(1)}k` : String(savedTokens);
    const state = !running ? 'OFF' : enabled ? `${saved} tokens saved` : 'PAUSED';
    statusBarItem.text = `${icon} Claude Optimizer: ${state}`;
    statusBarItem.backgroundColor = enabled && running
        ? undefined
        : new vscode.ThemeColor('statusBarItem.warningBackground');
}
// ── Worker config builder ─────────────────────────────────────────────────────
function buildWorkerCfg(cfg) {
    return {
        proxy: {
            port: proxyPort,
            enabled: true,
            enableCache: cfg.get('enableCache', true),
            enableCompression: cfg.get('enablePromptCompression', true),
            enableModelRouter: cfg.get('enableModelRouter', true),
            enablePiiRedaction: cfg.get('enablePiiRedaction', true),
            apiKey: cfg.get('anthropicApiKey', '') || process.env.ANTHROPIC_API_KEY || '',
        },
        dashboardPort,
        cacheThreshold: cfg.get('cacheThreshold', 0.92),
        routerConfig: {
            enabled: cfg.get('enableModelRouter', true),
            apiKey: cfg.get('anthropicApiKey', '') || process.env.ANTHROPIC_API_KEY || '',
            minimumModel: cfg.get('minimumModel'),
            allowOpus: cfg.get('allowOpus', false),
            mode: cfg.get('modelRouterMode', 'balanced'),
        },
    };
}
// ── Main activation ───────────────────────────────────────────────────────────
async function activate(context) {
    exports.out = vscode.window.createOutputChannel('Claude Steward');
    context.subscriptions.push(exports.out);
    exports.out.appendLine('[Claude Steward] Activating...');
    const cfg = vscode.workspace.getConfiguration('claudeOptimizer');
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    proxyPort = cfg.get('proxyPort', 8787);
    dashboardPort = cfg.get('dashboardPort', 8788);
    dashboardUrl = `http://localhost:${dashboardPort}`;
    // ── Context modules (kept in extension host for log/git monitoring) ───────
    const logMonitor = new logMonitor_1.LogMonitor();
    const gitMonitor = new gitMonitor_1.GitMonitor(workspaceRoot);
    const contextBuilder = new contextBuilder_1.ContextBuilder(logMonitor, gitMonitor);
    registerIntegrations(contextBuilder, cfg, workspaceRoot);
    const logsDir = vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri || vscode.Uri.file(workspaceRoot), 'logs');
    logMonitor.watchDirectory(logsDir.fsPath, '*.log');
    // ── Status bar ────────────────────────────────────────────────────────────
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'claudeOptimizer.toggle';
    statusBarItem.tooltip = 'Click to toggle optimizer ON/OFF';
    updateStatusBar(0, false, true);
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    // ── Network interceptor ───────────────────────────────────────────────────
    interceptor = new networkInterceptor_1.NetworkInterceptor(proxyPort);
    // ── Windows SIGTERM/exit cleanup ──────────────────────────────────────────
    if (process.platform === 'win32') {
        process.on('SIGTERM', () => {
            try {
                (0, child_process_2.execSync)(WIN_CLEAR_BASE_URL, { stdio: 'ignore' });
            }
            catch { }
            process.exit(0);
        });
        process.on('exit', () => {
            try {
                (0, child_process_2.execSync)(WIN_CLEAR_BASE_URL, { stdio: 'ignore' });
            }
            catch { }
        });
    }
    // ── Build worker config ───────────────────────────────────────────────────
    const workerCfg = buildWorkerCfg(cfg);
    // ── Startup cleanup — clear stale registry value ──────────────────────────
    if (process.platform === 'win32') {
        (0, child_process_2.exec)(`powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable('ANTHROPIC_BASE_URL','User')"`, (_err, stdout) => {
            const existing = stdout.trim();
            const expected = `http://localhost:${proxyPort}`;
            if (existing && existing !== expected) {
                (0, child_process_2.exec)(WIN_CLEAR_BASE_URL, () => exports.out.appendLine(`[CLEANUP] Cleared stale ANTHROPIC_BASE_URL (was: ${existing})`));
            }
        });
    }
    // ── Env-var collection ────────────────────────────────────────────────────
    const proxyUrl = `http://localhost:${proxyPort}`;
    const envColl = context.environmentVariableCollection;
    envColl.description = new vscode.MarkdownString('Set by **Claude Steward** to route Claude Code traffic through the local optimising proxy.');
    // ── Attach or spawn worker ────────────────────────────────────────────────
    const wasAlive = await isProxyAlive(proxyPort);
    if (wasAlive) {
        exports.out.appendLine('[PROXY] Worker already running — attached');
        activateRouting(proxyUrl, envColl);
        updateStatusBar(0, true);
    }
    else {
        exports.out.appendLine('[PROXY] Spawning proxy worker...');
        statusBarItem.text = '$(loading~spin) Claude Optimizer: Starting...';
        spawnWorker(workerCfg);
        const started = await waitForProxy(proxyPort, 10000);
        if (started) {
            // Load persisted traces into the fresh worker
            const savedTraces = context.workspaceState.get('claudeOptimizer.traces', []);
            if (savedTraces.length > 0) {
                await proxyHttp('POST', '/proxy-load-traces', savedTraces);
                exports.out.appendLine(`[TRACE-RESTORE] loaded ${savedTraces.length} traces into worker`);
            }
            activateRouting(proxyUrl, envColl);
            updateStatusBar(0, true);
            exports.out.appendLine(`[PROXY UP] :${proxyPort} | dashboard: ${dashboardUrl}`);
            vscode.window.showInformationMessage(`Claude Steward active — proxy :${proxyPort}, dashboard ${dashboardUrl}`);
        }
        else {
            exports.out.appendLine('[PROXY ERROR] Worker did not start in time');
            updateStatusBar(0, false);
            vscode.window.showWarningMessage('Claude Steward: proxy worker failed to start.');
        }
    }
    // ── Poll proxy stats for status bar + workspaceState persistence ──────────
    function startStatsPolling() {
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
            }
            catch { }
        }, 5000);
    }
    startStatsPolling();
    // ── Health check — respawn worker if it dies unexpectedly ─────────────────
    function startHealthCheck() {
        healthCheckInterval = setInterval(async () => {
            if (await isProxyAlive(proxyPort)) {
                return;
            }
            if (!await isGloballyEnabled()) {
                exports.out.appendLine('[HEALTH] Proxy gone + registry cleared — staying disabled');
                clearInterval(healthCheckInterval);
                healthCheckInterval = null;
                return;
            }
            exports.out.appendLine('[HEALTH] Proxy died — respawning worker...');
            spawnWorker(buildWorkerCfg(vscode.workspace.getConfiguration('claudeOptimizer')));
            const ok = await waitForProxy(proxyPort, 10000);
            if (ok) {
                exports.out.appendLine('[HEALTH] Worker respawned');
                vscode.window.showInformationMessage('Claude Steward: proxy restarted automatically.');
            }
            else {
                exports.out.appendLine('[HEALTH] Respawn failed');
            }
        }, 15000);
    }
    startHealthCheck();
    // ── Commands ──────────────────────────────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('claudeOptimizer.showDashboard', () => {
        vscode.env.openExternal(vscode.Uri.parse(dashboardUrl));
    }), vscode.commands.registerCommand('claudeOptimizer.toggle', async () => {
        const result = await proxyHttp('POST', '/proxy-toggle');
        proxyEnabled = result?.enabled ?? !proxyEnabled;
        updateStatusBar(0, true, proxyEnabled);
        vscode.window.showInformationMessage(proxyEnabled
            ? 'Claude Optimizer: ON — optimizing requests'
            : 'Claude Optimizer: PAUSED — passing through unchanged');
    }), vscode.commands.registerCommand('claudeOptimizer.startProxy', async () => {
        if (await isProxyAlive(proxyPort)) {
            vscode.window.showInformationMessage('Proxy is already running.');
            return;
        }
        spawnWorker(buildWorkerCfg(vscode.workspace.getConfiguration('claudeOptimizer')));
        const ok = await waitForProxy(proxyPort, 10000);
        if (ok) {
            activateRouting(proxyUrl, envColl);
            updateStatusBar(0, true);
            vscode.window.showInformationMessage(`Proxy started on port ${proxyPort}.`);
        }
        else {
            vscode.window.showErrorMessage('Proxy failed to start.');
        }
    }), vscode.commands.registerCommand('claudeOptimizer.stopProxy', async () => {
        await proxyHttp('POST', '/proxy-shutdown');
        deactivateRouting(envColl);
        updateStatusBar(0, false);
        vscode.window.showInformationMessage('Proxy stopped.');
    }), vscode.commands.registerCommand('claudeOptimizer.clearCache', () => {
        proxyHttp('POST', '/proxy-clear');
        vscode.window.showInformationMessage('Cache cleared.');
    }), vscode.commands.registerCommand('claudeOptimizer.clearProxyState', () => {
        proxyHttp('POST', '/proxy-clear');
        context.workspaceState.update('claudeOptimizer.traces', []);
        vscode.window.showInformationMessage('Proxy state cleared.');
    }), vscode.commands.registerCommand('claudeOptimizer.emergencyCleanup', async () => {
        const pick = await vscode.window.showWarningMessage('Remove ANTHROPIC_BASE_URL from registry and stop the proxy. Run before uninstalling.', 'Run Cleanup', 'Cancel');
        if (pick !== 'Run Cleanup') {
            return;
        }
        deactivateRouting(envColl);
        await proxyHttp('POST', '/proxy-shutdown');
        vscode.window.showInformationMessage('Cleanup done. You can now uninstall safely.');
    }), vscode.commands.registerCommand('claudeOptimizer.optimizeSelection', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) {
            vscode.window.showWarningMessage('Select a prompt to optimize.');
            return;
        }
        const tc = new tokenCounter_1.TokenCounter();
        await tc.init();
        const optimizer = new promptOptimizer_1.PromptOptimizer(tc);
        const selected = editor.document.getText(editor.selection);
        const result = optimizer.optimize({
            model: 'claude-sonnet-4-6',
            messages: [{ role: 'user', content: selected }]
        });
        const savedPct = result.originalTokens > 0
            ? ((result.savedTokens / result.originalTokens) * 100).toFixed(1) : '0';
        vscode.window.showInformationMessage(`Optimized: ${result.originalTokens} → ${result.optimizedTokens} tokens (${savedPct}% saved). ` +
            `Techniques: ${result.techniques.join(', ') || 'none'}`);
    }));
    // ── Config change → forward to worker ────────────────────────────────────
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (!e.affectsConfiguration('claudeOptimizer')) {
            return;
        }
        const c = vscode.workspace.getConfiguration('claudeOptimizer');
        proxyHttp('POST', '/proxy-config', {
            enableCache: c.get('enableCache'),
            enableCompression: c.get('enablePromptCompression'),
            enableModelRouter: c.get('enableModelRouter'),
            modelRouterMode: c.get('modelRouterMode', 'balanced'),
        });
    }));
    // ── Dispose ───────────────────────────────────────────────────────────────
    // On extension host restart: clear timers but do NOT kill worker (it persists).
    // Worker is only killed via emergencyCleanup / stopProxy commands.
    context.subscriptions.push({
        dispose: () => {
            if (statsPollingInterval) {
                clearInterval(statsPollingInterval);
                statsPollingInterval = null;
            }
            if (healthCheckInterval) {
                clearInterval(healthCheckInterval);
                healthCheckInterval = null;
            }
            // env vars: keep ANTHROPIC_BASE_URL set — worker is still running.
            // Only clear on intentional disable (stopProxy / emergencyCleanup).
            logMonitor.dispose();
        }
    });
    exports.out.appendLine('[Claude Steward] Active.');
}
async function deactivate() {
    // Intentional VS Code shutdown — clear env var so new processes don't try dead proxy.
    // Worker process itself keeps running until killed by the OS or emergencyCleanup.
    if (process.platform === 'win32') {
        try {
            (0, child_process_2.execSync)(WIN_CLEAR_BASE_URL, { stdio: 'ignore' });
        }
        catch { }
    }
}
// ── Integration registration ──────────────────────────────────────────────────
function registerIntegrations(builder, config, workspaceRoot) {
    const jiraUrl = config.get('jira.baseUrl', '');
    if (jiraUrl) {
        builder.registerIntegration('jira', new jiraIntegration_1.JiraIntegration({
            baseUrl: jiraUrl,
            email: config.get('jira.email', ''),
            apiToken: config.get('jira.apiToken', '') || process.env.JIRA_API_TOKEN || '',
            defaultProject: config.get('jira.defaultProject'),
        }));
    }
    const cfUrl = config.get('confluence.baseUrl', '');
    if (cfUrl) {
        builder.registerIntegration('confluence', new confluenceIntegration_1.ConfluenceIntegration({
            baseUrl: cfUrl,
            email: config.get('confluence.email', ''),
            apiToken: config.get('confluence.apiToken', '') || process.env.CONFLUENCE_API_TOKEN || '',
            defaultSpace: config.get('confluence.defaultSpace'),
        }));
    }
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
    const dbHost = config.get('databricks.host', '') || process.env.DATABRICKS_HOST || '';
    if (dbHost) {
        builder.registerIntegration('databricks', new databricksIntegration_1.DatabricksIntegration({
            host: dbHost,
            token: config.get('databricks.token', '') || process.env.DATABRICKS_TOKEN || '',
            defaultClusterId: config.get('databricks.defaultClusterId'),
        }));
    }
    builder.registerIntegration('terraform', new terraformIntegration_1.TerraformIntegration({
        workspacePath: config.get('terraform.workspacePath', workspaceRoot),
    }));
    const dbConnStr = config.get('database.connectionString', '') || process.env.DATABASE_URL || '';
    if (dbConnStr) {
        builder.registerIntegration('database', new databaseIntegration_1.DatabaseIntegration({
            type: config.get('database.type', 'postgres'),
            connectionString: dbConnStr,
            maxSampleRows: 3,
        }));
    }
}
