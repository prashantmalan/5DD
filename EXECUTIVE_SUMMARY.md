# Claude Token Optimizer — Executive Summary

**Version 1.0 | Prepared by: Prashant Malan**

---

## What Is This?

Claude Token Optimizer is a VS Code extension that sits silently between your application and the Anthropic (Claude) API. Every time your app sends a request to Claude, the optimizer intercepts it, applies a set of intelligent savings techniques, and forwards only what is necessary — then returns the result as if nothing changed.

**You change one line of configuration. Everything else is automatic.**

```
Your App  →  Claude Token Optimizer (localhost)  →  Anthropic API
```

---

## The Business Case

Anthropic charges per token — roughly every 4 characters of text sent to or received from Claude. In production systems, teams routinely waste 40–70% of their token budget on:

- Repeated or redundant context sent with every request
- Verbose AI responses filled with filler phrases
- Expensive flagship models used for simple tasks (like formatting a date)
- Identical questions asked repeatedly within a session

This extension eliminates that waste automatically, with no changes to your codebase.

---

## Four Saving Techniques

### 1. Semantic Response Cache — *saves up to 100% on repeated queries*

When a question has already been answered, there is no reason to ask Claude again.

**How it works:** Every response is stored locally. Before sending a new request, the optimizer checks whether a sufficiently similar question has already been answered (using a text-similarity algorithm called TF-IDF cosine similarity). If the similarity score exceeds the configured threshold (default: 92%), the cached answer is returned instantly — zero tokens consumed, zero API cost, zero latency.

**Example:** A user asks "What is the status of the deployment?" ten times in a session. Only the first request reaches Claude. The other nine are answered from cache — saving 100% of those tokens.

**Threshold explained:** A similarity score of 1.0 means identical. 0.92 means "almost the same question, different wording." This is tunable per team preference.

---

### 2. Prompt Compression — *saves 5–15% per request*

Every request is compressed before it is sent, removing characters that cost tokens but add no meaning.

**What gets removed:**
- Extra blank lines and whitespace (e.g., triple line breaks → single line break)
- Multiple spaces and tabs collapsed to one space
- Verbose AI preambles like *"Sure, I'd be happy to help you with that!"* or *"As an AI language model..."*
- Trailing filler like *"Let me know if you have any other questions."*
- Duplicate instructions appearing more than once in the system prompt
- The same code block pasted multiple times in a conversation — replaced with a reference

**What is preserved:** All meaningful content. The compression is lossless from a semantic perspective.

---

### 3. Context Trimming — *saves 20–50% on long conversations*

Claude's API charges for the entire conversation history sent with every message. In a long chat session, this grows rapidly — you pay for message #1 on every subsequent request.

**How it works:** When a conversation exceeds 20 messages, the optimizer automatically drops the oldest messages and inserts a compact summary note in their place:

> *"[Context note: 12 earlier messages were summarized to save tokens. The conversation continues below.]"*

The recent context (most relevant to the current task) is always preserved in full.

**Impact example:** A 40-message conversation without trimming sends ~40 messages' worth of tokens every time. With trimming, it sends ~21 (1 summary + 20 recent) — roughly a 50% reduction on input tokens for that request.

---

### 4. Automatic Model Router — *saves up to 18× per routed request*

Not every question requires Claude's most capable (and most expensive) model. Asking a flagship model to format a date or translate a word is like hiring a senior engineer to fill out a form.

**How it works:** The optimizer reads the last user message before sending, classifies its complexity, and routes it to the cheapest model that can handle it:

| Task complexity | Model used | Cost per 1M input tokens |
|---|---|---|
| Simple (format, translate, define, yes/no) | Claude Haiku | $0.80 |
| Standard (code, analysis, reasoning) | Claude Sonnet | $3.00 |
| Expert (proofs, large-scale architecture) | Claude Opus | $15.00 |

**Simple request detection examples:** Phrases like *"what is"*, *"translate"*, *"fix the typo"*, *"rename"*, or short prompts under 200 characters with no prior context are routed to Haiku automatically.

**Savings example:** A query routed from Sonnet ($3.00) to Haiku ($0.80) saves **$2.20 per million input tokens** — a 73% reduction on that request. From Opus ($15.00) to Haiku ($0.80): an **18× cost reduction**.

---

## How Savings Are Measured

The extension tracks every request in a persistent local log. For each request, it records:

| Metric | How it is calculated |
|---|---|
| **Original token count** | Counted before any optimization using a BPE tokenizer (same family as Claude's own tokenizer) |
| **Tokens saved by compression** | Original token count minus optimized token count |
| **Tokens saved by cache** | Full original token count (since no request was sent) |
| **Cost of actual request** | `(input tokens / 1,000,000) × model input price` + `(output tokens / 1,000,000) × model output price` |
| **Cost saved** | Difference between what the original request would have cost and what was actually charged |
| **Average savings %** | `tokens saved ÷ (tokens used + tokens saved) × 100` across the session |

All figures are visible in real time on the **Dashboard** (open with `Ctrl+Shift+P` → *Claude Token Optimizer: Show Dashboard*).

---

## Smart Context Injection (Advanced)

Beyond token compression, the extension also provides intelligent context fetching for development workflows — sending only the relevant slice of external data rather than entire files or pages:

| Source | Without optimizer | With optimizer |
|---|---|---|
| Log files | Entire log file | Only error lines + stack trace |
| Git history | Full commit log | Recent commits + current diff only |
| Jira / Confluence | Full page content | Summaries only |
| CI/CD build logs | Entire build output | Failed step only |
| Databases / Databricks | Full query results | Filtered, relevant rows |

---

## Setup (3 Steps)

**Step 1 — Install and compile the extension**
```bash
npm install && npm run compile
```

**Step 2 — Launch in VS Code**
Press `F5` to start the extension. A status bar item appears: `$(shield) Claude Optimizer`.

**Step 3 — Point your app at the proxy**
```bash
export ANTHROPIC_BASE_URL=http://localhost:8787
```

That's it. All existing code continues to work. The optimizer is transparent to your application.

---

## Key Settings

| Setting | Default | Description |
|---|---|---|
| `claudeOptimizer.enableCache` | true | Turn semantic cache on/off |
| `claudeOptimizer.cacheThreshold` | 0.92 | Similarity score required for a cache hit (0–1) |
| `claudeOptimizer.enableModelRouter` | true | Automatically route simple queries to cheaper models |
| `claudeOptimizer.enablePromptCompression` | true | Compress prompts before sending |
| `claudeOptimizer.proxyPort` | 8787 | Port the local proxy listens on |

Sensitive credentials (API keys, tokens) are read from environment variables and never stored in settings files.

---

## Dashboard at a Glance

The built-in dashboard shows live metrics for the current session:

- **Total tokens saved** and **total cost saved (USD)**
- **Cache hit rate** — what percentage of requests were answered from cache
- **Model downgrade rate** — how often routing sent a request to a cheaper model
- **Per-request log** — each request with its model, tokens, savings, and techniques applied

---

## Summary

| What it does | Impact |
|---|---|
| Caches semantically similar responses | Up to 100% savings on repeated queries |
| Compresses prompts automatically | 5–15% savings on every request |
| Trims long conversation history | 20–50% savings on long sessions |
| Routes simple queries to cheaper models | Up to 18× cost reduction per routed request |
| **Overall typical savings** | **40–70% reduction in Anthropic API costs** |

No infrastructure changes. No code changes. One environment variable.

---

*Claude Token Optimizer — VS Code Extension*
