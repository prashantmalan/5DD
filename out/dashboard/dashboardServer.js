"use strict";
/**
 * Dashboard HTTP Server
 * Serves a live dashboard on localhost:8788 — opens in any browser, no extra VS Code window.
 * Exposes:
 *   GET /        → dashboard HTML (auto-refreshes every 3s via polling)
 *   GET /stats   → current stats as JSON
 *   GET /traces  → recent per-request traces as JSON
 *   POST /clear  → clear stats
 *
 * Privacy guarantee: only token counts, costs, model names, and timestamps are stored.
 * No prompt content, no response content, no user data ever leaves this server.
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
exports.DashboardServer = void 0;
const http = __importStar(require("http"));
class DashboardServer {
    constructor(stats, port = 8788, getTraces) {
        this.server = null;
        this.stats = stats;
        this.port = port;
        this.getTraces = getTraces ?? (() => []);
    }
    start() {
        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => {
                const url = req.url?.split('?')[0];
                if (url === '/stats' && req.method === 'GET') {
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify(this.stats.getSessionStats()));
                    return;
                }
                if (url === '/traces' && req.method === 'GET') {
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify(this.getTraces()));
                    return;
                }
                if (url === '/clear' && req.method === 'POST') {
                    this.stats.clear();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                    return;
                }
                // Dashboard HTML
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(this.html());
            });
            this.server.on('error', reject);
            this.server.listen(this.port, '127.0.0.1', () => {
                resolve(`http://localhost:${this.port}`);
            });
        });
    }
    stop() {
        this.server?.close();
        this.server = null;
    }
    isRunning() {
        return this.server !== null && this.server.listening;
    }
    html() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Claude Steward — Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #e6edf3; padding: 24px; min-height: 100vh; }
  h1 { font-size: 1.3em; font-weight: 600; margin-bottom: 4px; }
  .sub { font-size: 0.8em; color: #8b949e; margin-bottom: 24px; }
  .privacy { background: #161b22; border: 1px solid #21262d; border-left: 3px solid #3fb950; border-radius: 6px; padding: 10px 14px; font-size: 0.78em; color: #8b949e; margin-bottom: 20px; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .card { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 16px; }
  .card .label { font-size: 0.72em; color: #8b949e; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em; }
  .card .value { font-size: 2em; font-weight: 700; color: #3fb950; }
  .card .hint  { font-size: 0.72em; color: #8b949e; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.82em; }
  th { text-align: left; padding: 8px 10px; background: #161b22; color: #8b949e; font-weight: 500; border-bottom: 1px solid #21262d; }
  td { padding: 7px 10px; border-bottom: 1px solid #161b22; }
  tr:hover td { background: #161b22; }
  .badge { display: inline-block; padding: 2px 7px; border-radius: 10px; font-size: 0.72em; font-weight: 500; margin-right: 3px; }
  .g { background: #0d2b13; color: #3fb950; }
  .b { background: #0d1b2e; color: #58a6ff; }
  .r { background: #2b0d0d; color: #f85149; }
  code { background: #21262d; padding: 1px 5px; border-radius: 4px; font-size: 0.88em; }
  .actions { margin-top: 20px; display: flex; gap: 8px; }
  button { background: #21262d; color: #e6edf3; border: 1px solid #30363d; padding: 7px 16px; border-radius: 6px; cursor: pointer; font-size: 0.85em; }
  button:hover { background: #30363d; }
  button.danger { border-color: #f85149; color: #f85149; }
  .status { font-size: 0.75em; color: #8b949e; margin-top: 16px; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #3fb950; margin-right: 5px; }
  @media (max-width: 700px) { .grid { grid-template-columns: 1fr 1fr; } }
</style>
</head>
<body>
<h1>Claude Steward</h1>
<div class="sub">5DD Plan — live token savings dashboard</div>

<div class="privacy">
  🔒 Privacy: only token counts, costs, and model names are tracked here.
  No prompt content. No response content. Nothing leaves <code>localhost</code>.
</div>

<div class="grid">
  <div class="card"><div class="label">Tokens Saved</div><div class="value" id="savedTokens">—</div><div class="hint" id="savingsPct">—</div></div>
  <div class="card"><div class="label">Cost Saved</div><div class="value" id="savedCost">—</div><div class="hint" id="totalCost">—</div></div>
  <div class="card"><div class="label">Cache Hits</div><div class="value" id="cacheHits">—</div><div class="hint" id="totalReqs">—</div></div>
  <div class="card"><div class="label">Model Routes</div><div class="value" id="downgrades">—</div><div class="hint">Routed to cheaper model</div></div>
</div>

<h2 style="font-size:0.95em;font-weight:600;margin-bottom:10px;color:#8b949e;text-transform:uppercase;letter-spacing:0.05em">Recent Requests</h2>
<table>
  <thead><tr><th>Time</th><th>Model</th><th>In</th><th>Out</th><th>Cache Read</th><th>Cache Write</th><th>Saved</th><th>ms</th><th>Tags</th></tr></thead>
  <tbody id="tbody"><tr><td colspan="9" style="color:#8b949e;padding:16px 10px">Waiting for requests…</td></tr></tbody>
</table>

<div class="actions">
  <button onclick="clearStats()">Clear stats</button>
  <button class="danger" onclick="clearAll()">Clear all proxy state</button>
</div>

<div class="status"><span class="dot"></span>Auto-refreshing every 3s · Proxy on <code>localhost:8787</code></div>

<script>
function fmt(n) { return n >= 1000 ? (n/1000).toFixed(1)+'k' : String(Math.round(n)); }
function fmtCost(n) { return '$' + (+n).toFixed(4); }
function ago(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  return Math.floor(s/3600) + 'h ago';
}
function ms(n) { return n >= 1000 ? (n/1000).toFixed(1)+'s' : n+'ms'; }

function renderStats(s) {
  document.getElementById('savedTokens').textContent = fmt(s.totalSavedTokens);
  document.getElementById('savingsPct').textContent = s.avgSavingsPct.toFixed(1) + '% savings rate';
  document.getElementById('savedCost').textContent = fmtCost(s.totalSavedCostUSD);
  document.getElementById('totalCost').textContent = 'Total spent: ' + fmtCost(s.totalCostUSD);
  document.getElementById('cacheHits').textContent = s.cacheHits;
  document.getElementById('totalReqs').textContent = 'of ' + s.totalRequests + ' requests';
  document.getElementById('downgrades').textContent = s.modelDowngrades;
}

function renderTraces(traces) {
  const tbody = document.getElementById('tbody');
  if (!traces.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="color:#8b949e;padding:16px 10px">No requests yet.</td></tr>';
    return;
  }
  tbody.innerHTML = traces.slice(0, 20).map(r => {
    const tags = [];
    if (r.finalModel !== r.originalModel) tags.push('<span class="badge b">routed→' + (r.finalModel||'').replace('claude-','') + '</span>');
    if ((r.techniques||[]).includes('context-trim')) tags.push('<span class="badge r">trimmed</span>');
    if (r.streaming) tags.push('<span class="badge b">stream</span>');
    const saved = r.savedByCompression || 0;
    return '<tr>' +
      '<td style="color:#8b949e">' + ago(r.timestamp) + '</td>' +
      '<td><code>' + (r.originalModel||'').replace('claude-','') + '</code></td>' +
      '<td>' + fmt(r.inputTokens) + '</td>' +
      '<td>' + fmt(r.outputTokens) + '</td>' +
      '<td style="color:#58a6ff">' + (r.cacheReadTokens > 0 ? fmt(r.cacheReadTokens) : '—') + '</td>' +
      '<td style="color:#f0883e">' + (r.cacheCreationTokens > 0 ? fmt(r.cacheCreationTokens) : '—') + '</td>' +
      '<td style="color:#3fb950">' + (saved > 0 ? '+' + fmt(saved) : '—') + '</td>' +
      '<td style="color:#8b949e">' + ms(r.durationMs) + '</td>' +
      '<td>' + (tags.join('') || '—') + '</td>' +
    '</tr>';
  }).join('');
}

async function poll() {
  try {
    const [sr, tr] = await Promise.all([fetch('/stats'), fetch('/traces')]);
    renderStats(await sr.json());
    renderTraces(await tr.json());
  } catch {}
}

async function clearStats() {
  await fetch('/clear', { method: 'POST' });
  poll();
}

async function clearAll() {
  await fetch('/clear', { method: 'POST' });
  poll();
}

poll();
setInterval(poll, 3000);
</script>
</body>
</html>`;
    }
}
exports.DashboardServer = DashboardServer;
