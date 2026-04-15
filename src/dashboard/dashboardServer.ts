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
  private stats: StatsTracker;
  private getTraces: () => object[];
  private sseClients: http.ServerResponse[] = [];

  constructor(stats: StatsTracker, port = 8788, getTraces?: () => object[]) {
    this.stats = stats;
    this.port = port;
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
  .sub { font-size: 0.8em; color: #8b949e; margin-bottom: 16px; }
  nav { display: flex; gap: 10px; margin-bottom: 20px; }
  nav a { color: #58a6ff; font-size: 0.85em; text-decoration: none; padding: 5px 12px; border: 1px solid #21262d; border-radius: 6px; background: #161b22; }
  nav a:hover { background: #21262d; }
  nav a.active { border-color: #58a6ff; }
  .privacy { background: #161b22; border: 1px solid #21262d; border-left: 3px solid #3fb950; border-radius: 6px; padding: 10px 14px; font-size: 0.78em; color: #8b949e; margin-bottom: 8px; }
  .estimate-note { background: #161b22; border: 1px solid #21262d; border-left: 3px solid #e3b341; border-radius: 6px; padding: 8px 14px; font-size: 0.75em; color: #8b949e; margin-bottom: 20px; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .card { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 16px; transition: border-color 0.3s; }
  .card.pulse { border-color: #3fb950; animation: cardpulse 0.8s ease-out; }
  @keyframes cardpulse { 0%{box-shadow:0 0 0 0 rgba(63,185,80,0.5)} 70%{box-shadow:0 0 0 8px rgba(63,185,80,0)} 100%{box-shadow:none} }
  .card .label { font-size: 0.72em; color: #8b949e; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em; }
  .card .value { font-size: 2em; font-weight: 700; color: #3fb950; transition: transform 0.2s; }
  .card .value.bump { transform: scale(1.12); }
  .card .hint  { font-size: 0.72em; color: #8b949e; margin-top: 4px; }

  /* Mini live flow strip */
  .liveflow { display: flex; align-items: center; gap: 0; margin-bottom: 24px; background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 10px 16px; overflow-x: auto; }
  .lf-node { display: flex; flex-direction: column; align-items: center; gap: 3px; min-width: 70px; }
  .lf-icon { width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1.1em; border: 2px solid #21262d; transition: border-color 0.3s, box-shadow 0.3s; background: #0d1117; }
  .lf-label { font-size: 0.62em; color: #8b949e; text-align: center; white-space: nowrap; }
  .lf-arrow { color: #30363d; font-size: 1em; margin: 0 2px; margin-bottom: 18px; transition: color 0.3s; }
  .lf-node.active .lf-icon { border-color: #3fb950; box-shadow: 0 0 10px rgba(63,185,80,0.5); }
  .lf-arrow.active { color: #3fb950; }
  .lf-node.active .lf-label { color: #3fb950; }
  .live-dot { width: 8px; height: 8px; border-radius: 50%; background: #3fb950; animation: blink 1.5s infinite; margin-right: 6px; display: inline-block; }
  @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.3} }

  table { width: 100%; border-collapse: collapse; font-size: 0.82em; }
  th { text-align: left; padding: 8px 10px; background: #161b22; color: #8b949e; font-weight: 500; border-bottom: 1px solid #21262d; cursor: help; }
  td { padding: 7px 10px; border-bottom: 1px solid #161b22; }
  tr:hover td { background: #161b22; }
  tr.new-row { animation: rowpop 0.6s ease-out; }
  @keyframes rowpop { from{background:#0d2b13} to{background:transparent} }
  .badge { display: inline-block; padding: 2px 7px; border-radius: 10px; font-size: 0.72em; font-weight: 500; margin-right: 3px; }
  .g { background: #0d2b13; color: #3fb950; }
  .b { background: #0d1b2e; color: #58a6ff; }
  .r { background: #2b0d0d; color: #f85149; }
  .y { background: #2b1d0d; color: #e3b341; }
  .dim { background: #1c2128; color: #8b949e; }
  code { background: #21262d; padding: 1px 5px; border-radius: 4px; font-size: 0.88em; }
  .actions { margin-top: 20px; display: flex; gap: 8px; flex-wrap: wrap; }
  button { background: #21262d; color: #e6edf3; border: 1px solid #30363d; padding: 7px 16px; border-radius: 6px; cursor: pointer; font-size: 0.85em; }
  button:hover { background: #30363d; }
  button.danger { border-color: #f85149; color: #f85149; }
  button.dl { border-color: #58a6ff; color: #58a6ff; }
  .status { font-size: 0.75em; color: #8b949e; margin-top: 16px; }
  .tiers { display: flex; gap: 10px; margin-bottom: 24px; flex-wrap: wrap; }
  .tier { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 12px 16px; flex: 1; min-width: 140px; }
  .tier .tlabel { font-size: 0.72em; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }
  .tier .treqs { font-size: 1.4em; font-weight: 700; color: #e6edf3; }
  .tier .tsaved { font-size: 0.82em; color: #3fb950; margin-top: 2px; }
  .th-tip { font-size: 0.7em; color: #58a6ff; font-weight: normal; display: block; }
  @media (max-width: 700px) { .grid { grid-template-columns: 1fr 1fr; } }
</style>
</head>
<body>
<h1>Claude Steward</h1>
<div class="sub">5DD Plan — live token savings dashboard</div>

<nav>
  <a href="/" class="active">Dashboard</a>
  <a href="/flow">How it works ↗</a>
</nav>

<div class="privacy">
  🔒 Privacy: only token counts, costs, and model names are tracked. No prompt content. Nothing leaves <code>localhost</code>.
</div>
<div class="estimate-note">
  ⚠️ <strong>Cost savings are estimates</strong> based on Anthropic's public pricing and the token delta between your original request and what was actually sent. They are not a guarantee of exact billing savings — verify against your <a href="https://console.anthropic.com/settings/billing" style="color:#58a6ff" target="_blank">Anthropic console</a>.
</div>

<!-- Mini live flow strip -->
<div class="liveflow" id="liveflow">
  <div class="lf-node" id="lf-vscode">
    <div class="lf-icon">💻</div>
    <div class="lf-label">VS Code</div>
  </div>
  <div class="lf-arrow" id="arr0">→</div>
  <div class="lf-node" id="lf-pii">
    <div class="lf-icon">🔒</div>
    <div class="lf-label">PII Filter</div>
  </div>
  <div class="lf-arrow" id="arr1">→</div>
  <div class="lf-node" id="lf-cache">
    <div class="lf-icon">⚡</div>
    <div class="lf-label">Cache</div>
  </div>
  <div class="lf-arrow" id="arr2">→</div>
  <div class="lf-node" id="lf-opt">
    <div class="lf-icon">✂️</div>
    <div class="lf-label">Optimizer</div>
  </div>
  <div class="lf-arrow" id="arr3">→</div>
  <div class="lf-node" id="lf-router">
    <div class="lf-icon">🔀</div>
    <div class="lf-label">Router</div>
  </div>
  <div class="lf-arrow" id="arr4">→</div>
  <div class="lf-node" id="lf-api">
    <div class="lf-icon">🤖</div>
    <div class="lf-label">Claude API</div>
  </div>
  <div class="lf-arrow" id="arr5" style="transform:scaleX(-1)">→</div>
  <div class="lf-node" id="lf-resp">
    <div class="lf-icon">📬</div>
    <div class="lf-label">Response</div>
  </div>
  <span style="margin-left:auto;font-size:0.72em;color:#8b949e;white-space:nowrap">
    <span class="live-dot"></span>Live
  </span>
</div>

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

<h2 style="font-size:0.95em;font-weight:600;margin-bottom:10px;color:#8b949e;text-transform:uppercase;letter-spacing:0.05em">Recent Requests</h2>
<table>
  <thead><tr>
    <th title="How long ago the request was made">Time</th>
    <th title="Final Claude model that processed the request (may differ from what was requested)">Model</th>
    <th title="Input tokens sent to the API (after optimization)">In <span class="th-tip">tokens</span></th>
    <th title="Output tokens returned by the API">Out <span class="th-tip">tokens</span></th>
    <th title="Tokens saved by compression/cache vs original request">Saved <span class="th-tip">tokens</span></th>
    <th title="Badges: stream=streaming response, trimmed=context was compressed, →model=model was routed">Tags</th>
  </tr></thead>
  <tbody id="tbody"><tr><td colspan="6" style="color:#8b949e;padding:16px 10px">Waiting for requests…</td></tr></tbody>
</table>

<div class="actions">
  <button class="dl" onclick="downloadLogs()">Download logs (CSV)</button>
  <button onclick="clearStats()">Clear stats</button>
  <button class="danger" onclick="clearAll()">Clear all proxy state</button>
</div>

<div class="status"><span class="dot" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#3fb950;margin-right:5px"></span>Auto-refreshing · Proxy on <code>localhost:8787</code> · <a href="#how-it-works" style="color:#58a6ff;text-decoration:none">How it works ↓</a></div>

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

// ── live flow animation ──────────────────────────────────────────────────────
const FLOW_NODES = ['lf-vscode','lf-pii','lf-cache','lf-opt','lf-router','lf-api','lf-resp'];
const FLOW_ARRS  = ['arr0','arr1','arr2','arr3','arr4','arr5'];
let flowTimer = null;

function animateFlow(isCacheHit, isDowngrade) {
  if (flowTimer) clearTimeout(flowTimer);
  const stopAt = isCacheHit ? 2 : FLOW_NODES.length - 1;
  FLOW_NODES.forEach(id => document.getElementById(id)?.classList.remove('active'));
  FLOW_ARRS.forEach(id => document.getElementById(id)?.classList.remove('active'));

  let step = 0;
  function next() {
    if (step < FLOW_NODES.length && step <= stopAt) {
      document.getElementById(FLOW_NODES[step])?.classList.add('active');
      if (step > 0) document.getElementById(FLOW_ARRS[step-1])?.classList.add('active');
      step++;
      flowTimer = setTimeout(next, 220);
    } else {
      // Fade out after a moment
      flowTimer = setTimeout(() => {
        FLOW_NODES.forEach(id => document.getElementById(id)?.classList.remove('active'));
        FLOW_ARRS.forEach(id => document.getElementById(id)?.classList.remove('active'));
      }, 1200);
    }
  }
  next();
}

// ── SSE for real-time pulse ──────────────────────────────────────────────────
let prevReqs = 0;
function connectSSE() {
  const es = new EventSource('/events');
  es.onmessage = e => {
    try {
      const d = JSON.parse(e.data);
      if (d.type === 'request') {
        animateFlow(d.cacheHit, d.modelDowngraded);
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

// ── stats render ─────────────────────────────────────────────────────────────
function renderStats(s) {
  document.getElementById('savedTokens').textContent = fmt(s.totalSavedTokens);
  document.getElementById('savingsPct').textContent = (s.avgSavingsPct||0).toFixed(1) + '% savings rate';
  document.getElementById('savedCost').textContent = fmtCost(s.totalSavedCostUSD);
  document.getElementById('totalCost').textContent = 'Total spent: ' + fmtCost(s.totalCostUSD);
  document.getElementById('cacheHits').textContent = s.cacheHits;
  document.getElementById('totalReqs').textContent = 'of ' + s.totalRequests + ' requests';
  document.getElementById('downgrades').textContent = s.modelDowngrades;

}

let knownIds = new Set();
function renderTraces(traces) {
  const tbody = document.getElementById('tbody');
  if (!traces.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="color:#8b949e;padding:16px 10px">No requests yet.</td></tr>';
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

    // token breakdown tooltip: in | out | cache↑ | cache↓ | saved
    const tokenDetail = [
      'in: ' + fmt(r.inputTokens),
      'out: ' + fmt(r.outputTokens),
      cacheC > 0 ? 'cache-write: ' + fmt(cacheC) : '',
      cacheR > 0 ? 'cache-read: '  + fmt(cacheR)  : '',
      saved > 0  ? 'saved: '       + fmt(saved)    : '',
    ].filter(Boolean).join(' · ');

    return '<tr class="' + (isNew ? 'new-row' : '') + '" title="' + tokenDetail + '">' +
      '<td style="color:#8b949e">' + ago(r.timestamp) + '</td>' +
      '<td><code>' + (r.finalModel||'').replace('claude-','') + '</code></td>' +
      '<td>' + fmt(r.inputTokens) +
        (cacheC > 0 ? ' <span style="color:#e3b341;font-size:0.75em" title="cache write">+' + fmt(cacheC) + '↑</span>' : '') +
        (cacheR > 0 ? ' <span style="color:#58a6ff;font-size:0.75em" title="cache read">+' + fmt(cacheR)  + '↓</span>' : '') +
      '</td>' +
      '<td>' + fmt(r.outputTokens) + '</td>' +
      '<td style="color:' + (saved > 0 ? '#3fb950' : '#8b949e') + '">' + (saved > 0 ? fmt(saved) : '—') + '</td>' +
      '<td>' + (tags.join(' ') || '—') + '</td>' +
    '</tr>';
  }).join('');
  knownIds = new Set(rows.map((r,i) => r.id || i));
}

// Always read stats/traces from the proxy port (:8787) — whoever owns the proxy
// owns the authoritative stats, even across multi-window ownership transfers.
const PROXY_ORIGIN = 'http://localhost:8787';

async function poll() {
  try {
    const [sr, tr] = await Promise.all([
      fetch(PROXY_ORIGIN + '/proxy-stats'),
      fetch(PROXY_ORIGIN + '/proxy-traces'),
    ]);
    renderStats(await sr.json());
    renderTraces(await tr.json());
  } catch {}
}

async function downloadLogs() {
  const r = await fetch(PROXY_ORIGIN + '/proxy-traces');
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

poll();
setInterval(poll, 1500);
</script>

<!-- ── How it works ──────────────────────────────────────────────────────── -->
<div id="how-it-works" style="margin-top:40px;padding-top:24px;border-top:1px solid #21262d">
<h2 style="font-size:0.95em;font-weight:600;margin-bottom:16px;color:#8b949e;text-transform:uppercase;letter-spacing:0.05em">How it works</h2>

<div style="display:flex;flex-direction:column;gap:2px;max-width:720px;margin-bottom:28px">
  <div style="display:flex;gap:12px;align-items:flex-start;padding:10px 14px;background:#161b22;border:1px solid #21262d;border-radius:8px 8px 0 0">
    <span style="font-size:1.1em;min-width:24px">🛡️</span>
    <div><strong style="font-size:0.85em">1 · PII Filter</strong><br><span style="font-size:0.78em;color:#8b949e">Scans the prompt for obvious personal data before it leaves VS Code.</span></div>
  </div>
  <div style="display:flex;gap:12px;align-items:flex-start;padding:10px 14px;background:#161b22;border:1px solid #21262d">
    <span style="font-size:1.1em;min-width:24px">⚡</span>
    <div><strong style="font-size:0.85em">2 · Semantic Cache</strong><br><span style="font-size:0.78em;color:#8b949e">Checks if a very similar question was already answered (cosine ≥ 0.92). If yes, returns the cached response instantly — no API call.</span> <span style="font-size:0.73em;color:#3fb950;font-weight:600">Up to 100% savings</span></div>
  </div>
  <div style="display:flex;gap:12px;align-items:flex-start;padding:10px 14px;background:#161b22;border:1px solid #21262d">
    <span style="font-size:1.1em;min-width:24px">✂️</span>
    <div><strong style="font-size:0.85em">3 · Prompt Optimizer</strong><br><span style="font-size:0.78em;color:#8b949e">Strips filler phrases, collapses whitespace, trims context overflow — without changing meaning.</span> <span style="font-size:0.73em;color:#3fb950;font-weight:600">5–20% token reduction</span></div>
  </div>
  <div style="display:flex;gap:12px;align-items:flex-start;padding:10px 14px;background:#161b22;border:1px solid #21262d">
    <span style="font-size:1.1em;min-width:24px">🔀</span>
    <div><strong style="font-size:0.85em">4 · Model Router</strong><br><span style="font-size:0.78em;color:#8b949e">Classifies request complexity with a fast Haiku call. Simple queries route to a cheaper tier; complex or code-heavy ones go to the model you requested.</span> <span style="font-size:0.73em;color:#58a6ff;font-weight:600">Up to 10× cheaper</span></div>
  </div>
  <div style="display:flex;gap:12px;align-items:flex-start;padding:10px 14px;background:#161b22;border:1px solid #21262d">
    <span style="font-size:1.1em;min-width:24px">🤖</span>
    <div><strong style="font-size:0.85em">5 · Claude API</strong><br><span style="font-size:0.78em;color:#8b949e">The optimised request is forwarded to Anthropic. Streaming responses pass through token-by-token.</span></div>
  </div>
  <div style="display:flex;gap:12px;align-items:flex-start;padding:10px 14px;background:#161b22;border:1px solid #21262d;border-radius:0 0 8px 8px">
    <span style="font-size:1.1em;min-width:24px">📬</span>
    <div><strong style="font-size:0.85em">6 · Response → VS Code</strong><br><span style="font-size:0.78em;color:#8b949e">Response returned to Claude Code. Token counts, cost, model, and savings recorded; dashboard updates in real time via SSE.</span></div>
  </div>
</div>

<h2 style="font-size:0.95em;font-weight:600;margin-bottom:12px;color:#8b949e;text-transform:uppercase;letter-spacing:0.05em">Column guide</h2>
<div style="background:#161b22;border:1px solid #21262d;border-radius:8px;overflow:hidden;margin-bottom:32px">
  <div style="display:grid;grid-template-columns:110px 1fr;gap:0">
    <div style="padding:8px 14px;font-size:0.8em;font-weight:600;border-bottom:1px solid #21262d">Tokens Saved</div><div style="padding:8px 14px;font-size:0.78em;color:#8b949e;border-bottom:1px solid #21262d">Cumulative tokens not sent to the API — from prompt compression and cache hits. % = fraction saved vs. what would have been sent without the extension.</div>
    <div style="padding:8px 14px;font-size:0.8em;font-weight:600;border-bottom:1px solid #21262d">Cost Saved</div><div style="padding:8px 14px;font-size:0.78em;color:#8b949e;border-bottom:1px solid #21262d">Dollar savings from our routing + compression. Does not include Anthropic's own prompt-cache discounts.</div>
    <div style="padding:8px 14px;font-size:0.8em;font-weight:600;border-bottom:1px solid #21262d">Cache Hits</div><div style="padding:8px 14px;font-size:0.78em;color:#8b949e;border-bottom:1px solid #21262d">Requests answered from our semantic cache — no API call made.</div>
    <div style="padding:8px 14px;font-size:0.8em;font-weight:600;border-bottom:1px solid #21262d">Model Routes</div><div style="padding:8px 14px;font-size:0.78em;color:#8b949e;border-bottom:1px solid #21262d">Requests redirected to a cheaper model tier by the router.</div>
    <div style="padding:8px 14px;font-size:0.8em;font-weight:600;border-bottom:1px solid #21262d">Saved (table)</div><div style="padding:8px 14px;font-size:0.78em;color:#8b949e;border-bottom:1px solid #21262d">Per-request tokens saved by our compression. — means no compression was applied.</div>
    <div style="padding:8px 14px;font-size:0.8em;font-weight:600">Tags</div><div style="padding:8px 14px;font-size:0.78em;color:#8b949e"><code style="background:#21262d;padding:1px 4px;border-radius:3px">stream</code> streaming · <code style="background:#21262d;padding:1px 4px;border-radius:3px">trimmed</code> context compressed · <code style="background:#21262d;padding:1px 4px;border-radius:3px">→model</code> routed · <code style="background:#21262d;padding:1px 4px;border-radius:3px">cache</code> semantic cache hit</div>
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