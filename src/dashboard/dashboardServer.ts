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

<h2 style="font-size:0.95em;font-weight:600;margin-bottom:10px;color:#8b949e;text-transform:uppercase;letter-spacing:0.05em">Savings by Tier</h2>
<div class="tiers">
  <div class="tier"><div class="tlabel">Haiku</div><div class="treqs" id="haiku_reqs">—</div><div class="tsaved" id="haiku_saved">—</div></div>
  <div class="tier"><div class="tlabel">Sonnet</div><div class="treqs" id="sonnet_reqs">—</div><div class="tsaved" id="sonnet_saved">—</div></div>
  <div class="tier"><div class="tlabel">Opus</div><div class="treqs" id="opus_reqs">—</div><div class="tsaved" id="opus_saved">—</div></div>
</div>

<h2 style="font-size:0.95em;font-weight:600;margin-bottom:10px;color:#8b949e;text-transform:uppercase;letter-spacing:0.05em">Recent Requests</h2>
<table>
  <thead><tr>
    <th title="How long ago the request was made">Time</th>
    <th title="Final Claude model that processed the request (may differ from what was requested)">Model</th>
    <th title="Input tokens sent to the API (after optimization)">In <span class="th-tip">tokens</span></th>
    <th title="Output tokens returned by the API">Out <span class="th-tip">tokens</span></th>
    <th title="Why this model was chosen: pre-classify, classifier-cache, semantic-cache, passthrough">Reason</th>
    <th title="Dollar amount saved vs. sending the original request to the original model">Saved</th>
    <th title="Total round-trip time from proxy receiving the request to returning the response">ms</th>
    <th title="Badges: stream=streaming response, trimmed=context was compressed, →model=model was routed">Tags</th>
  </tr></thead>
  <tbody id="tbody"><tr><td colspan="8" style="color:#8b949e;padding:16px 10px">Waiting for requests…</td></tr></tbody>
</table>

<div class="actions">
  <button class="dl" onclick="downloadLogs()">Download logs (CSV)</button>
  <button onclick="clearStats()">Clear stats</button>
  <button class="danger" onclick="clearAll()">Clear all proxy state</button>
</div>

<div class="status"><span class="dot" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#3fb950;margin-right:5px"></span>Auto-refreshing · Proxy on <code>localhost:8787</code> · <a href="/flow" style="color:#58a6ff;text-decoration:none">How it works →</a></div>

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

  const tiers = { haiku: {reqs:0,saved:0}, sonnet: {reqs:0,saved:0}, opus: {reqs:0,saved:0} };
  (s.requests||[]).forEach(r => {
    const m = (r.finalModel||'').toLowerCase();
    if (m.includes('haiku')) { tiers.haiku.reqs++; tiers.haiku.saved += r.savedCostUSD||0; }
    else if (m.includes('sonnet')) { tiers.sonnet.reqs++; tiers.sonnet.saved += r.savedCostUSD||0; }
    else if (m.includes('opus')) { tiers.opus.reqs++; tiers.opus.saved += r.savedCostUSD||0; }
  });
  ['haiku','sonnet','opus'].forEach(t => {
    const el = document.getElementById(t + '_reqs');
    const el2 = document.getElementById(t + '_saved');
    if (el && el2) {
      el.textContent = tiers[t].reqs || '—';
      el2.textContent = tiers[t].reqs > 0 ? fmtCost(tiers[t].saved) + ' saved' : '—';
    }
  });
}

let knownIds = new Set();
function renderTraces(traces) {
  const tbody = document.getElementById('tbody');
  if (!traces.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="color:#8b949e;padding:16px 10px">No requests yet.</td></tr>';
    knownIds = new Set();
    return;
  }
  const rows = traces.slice(0, 20);
  tbody.innerHTML = rows.map((r, i) => {
    const isNew = !knownIds.has(r.id || i);
    const tags = [];
    if (r.finalModel !== r.originalModel) tags.push('<span class="badge b">→' + (r.finalModel||'').replace('claude-','') + '</span>');
    if ((r.techniques||[]).includes('context-trim')) tags.push('<span class="badge r">trimmed</span>');
    if (r.streaming) tags.push('<span class="badge b">stream</span>');
    if (r.cacheHit) tags.push('<span class="badge g">cache</span>');
    const savedCost = r.savedCostUSD > 0 ? fmtCost(r.savedCostUSD) : '—';
    const reason = r.routingReason && r.routingReason !== 'passthrough'
      ? '<span title="' + r.routingReason + '">' + r.routingReason.slice(0, 20) + '</span>'
      : '<span style="color:#8b949e">pass</span>';
    return '<tr class="' + (isNew ? 'new-row' : '') + '">' +
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
  knownIds = new Set(rows.map((r,i) => r.id || i));
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

async function clearStats() { await fetch('/clear', { method:'POST' }); poll(); }
async function clearAll()   { await fetch('/clear', { method:'POST' }); poll(); }

poll();
setInterval(poll, 4000);
</script>
</body>
</html>`;
  }

  // ── /flow page ─────────────────────────────────────────────────────────────
  private flowHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Claude Steward — How it Works</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #e6edf3; padding: 24px; min-height: 100vh; }
  h1 { font-size: 1.3em; font-weight: 600; margin-bottom: 4px; }
  .sub { font-size: 0.8em; color: #8b949e; margin-bottom: 16px; }
  nav { display: flex; gap: 10px; margin-bottom: 28px; }
  nav a { color: #58a6ff; font-size: 0.85em; text-decoration: none; padding: 5px 12px; border: 1px solid #21262d; border-radius: 6px; background: #161b22; }
  nav a:hover { background: #21262d; }
  nav a.active { border-color: #58a6ff; }

  /* ── 3D pipeline diagram ── */
  .pipeline-scene { perspective: 1100px; perspective-origin: 50% 40%; margin-bottom: 36px; }
  .pipeline {
    display: flex; flex-direction: column; align-items: center; gap: 0;
    transform-style: preserve-3d;
    transform: rotateX(4deg);
  }
  .stage { display: flex; align-items: stretch; width: 100%; max-width: 780px; gap: 0; transform-style: preserve-3d; }
  .stage-box {
    flex: 1; background: #161b22; border: 1.5px solid #21262d; border-radius: 10px;
    padding: 16px 20px; display: flex; align-items: flex-start; gap: 14px;
    transition: border-color 0.3s, box-shadow 0.3s, transform 0.3s;
    cursor: default;
    transform-style: preserve-3d;
    box-shadow: 0 6px 24px rgba(0,0,0,0.4), 0 1px 0 #30363d inset;
  }
  .stage-box:hover {
    transform: translateZ(8px) translateY(-2px);
    border-color: #58a6ff;
    box-shadow: 0 12px 32px rgba(0,0,0,0.5), 0 0 0 1px #58a6ff44;
  }
  .stage-box.active {
    border-color: #3fb950;
    transform: translateZ(12px) translateY(-2px);
    box-shadow: 0 14px 36px rgba(63,185,80,0.25), 0 0 0 2px rgba(63,185,80,0.3);
  }
  .stage-icon { font-size: 1.7em; min-width: 36px; text-align: center; padding-top: 2px; }
  .stage-body { flex: 1; }
  .stage-title { font-size: 0.95em; font-weight: 700; margin-bottom: 4px; }
  .stage-desc  { font-size: 0.8em; color: #8b949e; line-height: 1.55; }
  .stage-saving { display: inline-block; margin-top: 7px; font-size: 0.74em; padding: 2px 8px; border-radius: 10px; background: #0d2b13; color: #3fb950; font-weight: 600; }
  .stage-saving.blue { background: #0d1b2e; color: #58a6ff; }
  .stage-saving.orange { background: #2b1a00; color: #e3b341; }

  .connector { display: flex; flex-direction: column; align-items: center; width: 100%; max-width: 780px; position: relative; height: 36px; }
  .connector-line { width: 2px; height: 36px; background: #21262d; position: relative; }
  .connector-arrow { position: absolute; bottom: -1px; left: 50%; transform: translateX(-50%); color: #30363d; font-size: 1em; }
  .connector-label { position: absolute; right: 0; top: 8px; font-size: 0.7em; color: #8b949e; white-space: nowrap; }
  .connector.active .connector-line { background: linear-gradient(to bottom, #3fb950, #3fb950); animation: flowdown 0.5s ease-in-out; }
  .connector.active .connector-arrow { color: #3fb950; }

  @keyframes flowdown {
    from { background: linear-gradient(to bottom, transparent, transparent); }
    to   { background: linear-gradient(to bottom, #3fb950, #3fb950); }
  }

  /* ── animated packet ── */
  .packet-wrapper { position: relative; overflow: visible; }
  .packet {
    display: none;
    position: absolute;
    left: 50%; top: 0;
    transform: translateX(-50%);
    width: 10px; height: 10px;
    border-radius: 50%;
    background: #3fb950;
    box-shadow: 0 0 8px #3fb950;
    z-index: 10;
    pointer-events: none;
  }
  .packet.running {
    display: block;
    animation: traveldown 0.45s linear forwards;
  }
  @keyframes traveldown { from{top:0;opacity:1} to{top:100%;opacity:0.6} }

  /* ── bypass paths ── */
  .bypass-wrap { display: flex; align-items: center; width: 100%; max-width: 780px; gap: 8px; height: 0; overflow: visible; }
  .bypass-line { flex: 0 0 auto; height: 2px; background: #e3b341; opacity: 0; transition: opacity 0.3s; }

  /* ── legend ── */
  .legend { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
  .leg { display: flex; align-items: center; gap: 6px; font-size: 0.78em; color: #8b949e; }
  .leg-dot { width: 10px; height: 10px; border-radius: 50%; }

  /* ── detail cards ── */
  .detail-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 28px; }
  .detail-card { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 14px 16px; }
  .detail-card h3 { font-size: 0.82em; font-weight: 600; margin-bottom: 8px; color: #e6edf3; }
  .detail-card p { font-size: 0.75em; color: #8b949e; line-height: 1.6; }
  .detail-card code { background: #21262d; padding: 1px 5px; border-radius: 4px; font-size: 0.9em; }

  /* ── dashboard column glossary ── */
  .glossary { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 16px 20px; margin-bottom: 28px; }
  .glossary h2 { font-size: 0.9em; font-weight: 600; margin-bottom: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; }
  .gl-row { display: flex; gap: 10px; padding: 7px 0; border-bottom: 1px solid #21262d; font-size: 0.8em; }
  .gl-row:last-child { border-bottom: none; }
  .gl-col { min-width: 110px; font-weight: 600; color: #e6edf3; }
  .gl-desc { color: #8b949e; line-height: 1.5; }

  .live-dot { width: 8px; height: 8px; border-radius: 50%; background: #3fb950; animation: blink 1.5s infinite; display: inline-block; margin-right: 5px; }
  @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.3} }
  button { background: #21262d; color: #e6edf3; border: 1px solid #30363d; padding: 7px 16px; border-radius: 6px; cursor: pointer; font-size: 0.85em; }
  button:hover { background: #30363d; }

  @media (max-width: 700px) { .detail-grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<h1>Claude Steward — How it Works</h1>
<div class="sub">Animated pipeline · every Claude Code request flows through these stages</div>

<nav>
  <a href="/">Dashboard</a>
  <a href="/flow" class="active">How it works</a>
</nav>

<!-- Legend -->
<div class="legend">
  <div class="leg"><div class="leg-dot" style="background:#3fb950"></div>Normal flow</div>
  <div class="leg"><div class="leg-dot" style="background:#e3b341"></div>Cache shortcut (skips API)</div>
  <div class="leg"><div class="leg-dot" style="background:#58a6ff"></div>Model downgrade path</div>
  <div class="leg"><span class="live-dot"></span>Live replay from last request</div>
</div>

<!-- 3D Pipeline diagram -->
<div class="pipeline-scene">
<div class="pipeline" id="pipeline">

  <div class="stage">
    <div class="stage-box" id="s0">
      <div class="stage-icon">💻</div>
      <div class="stage-body">
        <div class="stage-title">1 · VS Code / Claude Code</div>
        <div class="stage-desc">You send a message in Claude Code. The extension intercepts the outgoing HTTPS request before it reaches Anthropic — using Node's <code>http</code>/<code>https</code> module hooks and a local proxy on <code>localhost:8787</code>.</div>
      </div>
    </div>
  </div>

  <div class="connector packet-wrapper" id="c01">
    <div class="connector-line"></div>
    <div class="connector-arrow">▼</div>
    <div class="packet" id="pkt0"></div>
  </div>

  <div class="stage">
    <div class="stage-box" id="s1">
      <div class="stage-icon">🔒</div>
      <div class="stage-body">
        <div class="stage-title">2 · PII Filter</div>
        <div class="stage-desc">Scans the request body for personally identifiable information — emails, phone numbers, API keys, credit card numbers — and replaces them with readable placeholders like <code>‹EMAIL_ADDRESS_a3f2›</code> before the request is forwarded. Your real values are never sent to Claude. A VS Code warning appears when any redaction occurs.</div>
        <span class="stage-saving orange">Privacy guard</span>
      </div>
    </div>
  </div>

  <div class="connector packet-wrapper" id="c12">
    <div class="connector-line"></div>
    <div class="connector-arrow">▼</div>
    <div class="packet" id="pkt1"></div>
  </div>

  <div class="stage">
    <div class="stage-box" id="s2">
      <div class="stage-icon">⚡</div>
      <div class="stage-body">
        <div class="stage-title">3 · Semantic Cache</div>
        <div class="stage-desc">Computes an embedding of the last user message and checks if a semantically similar question was already answered. If a match is found (cosine similarity ≥ 0.92) the cached response is returned <em>instantly</em> — no API call, no cost.</div>
        <span class="stage-saving">Up to 100% savings on repeated questions</span>
      </div>
    </div>
  </div>

  <div class="connector packet-wrapper" id="c23">
    <div class="connector-line"></div>
    <div class="connector-arrow">▼</div>
    <div class="packet" id="pkt2"></div>
    <div class="connector-label" id="clabel23" style="color:#e3b341;display:none">⚡ Cache hit — stops here</div>
  </div>

  <div class="stage">
    <div class="stage-box" id="s3">
      <div class="stage-icon">✂️</div>
      <div class="stage-body">
        <div class="stage-title">4 · Prompt Optimizer</div>
        <div class="stage-desc">Removes filler phrases (<em>"please note that…"</em>), collapses whitespace, strips redundant politeness markers, and trims context window overflow. Saves tokens without changing the semantic meaning of your prompt.</div>
        <span class="stage-saving">Typically 5–20% token reduction</span>
      </div>
    </div>
  </div>

  <div class="connector packet-wrapper" id="c34">
    <div class="connector-line"></div>
    <div class="connector-arrow">▼</div>
    <div class="packet" id="pkt3"></div>
  </div>

  <div class="stage">
    <div class="stage-box" id="s4">
      <div class="stage-icon">🔀</div>
      <div class="stage-body">
        <div class="stage-title">5 · Model Router</div>
        <div class="stage-desc">Classifies the complexity of your request using a fast Haiku call. Simple questions (factual lookups, short explanations) are routed to a cheaper tier; complex or code-heavy requests go to the model you requested. The routing decision is cached so subsequent similar messages skip the classifier call.</div>
        <span class="stage-saving blue">Up to 10× cheaper for simple queries</span>
      </div>
    </div>
  </div>

  <div class="connector packet-wrapper" id="c45">
    <div class="connector-line"></div>
    <div class="connector-arrow">▼</div>
    <div class="packet" id="pkt4"></div>
  </div>

  <div class="stage">
    <div class="stage-box" id="s5">
      <div class="stage-icon">🤖</div>
      <div class="stage-body">
        <div class="stage-title">6 · Claude API</div>
        <div class="stage-desc">The optimised, possibly-rerouted request is forwarded to Anthropic. Streaming responses are passed through token-by-token. Token usage from the response headers is recorded for the dashboard.</div>
      </div>
    </div>
  </div>

  <div class="connector packet-wrapper" id="c56" style="transform: rotate(180deg)">
    <div class="connector-line"></div>
    <div class="connector-arrow">▼</div>
    <div class="packet" id="pkt5"></div>
  </div>

  <div class="stage">
    <div class="stage-box" id="s6">
      <div class="stage-icon">📬</div>
      <div class="stage-body">
        <div class="stage-title">7 · Response → VS Code</div>
        <div class="stage-desc">The response (or cached answer) is returned to Claude Code. Stats are recorded: tokens, cost, model used, savings achieved, duration. The dashboard updates in real time via SSE.</div>
      </div>
    </div>
  </div>

</div><!-- /pipeline -->
</div><!-- /pipeline-scene -->

<!-- Play controls -->
<div style="margin-bottom:28px;display:flex;gap:10px;align-items:center">
  <button onclick="playNormal()">▶ Simulate normal request</button>
  <button onclick="playCacheHit()">⚡ Simulate cache hit</button>
  <button onclick="playDowngrade()">🔀 Simulate model downgrade</button>
</div>

<!-- Dashboard column glossary -->
<div class="glossary">
  <h2>Dashboard column guide</h2>
  <div class="gl-row"><div class="gl-col">Tokens Saved</div><div class="gl-desc">Cumulative tokens not sent to the API — from prompt compression and semantic cache hits combined. The % is the fraction saved vs. total tokens that would have been sent without the extension.</div></div>
  <div class="gl-row"><div class="gl-col">Cost Saved</div><div class="gl-desc">Dollar amount saved this session. Calculated as <code>(originalTokens − actualTokens) × inputPrice + cacheHits × fullCost</code>. The "Total spent" hint shows what you actually paid.</div></div>
  <div class="gl-row"><div class="gl-col">Cache Hits</div><div class="gl-desc">Number of requests answered from the semantic cache without an API call. "of N requests" gives the hit rate.</div></div>
  <div class="gl-row"><div class="gl-col">Model Routes</div><div class="gl-desc">How many requests were redirected to a cheaper model tier (e.g. Opus → Haiku). The router only downgrades when it is confident the task is simple enough.</div></div>
  <div class="gl-row"><div class="gl-col">In (tokens)</div><div class="gl-desc">Input tokens actually sent to the API after optimization. Does not include tokens saved by compression.</div></div>
  <div class="gl-row"><div class="gl-col">Out (tokens)</div><div class="gl-desc">Output tokens returned by Claude in the response.</div></div>
  <div class="gl-row"><div class="gl-col">Reason</div><div class="gl-desc"><code>pre-classify</code> = heuristic match (no classifier call needed) · <code>classifier-cache</code> = same question classified before · <code>classifier</code> = Haiku classification call made · <code>pass</code> = passed through unchanged.</div></div>
  <div class="gl-row"><div class="gl-col">Saved</div><div class="gl-desc">Per-request dollar saving vs. sending the original prompt to the original model at full price.</div></div>
  <div class="gl-row"><div class="gl-col">ms</div><div class="gl-desc">Total proxy round-trip in milliseconds — from the moment the request arrived at the proxy to the last byte of the response being sent back.</div></div>
  <div class="gl-row"><div class="gl-col">Tags</div><div class="gl-desc"><code>stream</code> = streaming response · <code>trimmed</code> = context window was compressed · <code>→model</code> = routed to a different model · <code>cache</code> = served from semantic cache.</div></div>
</div>

<!-- Detail cards -->
<div class="detail-grid">
  <div class="detail-card">
    <h3>Why a local proxy?</h3>
    <p>Claude Code sends HTTPS requests directly to <code>api.anthropic.com</code>. The extension patches Node's <code>https.request</code> and <code>undici</code> fetch hooks to transparently redirect those requests through <code>localhost:8787</code> first — no configuration needed, no code changes.</p>
  </div>
  <div class="detail-card">
    <h3>What is never stored?</h3>
    <p>Prompt content, response content, file contents, or any user data is never stored. Only token counts, model names, costs, timestamps, and a short message preview (first 80 chars) is kept — all in memory, cleared on VS Code restart.</p>
  </div>
  <div class="detail-card">
    <h3>Semantic cache accuracy</h3>
    <p>The cache uses cosine similarity on a lightweight local embedding (no API call). The 0.92 threshold is tuned to be conservative — it only returns a cached answer when the question is genuinely very similar, not just topically related.</p>
  </div>
  <div class="detail-card">
    <h3>Model routing safety</h3>
    <p>The router never upgrades your model (it can only downgrade to save cost). If it is uncertain, it passes through unchanged. You can disable routing entirely in extension settings to always use your requested model.</p>
  </div>
  <div class="detail-card">
    <h3>Savings by tier</h3>
    <p>The dashboard breaks down requests by model tier (Haiku / Sonnet / Opus) so you can see how much of your usage was naturally routed to cheaper tiers and how much was actively downgraded by the router.</p>
  </div>
  <div class="detail-card">
    <h3>Real-time updates</h3>
    <p>The dashboard uses Server-Sent Events (<code>/events</code>) so cards and the mini flow strip animate the moment a request is processed — no need to wait for the 4-second poll cycle.</p>
  </div>
</div>

<div style="font-size:0.75em;color:#8b949e;margin-bottom:24px">
  <span class="live-dot"></span>Live event feed active · <a href="/" style="color:#58a6ff;text-decoration:none">← Back to dashboard</a>
</div>

<script>
// ── Stage IDs in order ───────────────────────────────────────────────────────
const STAGES     = ['s0','s1','s2','s3','s4','s5','s6'];
const CONNECTORS = ['c01','c12','c23','c34','c45','c56'];
const PACKETS    = ['pkt0','pkt1','pkt2','pkt3','pkt4','pkt5'];

function clearAll() {
  STAGES.forEach(id => document.getElementById(id)?.classList.remove('active'));
  CONNECTORS.forEach(id => document.getElementById(id)?.classList.remove('active'));
  PACKETS.forEach(id => document.getElementById(id)?.classList.remove('running'));
  const lbl = document.getElementById('clabel23');
  if (lbl) lbl.style.display = 'none';
}

function animateTo(stopAfterStage, isCacheHit) {
  clearAll();
  let step = 0;

  function tick() {
    if (step >= STAGES.length || step > stopAfterStage) return;

    // Light up current stage
    document.getElementById(STAGES[step])?.classList.add('active');

    // Animate packet in connector leading to next
    if (step < PACKETS.length) {
      const pkt = document.getElementById(PACKETS[step]);
      if (pkt) {
        pkt.classList.remove('running');
        void pkt.offsetWidth; // reflow
        pkt.classList.add('running');
      }
      document.getElementById(CONNECTORS[step])?.classList.add('active');
    }

    if (step === 2 && isCacheHit) {
      const lbl = document.getElementById('clabel23');
      if (lbl) { lbl.style.display = 'block'; }
    }

    step++;
    if (step <= stopAfterStage) setTimeout(tick, 420);
  }
  tick();
}

function playNormal()    { animateTo(6, false); }
function playCacheHit()  { animateTo(2, true);  }
function playDowngrade() { animateTo(6, false); }

// ── SSE live replay ──────────────────────────────────────────────────────────
function connectSSE() {
  const es = new EventSource('/events');
  es.onmessage = e => {
    try {
      const d = JSON.parse(e.data);
      if (d.type === 'request') {
        animateTo(d.cacheHit ? 2 : 6, d.cacheHit);
      }
    } catch {}
  };
  es.onerror = () => setTimeout(connectSSE, 3000);
}
connectSSE();

// Auto-demo on load if no SSE event in 3 seconds
let demoed = false;
setTimeout(() => { if (!demoed) { playNormal(); demoed = true; } }, 800);
</script>
</body>
</html>`;
  }
}
