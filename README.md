# Claude Steward — Reduce Claude API Costs by 60–90%

> **100% local. Zero data sent. No subscriptions. Just cheaper AI.**

Claude Steward is a free VS Code extension that silently sits between your editor and the Anthropic API, using smart caching, compression, model routing, and context compaction to dramatically cut your Claude Code token costs — without changing how you work.

**Target: $5/day** for a full developer workload. No API key changes. No new accounts. Install and go.

---

## Why Claude Steward?

Claude Code bills per token. Long conversations, repeated questions, and heavy context windows add up fast. Claude Steward intercepts every request before it reaches Anthropic and applies five layers of optimization:

- **Cache** answers to repeated or similar questions — pay once, reuse forever
- **Compress** prompts by removing filler and whitespace — 5–20% fewer tokens every request
- **Route** simple questions to Haiku (3× cheaper) instead of always using Sonnet
- **Compact** long conversations — summarize old turns so you're not re-sending your entire chat history on every message
- **Mask PII** before anything leaves your machine — emails, API keys, phone numbers replaced with safe placeholders

Everything runs on `localhost`. **No data is stored, transmitted, or logged anywhere outside your own machine.**

---

## Quick Start

1. Install **Claude Steward** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=PrashantMalan.claude-steward)
2. Open a **new** Claude Code chat window (existing windows pre-date the proxy — or click "Route all windows ↺" in the dashboard)
3. Start chatting — the status bar shows 🟢 when the proxy is active

No configuration needed. Savings start immediately.

---

## How it works

```text
Claude Code  →  localhost:8787 (Claude Steward)  →  Anthropic API
```

Every request passes through a 5-stage local pipeline before reaching Anthropic:

| Stage | What it does | Typical saving |
| --- | --- | --- |
| **PII Filter** | Detects emails, phone numbers, credit cards, API keys, IBANs. Replaces them with safe tokens before sending. Reversed in the response. | Privacy |
| **Semantic Cache** | Embeds each question and compares against a local cache (cosine ≥ 0.92). Identical or near-identical questions get the cached response instantly — no API call. | 100% on hits |
| **Prompt Compression** | Strips filler phrases ("Sure!", "Of course!"), collapses whitespace, trims oversized tool results and repeated content. | 5–20% per request |
| **Context Compaction** | When conversations exceed ~20 turns, Haiku summarizes older turns into a compact block. Old turns dropped, recent turns kept. Shorter context = fewer tokens on every subsequent message. | 30–60% on long sessions |
| **Model Router** | Classifies request complexity locally. Simple Q&A, explanations, git output → Haiku (3× cheaper). Code writing and debugging → Sonnet. Zero added latency for recognized patterns. | Up to 10× on simple tasks |

---

## Features

### 🔒 100% Local — No Data Leaves Your Machine

- All processing happens on `localhost`
- The semantic cache, conversation summaries, and traces are stored only in VS Code workspace state
- The dashboard polls `localhost:8787` — no external calls
- PII masking runs **before** any data is sent to Anthropic
- No analytics, no telemetry, no cloud sync

### ⚡ Model Router — Stop Paying Sonnet Prices for Simple Questions

The router classifies requests **locally** (no Haiku API call needed for common patterns):

- Short messages under 80 characters with no code-write keywords → **Haiku**
- "Explain", "describe", "list", "show me", "what is", "summarize" questions → **Haiku**
- Git/bash/terminal one-liners → **Haiku**
- "Write", "implement", "fix", "refactor", "create" → **Sonnet** (stays there)

For ambiguous requests, a background Haiku classifier fires and caches the result for next time. Zero latency on the current request.

Modes: `balanced` (default) · `aggressive` (moderate tasks also → Haiku) · `conservative` (no routing)

### 💾 Semantic Cache — Ask Once, Pay Once

- Compares each question against cached answers using cosine similarity
- Threshold: 0.92 by default (configurable)
- Cache size: 500 entries with LRU eviction
- Works across VS Code sessions

### ✂️ Prompt Compression

- Removes conversational filler
- Collapses blank lines and redundant whitespace
- Trims oversized tool results and duplicate file contents
- Never modifies code blocks or technical content

### 📝 Context Compaction — Long Conversations, Short Bills

- Triggers automatically after ~20 message turns
- Haiku summarizes older turns, extracting: variables, file paths, decisions, task state, constraints, errors resolved
- Summary injected into system prompt; old turns dropped
- Background execution: current request unaffected; compaction applied from next request
- Cached by content hash — old turns are never summarized twice

### 🛡️ PII Filter

- Detects: email addresses, phone numbers, credit card numbers, IBANs, API keys, SSNs
- Replaces with readable tokens: `[EMAIL_1]`, `[PHONE_1]`, `[API_KEY_1]`
- Reversed in the response so your output reads normally
- VS Code warning notification on detection (throttled to once per 30 seconds)

### 📊 Live Dashboard

- Open: status bar click, or `Ctrl+Shift+P` → **Claude Steward: Show Dashboard**
- Shows: tokens saved, cost saved (estimated), cache hit rate, model routes, per-request trace table
- Real-time updates via SSE
- **Route all windows ↺**: restarts the VS Code extension host so existing Claude Code windows start routing through the proxy
- Export all traces to CSV
- Proxy status: 🟢 connected / 🔴 offline

---

## Configuration

`Ctrl+,` → search **Claude Steward**

| Setting | Default | Description |
| --- | --- | --- |
| `claudeSteward.proxyPort` | `8787` | Local proxy port |
| `claudeSteward.enableCache` | `true` | Semantic response cache |
| `claudeSteward.cacheThreshold` | `0.92` | Similarity cutoff (0–1) |
| `claudeSteward.enableModelRouter` | `true` | Route to cheaper models |
| `claudeSteward.routerMode` | `balanced` | `balanced` / `aggressive` / `conservative` |
| `claudeSteward.enablePromptCompression` | `true` | Strip filler and whitespace |
| `claudeSteward.enablePiiFilter` | `true` | Detect and mask PII |

---

## Commands

`Ctrl+Shift+P` → type **Claude Steward**

| Command | Description |
| --- | --- |
| `Claude Steward: Show Dashboard` | Open the live savings dashboard |
| `Claude Steward: Toggle Proxy ON/OFF` | Pause or resume the proxy |
| `Claude Steward: Clear Cache` | Wipe the semantic cache |

---

## Cost Estimates

Savings shown in the dashboard are estimates based on Anthropic's public per-token pricing and the token delta between the original request and what was actually sent. Verify against your [Anthropic console](https://console.anthropic.com/settings/billing).

---

## Troubleshooting

**Dashboard shows "Proxy offline"**
Proxy failed to start. Output panel → **Claude Steward** for errors.

**All requests still going to Sonnet**
Open a new Claude Code chat window — existing windows opened before the extension installed don't route through the proxy. Or use "Route all windows ↺" in the dashboard.

**No data in the dashboard**
Send at least one message from a new Claude Code chat window after installing.

---

## Technical Notes

- The extension patches `https.request`, `globalThis.fetch`, and the undici dispatcher in the VS Code extension host at startup
- Internal calls (Haiku classifier, context summarizer) use an `x-steward-internal` header so they bypass the optimization pipeline and don't loop
- The proxy captures the original `https.request` before patching, so forwarding to Anthropic is always direct

---

## Contributing

Issues and PRs welcome at [github.com/prashantmalan/5DD](https://github.com/prashantmalan/5DD).

- One thing per PR
- No speculative abstractions
- Open an issue before fixing a bug
