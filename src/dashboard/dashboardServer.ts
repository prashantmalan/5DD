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

import * as http from 'http';
import { StatsTracker } from '../statsTracker';

export class DashboardServer {
  private server: http.Server | null = null;
  private port: number;
  private stats: StatsTracker;
  private getTraces: () => object[];

  constructor(stats: StatsTracker, port = 8788, getTraces?: () => object[]) {
    this.stats = stats;
    this.port = port;
    this.getTraces = getTraces ?? (() => []);
  }

  start(): Promise<string> {
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

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  private html(): string {
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
  .actions { margin-top: 20px; display: flex; gap: 8px; flex-wrap: wrap; }
  button { background: #21262d; color: #e6edf3; border: 1px solid #30363d; padding: 7px 16px; border-radius: 6px; cursor: pointer; font-size: 0.85em; }
  button:hover { background: #30363d; }
  button.danger { border-color: #f85149; color: #f85149; }
  button.dl { border-color: #58a6ff; color: #58a6ff; }
  .status { font-size: 0.75em; color: #8b949e; margin-top: 16px; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #3fb950; margin-right: 5px; }
  .tiers { display: flex; gap: 10px; margin-bottom: 24px; flex-wrap: wrap; }
  .tier { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 12px 16px; flex: 1; min-width: 140px; }
  .tier .tlabel { font-size: 0.72em; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }
  .tier .treqs { font-size: 1.4em; font-weight: 700; color: #e6edf3; }
  .tier .tsaved { font-size: 0.82em; color: #3fb950; margin-top: 2px; }
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

<h2 style="font-size:0.95em;font-weight:600;margin-bottom:10px;color:#8b949e;text-transform:uppercase;letter-spacing:0.05em">Savings by Tier</h2>
<div class="tiers">
  <div class="tier"><div class="tlabel">Haiku</div><div class="treqs" id="haiku_reqs">—</div><div class="tsaved" id="haiku_saved">—</div></div>
  <div class="tier"><div class="tlabel">Sonnet</div><div class="treqs" id="sonnet_reqs">—</div><div class="tsaved" id="sonnet_saved">—</div></div>
  <div class="tier"><div class="tlabel">Opus</div><div class="treqs" id="opus_reqs">—</div><div class="tsaved" id="opus_saved">—</div></div>
</div>

<h2 style="font-size:0.95em;font-weight:600;margin-bottom:10px;color:#8b949e;text-transform:uppercase;letter-spacing:0.05em">Recent Requests</h2>
<table>
  <thead><tr><th>Time</th><th>Model</th><th>In</th><th>Out</th><th>Reason</th><th>Cost</th><th>ms</th><th>Tags</th></tr></thead>
  <tbody id="tbody"><tr><td colspan="8" style="color:#8b949e;padding:16px 10px">Waiting for requests…</td></tr></tbody>
</table>

<div class="actions">
  <button onclick="downloadLogs()">Download logs (CSV)</button>
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

  // Per-tier breakdown
  const tiers = { haiku: {reqs: 0, saved: 0}, sonnet: {reqs: 0, saved: 0}, opus: {reqs: 0, saved: 0} };
  s.requests.forEach(r => {
    const m = (r.finalModel||'').toLowerCase();
    if (m.includes('haiku')) { tiers.haiku.reqs++; tiers.haiku.saved += r.savedCostUSD || 0; }
    else if (m.includes('sonnet')) { tiers.sonnet.reqs++; tiers.sonnet.saved += r.savedCostUSD || 0; }
    else if (m.includes('opus')) { tiers.opus.reqs++; tiers.opus.saved += r.savedCostUSD || 0; }
  });
  ['haiku', 'sonnet', 'opus'].forEach(t => {
    const el = document.getElementById(t + '_reqs');
    const el2 = document.getElementById(t + '_saved');
    if (el && el2) {
      el.textContent = tiers[t].reqs || '—';
      el2.textContent = tiers[t].reqs > 0 ? fmtCost(tiers[t].saved) + ' saved' : '—';
    }
  });
}

function renderTraces(traces) {
  const tbody = document.getElementById('tbody');
  if (!traces.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="color:#8b949e;padding:16px 10px">No requests yet.</td></tr>';
    return;
  }
  tbody.innerHTML = traces.slice(0, 20).map(r => {
    const tags = [];
    if (r.finalModel !== r.originalModel) tags.push('<span class="badge b">→' + (r.finalModel||'').replace('claude-','') + '</span>');
    if ((r.techniques||[]).includes('context-trim')) tags.push('<span class="badge r">trimmed</span>');
    if (r.streaming) tags.push('<span class="badge b">stream</span>');
    const savedCost = r.savedCostUSD > 0 ? fmtCost(r.savedCostUSD) : '—';
    const reason = r.routingReason && r.routingReason !== 'passthrough'
      ? '<span title="' + r.routingReason + '">' + r.routingReason.slice(0, 20) + '</span>'
      : '<span style="color:#8b949e">pass</span>';
    return '<tr>' +
      '<td style="color:#8b949e">' + ago(r.timestamp) + '</td>' +
      '<td><code>' + (r.finalModel||'').replace('claude-','') + '</code></td>' +
      '<td>' + fmt(r.inputTokens) + '</td>' +
      '<td>' + fmt(r.outputTokens) + '</td>' +
      '<td style="font-size:0.78em;color:#8b949e">' + reason + '</td>' +
      '<td style="color:#3fb950">' + savedCost + '</td>' +
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

async function downloadLogs() {
  const r = await fetch('/traces');
  const traces = await r.json();
  const cols = ['id','timestamp','originalModel','finalModel','routingReason','inputTokens','outputTokens',
    'cacheReadTokens','cacheCreationTokens','savedByCompression','savedCostUSD','durationMs','streaming','techniques','messagePreview'];
  const csv = [cols.join(','), ...traces.map(t =>
    cols.map(c => {
      const v = Array.isArray(t[c]) ? t[c].join('|') : (t[c] ?? '');
      return '"' + String(v).replace(/"/g, '""') + '"';
    }).join(',')
  )].join('\\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'claude-steward-traces-' + new Date().toISOString().slice(0,10) + '.csv';
  a.click();
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
