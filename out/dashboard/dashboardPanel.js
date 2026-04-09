"use strict";
/**
 * Dashboard Webview Panel
 * Shows real-time token savings, cache hits, model routing stats.
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
exports.DashboardPanel = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
class DashboardPanel {
    static show(context, stats) {
        if (DashboardPanel.instance) {
            DashboardPanel.instance.panel.reveal();
            return DashboardPanel.instance;
        }
        return new DashboardPanel(context, stats);
    }
    constructor(_context, stats) {
        this.disposables = [];
        this.panel = vscode.window.createWebviewPanel('claudeOptimizer', 'Claude Token Optimizer', vscode.ViewColumn.Two, { enableScripts: true, retainContextWhenHidden: true });
        this.panel.webview.html = this.getHtml(stats.getSessionStats());
        // Update on new stats
        this.disposables.push(stats.onUpdate(s => {
            this.panel.webview.postMessage({ type: 'update', stats: s });
        }));
        // Handle messages from the webview
        this.disposables.push(this.panel.webview.onDidReceiveMessage(msg => {
            if (msg.type === 'clearStats')
                stats.clear();
            if (msg.type === 'clearProxyState')
                vscode.commands.executeCommand('claudeOptimizer.clearProxyState');
        }));
        this.panel.onDidDispose(() => {
            DashboardPanel.instance = undefined;
            this.disposables.forEach(d => d.dispose());
        });
        DashboardPanel.instance = this;
    }
    getHtml(initial) {
        const htmlPath = path.join(__dirname, 'dashboard.html');
        if (fs.existsSync(htmlPath)) {
            return fs.readFileSync(htmlPath, 'utf-8')
                .replace('__INITIAL_STATS__', JSON.stringify(initial));
        }
        return this.inlineHtml(initial);
    }
    // Fallback inline HTML if file not found
    inlineHtml(s) {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude Token Optimizer</title>
<style>
  body { font-family: var(--vscode-font-family); background: var(--vscode-editor-background); color: var(--vscode-foreground); padding: 16px; margin: 0; }
  h1 { font-size: 1.2em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 8px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 16px 0; }
  .card { background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 6px; padding: 12px; }
  .card .label { font-size: 0.75em; opacity: 0.7; margin-bottom: 4px; }
  .card .value { font-size: 1.6em; font-weight: bold; color: var(--vscode-charts-green); }
  .card .sub { font-size: 0.75em; opacity: 0.6; }
  table { width: 100%; border-collapse: collapse; font-size: 0.82em; }
  th { text-align: left; padding: 6px 8px; background: var(--vscode-editor-inactiveSelectionBackground); }
  td { padding: 5px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  .badge { display: inline-block; padding: 2px 6px; border-radius: 10px; font-size: 0.75em; }
  .badge-green { background: #2d5a2d; color: #7ec87e; }
  .badge-blue  { background: #1a3a5c; color: #7ab8f5; }
  .badge-red   { background: #5a2020; color: #f57a7a; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 14px; border-radius: 4px; cursor: pointer; margin-top: 16px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .proxy-hint { background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-charts-blue); padding: 8px 12px; border-radius: 3px; margin: 12px 0; font-size: 0.82em; }
  code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
</style>
</head>
<body>
<h1>Claude Token Optimizer</h1>

<div class="proxy-hint">
  Point your app at the proxy: <code>ANTHROPIC_BASE_URL=http://localhost:8787</code>
</div>

<div class="grid">
  <div class="card">
    <div class="label">Tokens Saved</div>
    <div class="value" id="savedTokens">0</div>
    <div class="sub" id="savingsPct">0% savings</div>
  </div>
  <div class="card">
    <div class="label">Cost Saved</div>
    <div class="value" id="savedCost">$0.00</div>
    <div class="sub" id="totalCost">Total cost: $0.00</div>
  </div>
  <div class="card">
    <div class="label">Cache Hits</div>
    <div class="value" id="cacheHits">0</div>
    <div class="sub" id="totalReqs">of 0 requests</div>
  </div>
  <div class="card">
    <div class="label">Model Downgrades</div>
    <div class="value" id="downgrades">0</div>
    <div class="sub">Routed to cheaper model</div>
  </div>
</div>

<h2 style="font-size:1em; margin-top:20px;">Recent Requests</h2>
<table>
  <thead>
    <tr><th>Time</th><th>Model</th><th>Input</th><th>Saved</th><th>Tags</th></tr>
  </thead>
  <tbody id="recentTable">
    <tr><td colspan="5" style="opacity:0.5">No requests yet. Start the proxy and send a request.</td></tr>
  </tbody>
</table>

<button onclick="clearStats()">Clear Stats</button>
<button onclick="clearProxyState()" style="margin-left:8px;background:var(--vscode-statusBarItem-warningBackground)">Clear Proxy State</button>

<script>
const vscode = acquireVsCodeApi();
let stats = ${JSON.stringify(s)};

function clearStats() { vscode.postMessage({ type: 'clearStats' }); }
function clearProxyState() { vscode.postMessage({ type: 'clearProxyState' }); }

function fmt(n) { return n >= 1000 ? (n/1000).toFixed(1)+'k' : String(n); }
function fmtCost(n) { return '$' + n.toFixed(4); }
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  return Math.floor(s/3600) + 'h ago';
}

function render(s) {
  document.getElementById('savedTokens').textContent = fmt(s.totalSavedTokens);
  document.getElementById('savingsPct').textContent = s.avgSavingsPct.toFixed(1) + '% savings';
  document.getElementById('savedCost').textContent = fmtCost(s.totalSavedCostUSD);
  document.getElementById('totalCost').textContent = 'Total cost: ' + fmtCost(s.totalCostUSD);
  document.getElementById('cacheHits').textContent = s.cacheHits;
  document.getElementById('totalReqs').textContent = 'of ' + s.totalRequests + ' requests';
  document.getElementById('downgrades').textContent = s.modelDowngrades;

  const tbody = document.getElementById('recentTable');
  const rows = (s.requests || []).slice(-10).reverse();
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="opacity:0.5">No requests yet.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const tags = [];
    if (r.cacheHit) tags.push('<span class="badge badge-green">cache</span>');
    if (r.modelDowngraded) tags.push('<span class="badge badge-blue">routed</span>');
    if (r.techniques && r.techniques.includes('context-trim')) tags.push('<span class="badge badge-red">trimmed</span>');
    const saved = r.savedTokensByCompression + r.savedTokensByCache;
    return '<tr>' +
      '<td>' + timeAgo(r.timestamp) + '</td>' +
      '<td><code>' + (r.model || '').replace('claude-','') + '</code></td>' +
      '<td>' + fmt(r.inputTokens) + '</td>' +
      '<td style="color:var(--vscode-charts-green)">' + (saved > 0 ? '+' + fmt(saved) : '—') + '</td>' +
      '<td>' + tags.join(' ') + '</td>' +
    '</tr>';
  }).join('');
}

window.addEventListener('message', e => {
  if (e.data.type === 'update') { stats = e.data.stats; render(stats); }
});

render(stats);
</script>
</body>
</html>`;
    }
}
exports.DashboardPanel = DashboardPanel;
