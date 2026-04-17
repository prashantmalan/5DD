/**
 * Dashboard HTTP Server
 * Serves a live dashboard on localhost:8788 — opens in any browser, no extra VS Code window.
 * Exposes:
 *   GET /        → dashboard HTML (auto-refreshes every 3s via polling + SSE live pulse)
 *   GET /flow    → animated pipeline flow page
 *   GET /stats   → current stats as JSON
 *   GET /traces  → recent per-request traces as JSON
 *   GET /events  → Server-Sent Events stream (real-time updates)
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
  private proxyPort: number;
  private stats: StatsTracker;
  private getTraces: () => object[];
  private sseClients: http.ServerResponse[] = [];

  constructor(stats: StatsTracker, port = 8788, getTraces?: () => object[], proxyPort = 8787) {
    this.stats = stats;
    this.port = port;
    this.proxyPort = proxyPort;
    this.getTraces = getTraces ?? (() => []);
  }

  /** Push a real-time event to all SSE listeners */
  pushEvent(type: string, payload?: object) {
    const msg = `data: ${JSON.stringify({ type, ...payload })}\n\n`;
    this.sseClients = this.sseClients.filter(client => {
      try { client.write(msg); return true; } catch { return false; }
    });
  }

  start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        const url = req.url?.split('?')[0];

        if (req.method === 'OPTIONS') {
          res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': '*' });
          res.end();
          return;
        }

        if ((url === '/proxy-clear' || url === '/proxy-restart-host') && req.method === 'POST') {
          this.relayToProxy('POST', url, res);
          return;
        }

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

        if (url === '/events' && req.method === 'GET') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
          });
          res.write('data: {"type":"connected"}\n\n');
          this.sseClients.push(res);
          req.on('close', () => {
            this.sseClients = this.sseClients.filter(c => c !== res);
          });
          return;
        }

        if (url === '/flow' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(this.flowHtml());
          return;
        }

        // Default: main Dashboard HTML
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(this.html());
      });

      this.server.on('error', reject);
      this.server.listen(this.port, '127.0.0.1', () => {
        resolve(`http://localhost:${this.port}`);
      });
    });
  }

  private relayToProxy(method: string, path: string, res: http.ServerResponse): void {
    const proxyReq = http.request({ hostname: '127.0.0.1', port: this.proxyPort, path, method }, proxyRes => {
      let data = '';
      proxyRes.on('data', (c: Buffer) => { data += c; });
      proxyRes.on('end', () => {
        res.writeHead(proxyRes.statusCode || 200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(data);
      });
    });
    proxyReq.on('error', () => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false }));
    });
    proxyReq.end();
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  private html(): string {
    const stats = JSON.stringify(this.stats.getSessionStats());
    const traces = JSON.stringify(this.getTraces());
    return this._html()
      .replace('__DASHBOARD_PORT__', String(this.port))
      .replace('"__INITIAL_STATS__"', stats)
      .replace('"__INITIAL_TRACES__"', traces);
  }
  private _html(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Claude Steward — Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f3f4f6; color: #111827; padding: 24px; min-height: 100vh; }
  h1 { font-size: 1.3em; font-weight: 600; margin-bottom: 4px; }
  .sub { font-size: 0.8em; color: #6b7280; margin-bottom: 16px; }
  nav { display: flex; gap: 10px; margin-bottom: 20px; }
  nav a { color: #2563eb; font-size: 0.85em; text-decoration: none; padding: 5px 12px; border: 1px solid #d1d5db; border-radius: 6px; background: #ffffff; }
  nav a:hover { background: #f9fafb; }
  nav a.active { border-color: #2563eb; }
  .privacy { background: #f0fdf4; border: 1px solid #bbf7d0; border-left: 3px solid #16a34a; border-radius: 6px; padding: 10px 14px; font-size: 0.78em; color: #15803d; margin-bottom: 8px; }
  .estimate-note { background: #fffbeb; border: 1px solid #fde68a; border-left: 3px solid #d97706; border-radius: 6px; padding: 8px 14px; font-size: 0.75em; color: #92400e; margin-bottom: 20px; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .card { background: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 14px; transition: border-color 0.3s; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
  .card.pulse { border-color: #16a34a; animation: cardpulse 0.8s ease-out; }
  @keyframes cardpulse { 0%{box-shadow:0 0 0 0 rgba(22,163,74,0.4)} 70%{box-shadow:0 0 0 8px rgba(22,163,74,0)} 100%{box-shadow:0 1px 3px rgba(0,0,0,0.06)} }
  .card .label { font-size: 0.72em; color: #6b7280; margin-bottom: 2px; text-transform: uppercase; letter-spacing: 0.05em; }
  .card .value { font-size: 1.4em; font-weight: 700; color: #16a34a; transition: transform 0.2s; }
  .card .value.bump { transform: scale(1.12); }
  .card .hint  { font-size: 0.72em; color: #6b7280; margin-top: 2px; }


  table { width: 100%; border-collapse: collapse; font-size: 0.82em; }
  th { text-align: left; padding: 8px 10px; background: #f9fafb; color: #6b7280; font-weight: 500; border-bottom: 1px solid #e5e7eb; cursor: help; }
  td { padding: 7px 10px; border-bottom: 1px solid #f3f4f6; color: #374151; }
  tr:hover td { background: #f9fafb; }
  tr.new-row { animation: rowpop 0.6s ease-out; }
  @keyframes rowpop { from{background:#dcfce7} to{background:transparent} }
  .badge { display: inline-block; padding: 2px 7px; border-radius: 10px; font-size: 0.72em; font-weight: 500; margin-right: 3px; }
  .g { background: #dcfce7; color: #16a34a; }
  .b { background: #dbeafe; color: #2563eb; }
  .r { background: #fee2e2; color: #dc2626; }
  .y { background: #fef9c3; color: #ca8a04; }
  .dim { background: #f3f4f6; color: #6b7280; }
  code { background: #f3f4f6; color: #374151; padding: 1px 5px; border-radius: 4px; font-size: 0.88em; border: 1px solid #e5e7eb; }
  .actions { margin-top: 20px; display: flex; gap: 8px; flex-wrap: wrap; }
  button { background: #ffffff; color: #374151; border: 1px solid #d1d5db; padding: 7px 16px; border-radius: 6px; cursor: pointer; font-size: 0.85em; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
  button:hover { background: #f9fafb; }
  button.danger { border-color: #dc2626; color: #dc2626; }
  button.dl { border-color: #2563eb; color: #2563eb; }
  .status { font-size: 0.75em; color: #6b7280; margin-top: 16px; }
  .tiers { display: flex; gap: 10px; margin-bottom: 24px; flex-wrap: wrap; }
  .tier { background: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 16px; flex: 1; min-width: 140px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
  .tier .tlabel { font-size: 0.72em; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }
  .tier .treqs { font-size: 1.4em; font-weight: 700; color: #111827; }
  .tier .tsaved { font-size: 0.82em; color: #16a34a; margin-top: 2px; }
  .th-tip { font-size: 0.7em; color: #2563eb; font-weight: normal; display: block; }
  @media (max-width: 700px) { .grid { grid-template-columns: 1fr 1fr; } }
</style>
</head>
<body>
<h1>Claude Steward</h1>
<div class="sub">5DD Plan — live token savings dashboard</div>


<div class="grid">
  <div class="card" id="card-saved">
    <div class="label">Tokens Saved</div>
    <div class="value" id="savedTokens">—</div>
    <div class="hint" id="savingsPct">—</div>
  </div>
  <div class="card" id="card-cost">
    <div class="label">Cost Saved</div>
    <div class="value" id="savedCost">—</div>
    <div class="hint" id="totalCost">—</div>
    <div class="hint" id="costBreakdown" style="margin-top:4px;font-size:0.75em;color:#6b7280"></div>
  </div>
  <div class="card" id="card-cache">
    <div class="label">Cache Hits</div>
    <div class="value" id="cacheHits">—</div>
    <div class="hint" id="totalReqs">—</div>
  </div>
  <div class="card" id="card-routes">
    <div class="label">Model Routes</div>
    <div class="value" id="downgrades">—</div>
    <div class="hint">Routed to cheaper model</div>
  </div>
</div>

<!-- Cost reasoning box -->
<div id="cost-reasoning" style="display:none;background:#ffffff;border:1px solid #e5e7eb;border-left:3px solid #3fb950;border-radius:6px;padding:12px 16px;margin-bottom:20px;font-size:0.82em;line-height:1.6">
  <strong style="font-size:0.9em;display:block;margin-bottom:8px;color:#111827">How your savings are calculated</strong>
  <div id="reasoning-text" style="color:#6b7280"></div>
</div>

<h2 style="font-size:0.95em;font-weight:600;margin-bottom:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em">Recent Requests</h2>
<table>
  <thead><tr>
    <th title="How long ago the request was made">Time</th>
    <th title="Final Claude model that processed the request (may differ from what was requested)">Model</th>
    <th title="Original prompt size before our compression vs actual tokens sent to Anthropic">Original → Sent <span class="th-tip">tokens</span></th>
    <th title="Output tokens returned by the API">Out <span class="th-tip">tokens</span></th>
    <th title="Tokens removed by our optimizer, and what % of the original that represents">Saved <span class="th-tip">tokens · %</span></th>
    <th title="Cost saved on this request: compression + routing savings">$ Saved</th>
    <th title="Badges: stream=streaming response, trimmed=context was compressed, →model=model was routed">Tags</th>
  </tr></thead>
  <tbody id="tbody"><tr><td colspan="7" style="color:#6b7280;padding:16px 10px">Waiting for requests…</td></tr></tbody>
</table>

<div class="actions">
  <button class="dl" onclick="downloadLogs()">Download logs (CSV)</button>
  <button onclick="clearStats()">Clear stats</button>
  <button class="danger" onclick="clearAll()">Clear all proxy state</button>
  <button onclick="routeAllWindows()" title="Restarts the VS Code extension host so all existing Claude Code chat windows route through the proxy">Route all windows ↺</button>
</div>

<div class="status" id="proxy-status-bar"><span id="proxy-dot" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#8b949e;margin-right:5px"></span><span id="proxy-status-text">Connecting to proxy…</span></div>

<div class="privacy" style="margin-top:16px">
  🔒 Privacy: only token counts, costs, and model names are tracked. No prompt content. Nothing leaves <code>localhost</code>.
</div>
<div class="estimate-note">
  ⚠️ <strong>Cost savings are estimates</strong> based on Anthropic's public pricing and the token delta between your original request and what was actually sent. Verify against your <a href="https://console.anthropic.com/settings/billing" style="color:#2563eb" target="_blank">Anthropic console</a>.
</div>

<script>
function fmt(n) { return n >= 1000 ? (n/1000).toFixed(1)+'k' : String(Math.round(n||0)); }
function fmtCost(n) { return '$' + (+n).toFixed(4); }
function ago(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  return Math.floor(s/3600) + 'h ago';
}
function ms(n) { return n >= 1000 ? (n/1000).toFixed(1)+'s' : n+'ms'; }

// ── SSE for real-time pulse ──────────────────────────────────────────────────
const PROXY_ORIGIN = 'http://localhost:__DASHBOARD_PORT__';
let prevReqs = 0;
function connectSSE() {
  const es = new EventSource(PROXY_ORIGIN + '/events');
  es.onopen = () => poll(); // fetch existing data as soon as SSE connects
  es.onmessage = e => {
    try {
      const d = JSON.parse(e.data);
      if (d.type === 'connected') {
        poll(); // initial load
      } else if (d.type === 'request') {
        ['card-saved','card-cost','card-cache','card-routes'].forEach(id => {
          const el = document.getElementById(id);
          el?.classList.remove('pulse');
          void el?.offsetWidth;
          el?.classList.add('pulse');
          setTimeout(() => el?.classList.remove('pulse'), 900);
        });
        poll(); // refresh numbers immediately
      }
    } catch {}
  };
  es.onerror = () => setTimeout(connectSSE, 3000);
}
connectSSE();
// Render server-side injected initial data immediately (no fetch needed)
try { renderStats("__INITIAL_STATS__"); } catch(e) {}
try { renderTraces("__INITIAL_TRACES__"); } catch(e) {}
setProxyStatus(true);

// ── stats render ─────────────────────────────────────────────────────────────
function renderStats(s) {
  document.getElementById('savedTokens').textContent = fmt(s.totalSavedTokens);
  document.getElementById('savingsPct').textContent = (s.avgSavingsPct||0).toFixed(1) + '% of original prompts removed';
  document.getElementById('savedCost').textContent = fmtCost(s.totalSavedCostUSD);
  document.getElementById('totalCost').textContent = 'Total spent: ' + fmtCost(s.totalCostUSD);

  // Cost breakdown hint on card
  const byCmp = s.totalSavedCostByCompression || 0;
  const byRte = s.totalSavedCostByRouting || 0;
  const parts = [];
  if (byCmp > 0) parts.push('✂️ ' + fmtCost(byCmp) + ' compression');
  if (byRte > 0) parts.push('🔀 ' + fmtCost(byRte) + ' routing');
  document.getElementById('costBreakdown').textContent = parts.join(' · ');

  // Plain-English reasoning box
  const box = document.getElementById('cost-reasoning');
  const txt = document.getElementById('reasoning-text');
  if (s.totalRequests > 0 && s.totalSavedCostUSD > 0) {
    box.style.display = 'block';
    const apiReqs = s.totalRequests - (s.cacheHits || 0);
    const avgOrig = apiReqs > 0 ? Math.round(s.totalOriginalTokens / apiReqs) : 0;
    const avgSent = apiReqs > 0 ? Math.round((s.totalOriginalTokens - s.totalSavedTokens) / apiReqs) : 0;
    const avgRemoved = avgOrig - avgSent;
    let html = '';
    if (byCmp > 0 && avgOrig > 0) {
      html += '<div style="margin-bottom:6px">✂️ <strong>Compression:</strong> Your prompts averaged <strong>' + fmt(avgOrig) + ' tokens</strong> before optimization. '
        + 'We trimmed them to ~<strong>' + fmt(avgSent) + ' tokens</strong> before sending — removing <strong>' + fmt(avgRemoved) + ' tokens</strong> per request. '
        + 'Those removed tokens × Anthropic\\'s input price = <strong>' + fmtCost(byCmp) + ' saved</strong> across ' + apiReqs + ' request' + (apiReqs !== 1 ? 's' : '') + '.</div>';
    }
    if (byRte > 0) {
      html += '<div style="margin-bottom:6px">🔀 <strong>Model routing:</strong> ' + (s.modelDowngrades||0) + ' request' + ((s.modelDowngrades||0) !== 1 ? 's were' : ' was')
        + ' sent to a cheaper model instead of the one requested. Cost difference = <strong>' + fmtCost(byRte) + ' saved</strong>.</div>';
    }
    if (s.cacheHits > 0) {
      html += '<div>⚡ <strong>Semantic cache:</strong> ' + s.cacheHits + ' request' + (s.cacheHits !== 1 ? 's were' : ' was')
        + ' answered instantly from cache — no API call made.</div>';
    }
    txt.innerHTML = html || 'No savings yet this session.';
  } else {
    box.style.display = s.totalRequests > 0 ? 'block' : 'none';
    txt.innerHTML = 'No savings recorded yet — savings appear after your first optimized request.';
  }
  document.getElementById('cacheHits').textContent = s.cacheHits;
  document.getElementById('totalReqs').textContent = 'of ' + s.totalRequests + ' requests';
  document.getElementById('downgrades').textContent = s.modelDowngrades;

}

let knownIds = new Set();
function renderTraces(traces) {
  const tbody = document.getElementById('tbody');
  if (!traces.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="color:#6b7280;padding:16px 10px">No requests yet — send a message in a <strong style="color:#111827">new</strong> Claude Code chat window to start seeing data.</td></tr>';
    knownIds = new Set();
    return;
  }
  const rows = traces.slice(0, 15);
  tbody.innerHTML = rows.map((r, i) => {
    const isNew = !knownIds.has(r.id || i);
    const techs = r.techniques || [];
    const tags = [];
    if (r.finalModel !== r.originalModel) tags.push('<span class="badge b">→' + (r.finalModel||'').replace('claude-','') + '</span>');
    if (r.cacheHit)                        tags.push('<span class="badge g">cache-hit</span>');
    if (techs.includes('pii-redact'))      tags.push('<span class="badge r">pii</span>');
    if (techs.includes('context-trim'))    tags.push('<span class="badge r">trimmed</span>');
    if (techs.includes('whitespace-compression') || techs.includes('tool-result-trim') || techs.includes('content-dedup'))
                                           tags.push('<span class="badge y">compressed</span>');
    if (r.streaming)                       tags.push('<span class="badge dim">stream</span>');

    const saved = r.savedByCompression || 0;
    const cacheR = r.cacheReadTokens || 0;
    const cacheC = r.cacheCreationTokens || 0;
    const fresh = r.inputTokens || 0;
    // originalTokens may come from newer traces; fall back to computing it
    const origTok = r.originalTokens || (fresh + cacheR + cacheC + saved);
    const sentTok = fresh + cacheR + cacheC;
    const savePct = origTok > 0 ? Math.round(saved / origTok * 100) : 0;

    // Cost breakdown tooltip
    const byCmp = r.savedCostByCompression || 0;
    const byRte = r.savedCostByRouting || 0;
    const costTip = [
      'Total saved: $' + (r.savedCostUSD||0).toFixed(4),
      byCmp > 0 ? '✂️ compression: $' + byCmp.toFixed(4) : '',
      byRte > 0 ? '🔀 routing: $' + byRte.toFixed(4) : '',
    ].filter(Boolean).join(' · ');

    return '<tr class="' + (isNew ? 'new-row' : '') + '">' +
      '<td style="color:#6b7280">' + ago(r.timestamp) + '</td>' +
      '<td><code>' + (r.finalModel||'').replace('claude-','') + '</code></td>' +
      '<td title="Original: ' + fmt(origTok) + ' tokens before compression → ' + fmt(sentTok) + ' tokens sent to Anthropic">' +
        (saved > 0
          ? '<span style="color:#6b7280">' + fmt(origTok) + '</span> → ' + fmt(sentTok)
          : fmt(sentTok)) +
        (cacheC > 0 ? ' <span style="color:#d97706;font-size:0.75em" title="Anthropic cache write: new content cached this turn">+' + fmt(cacheC) + '↑</span>' : '') +
        (cacheR > 0 ? ' <span style="color:#2563eb;font-size:0.75em" title="Anthropic cache read: previously cached content served at ~10% cost">+' + fmt(cacheR) + '↓</span>' : '') +
      '</td>' +
      '<td>' + fmt(r.outputTokens) + '</td>' +
      '<td style="color:' + (saved > 0 ? '#3fb950' : '#8b949e') + '" title="' + fmt(saved) + ' tokens removed (' + savePct + '% of original ' + fmt(origTok) + ')">' +
        (saved > 0 ? fmt(saved) + ' <span style="font-size:0.8em;color:#16a34a99">(' + savePct + '%)</span>' : '—') +
      '</td>' +
      '<td style="color:' + ((r.savedCostUSD||0) > 0 ? '#3fb950' : '#8b949e') + '" title="' + costTip + '">' +
        ((r.savedCostUSD||0) > 0 ? '$' + (r.savedCostUSD).toFixed(4) : '—') +
      '</td>' +
      '<td>' + (tags.join(' ') || '—') + '</td>' +
    '</tr>';
  }).join('');
  knownIds = new Set(rows.map((r,i) => r.id || i));
}

// Action calls (clear/restart) that must reach the proxy are relayed via the
// dashboard server itself — so all fetches are same-origin (no CORS).

function setProxyStatus(online) {
  const dot = document.getElementById('proxy-dot');
  const txt = document.getElementById('proxy-status-text');
  if (!dot || !txt) return;
  dot.style.background = online ? '#3fb950' : '#f85149';
  txt.textContent = online
    ? 'Proxy connected · auto-refreshing'
    : 'No data yet — open a new Claude Code chat window to start seeing requests';
}

async function poll() {
  try {
    const [sr, tr] = await Promise.all([
      fetch(PROXY_ORIGIN + '/stats'),
      fetch(PROXY_ORIGIN + '/traces'),
    ]);
    if (!sr.ok) throw new Error('stats ' + sr.status);
    renderStats(await sr.json());
    renderTraces(await tr.json());
    setProxyStatus(true);
  } catch(e) {
    setProxyStatus(false);
  }
}

async function downloadLogs() {
  const r = await fetch(PROXY_ORIGIN + '/traces');
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

async function clearStats() { await fetch(PROXY_ORIGIN + '/proxy-clear', { method:'POST' }); poll(); }
async function clearAll()   { await fetch(PROXY_ORIGIN + '/proxy-clear', { method:'POST' }); poll(); }
async function routeAllWindows() {
  if (!confirm('This restarts the VS Code extension host.\\nAll existing Claude Code chat windows will route through the proxy after restart.\\nIn-progress responses will be interrupted.\\n\\nContinue?')) return;
  const txt = document.getElementById('proxy-status-text');
  if (txt) txt.textContent = 'Restarting extension host…';
  await fetch(PROXY_ORIGIN + '/proxy-restart-host', { method:'POST' }).catch(() => {});
}

poll();
setInterval(poll, 5000);
</script>

<!-- ── How it works ──────────────────────────────────────────────────────── -->
<div id="how-it-works" style="margin-top:40px;padding-top:24px;border-top:1px solid #e5e7eb">
<h2 style="font-size:0.95em;font-weight:600;margin-bottom:16px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em">How it works</h2>

<div style="display:flex;flex-direction:column;gap:2px;max-width:720px;margin-bottom:28px">
  <div style="display:flex;gap:12px;align-items:flex-start;padding:10px 14px;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px 8px 0 0">
    <span style="font-size:1.1em;min-width:24px">🛡️</span>
    <div><strong style="font-size:0.85em">1 · PII Filter</strong><br><span style="font-size:0.78em;color:#6b7280">Scans the prompt for obvious personal data before it leaves VS Code.</span></div>
  </div>
  <div style="display:flex;gap:12px;align-items:flex-start;padding:10px 14px;background:#ffffff;border:1px solid #e5e7eb">
    <span style="font-size:1.1em;min-width:24px">⚡</span>
    <div><strong style="font-size:0.85em">2 · Semantic Cache</strong><br><span style="font-size:0.78em;color:#6b7280">Checks if a very similar question was already answered (cosine ≥ 0.92). If yes, returns the cached response instantly — no API call.</span> <span style="font-size:0.73em;color:#16a34a;font-weight:600">Up to 100% savings</span></div>
  </div>
  <div style="display:flex;gap:12px;align-items:flex-start;padding:10px 14px;background:#ffffff;border:1px solid #e5e7eb">
    <span style="font-size:1.1em;min-width:24px">✂️</span>
    <div><strong style="font-size:0.85em">3 · Prompt Optimizer</strong><br><span style="font-size:0.78em;color:#6b7280">Strips filler phrases, collapses whitespace, trims context overflow — without changing meaning.</span> <span style="font-size:0.73em;color:#16a34a;font-weight:600">5–20% token reduction</span></div>
  </div>
  <div style="display:flex;gap:12px;align-items:flex-start;padding:10px 14px;background:#ffffff;border:1px solid #e5e7eb">
    <span style="font-size:1.1em;min-width:24px">🔀</span>
    <div><strong style="font-size:0.85em">4 · Model Router</strong><br><span style="font-size:0.78em;color:#6b7280">Classifies request complexity with a fast Haiku call. Simple queries route to a cheaper tier; complex or code-heavy ones go to the model you requested.</span> <span style="font-size:0.73em;color:#2563eb;font-weight:600">Up to 10× cheaper</span></div>
  </div>
  <div style="display:flex;gap:12px;align-items:flex-start;padding:10px 14px;background:#ffffff;border:1px solid #e5e7eb">
    <span style="font-size:1.1em;min-width:24px">🤖</span>
    <div><strong style="font-size:0.85em">5 · Claude API</strong><br><span style="font-size:0.78em;color:#6b7280">The optimised request is forwarded to Anthropic. Streaming responses pass through token-by-token.</span></div>
  </div>
  <div style="display:flex;gap:12px;align-items:flex-start;padding:10px 14px;background:#ffffff;border:1px solid #e5e7eb;border-radius:0 0 8px 8px">
    <span style="font-size:1.1em;min-width:24px">📬</span>
    <div><strong style="font-size:0.85em">6 · Response → VS Code</strong><br><span style="font-size:0.78em;color:#6b7280">Response returned to Claude Code. Token counts, cost, model, and savings recorded; dashboard updates in real time via SSE.</span></div>
  </div>
</div>

<h2 style="font-size:0.95em;font-weight:600;margin-bottom:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em">Column guide</h2>
<div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:32px">
  <div style="display:grid;grid-template-columns:110px 1fr;gap:0">
    <div style="padding:8px 14px;font-size:0.8em;font-weight:600;border-bottom:1px solid #e5e7eb">Tokens Saved</div><div style="padding:8px 14px;font-size:0.78em;color:#6b7280;border-bottom:1px solid #e5e7eb">Cumulative tokens not sent to the API — from prompt compression and cache hits. % = fraction saved vs. what would have been sent without the extension.</div>
    <div style="padding:8px 14px;font-size:0.8em;font-weight:600;border-bottom:1px solid #e5e7eb">Cost Saved</div><div style="padding:8px 14px;font-size:0.78em;color:#6b7280;border-bottom:1px solid #e5e7eb">Dollar savings from our routing + compression. Does not include Anthropic's own prompt-cache discounts.</div>
    <div style="padding:8px 14px;font-size:0.8em;font-weight:600;border-bottom:1px solid #e5e7eb">Cache Hits</div><div style="padding:8px 14px;font-size:0.78em;color:#6b7280;border-bottom:1px solid #e5e7eb">Requests answered from our semantic cache — no API call made.</div>
    <div style="padding:8px 14px;font-size:0.8em;font-weight:600;border-bottom:1px solid #e5e7eb">Model Routes</div><div style="padding:8px 14px;font-size:0.78em;color:#6b7280;border-bottom:1px solid #e5e7eb">Requests redirected to a cheaper model tier by the router.</div>
    <div style="padding:8px 14px;font-size:0.8em;font-weight:600;border-bottom:1px solid #e5e7eb">Original → Sent</div><div style="padding:8px 14px;font-size:0.78em;color:#6b7280;border-bottom:1px solid #e5e7eb">Original = full prompt size before our optimizer ran. Sent = what actually went to Anthropic. ↑ = new content written to Anthropic's cache this turn. ↓ = content read from Anthropic's cache at ~10% cost.</div>
    <div style="padding:8px 14px;font-size:0.8em;font-weight:600;border-bottom:1px solid #e5e7eb">Saved (tokens · %)</div><div style="padding:8px 14px;font-size:0.78em;color:#6b7280;border-bottom:1px solid #e5e7eb">Tokens our optimizer removed, and what percentage of the original prompt that represents. Hover for details.</div>
    <div style="padding:8px 14px;font-size:0.8em;font-weight:600;border-bottom:1px solid #e5e7eb">$ Saved</div><div style="padding:8px 14px;font-size:0.78em;color:#6b7280;border-bottom:1px solid #e5e7eb">Estimated cost saved on this request from compression + routing. Hover to see the breakdown.</div>
    <div style="padding:8px 14px;font-size:0.8em;font-weight:600">Tags</div><div style="padding:8px 14px;font-size:0.78em;color:#6b7280"><code style="background:#21262d;padding:1px 4px;border-radius:3px">stream</code> streaming · <code style="background:#21262d;padding:1px 4px;border-radius:3px">trimmed</code> context compressed · <code style="background:#21262d;padding:1px 4px;border-radius:3px">→model</code> routed · <code style="background:#21262d;padding:1px 4px;border-radius:3px">cache</code> semantic cache hit</div>
  </div>
</div>
</div>
</body>
</html>`;
  }

  // ── /flow page — redirect to main dashboard ────────────────────────────────
  private flowHtml(): string {
    return `<!DOCTYPE html>
<html><head><meta http-equiv="refresh" content="0;url=/#how-it-works"></head>
<body><a href="/#how-it-works">Redirecting…</a></body></html>`;
  }
}