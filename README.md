# Claude Steward — 5DD Plan

> Minimize Claude token usage without compromising efficiency. Keep your AI interactions governed, auditable, and cost-controlled.

---

## Vision

Claude Steward is built around two pillars:

**1. Token efficiency** — squeeze the most out of every API call without degrading response quality. Smart routing, caching, and compression work together so you never pay for tokens you don't need.

**2. Interaction governance** — know what is being sent to Claude, when, and why. Lay the foundation for data hygiene, prompt auditing, and policy enforcement — so Claude fits inside your organization's boundaries, not around them.

Target: **$5 a day (5DD plan)** for a typical developer workload.

---

## How it works

```text
VS Code / Claude Code  →  localhost:8787 (Claude Steward proxy)  →  Anthropic API
```

| Technique | What it does | Typical saving |
| --- | --- | --- |
| **Model router** | Haiku classifies each request; simple ones stay on Haiku, complex ones escalate to Sonnet or Opus | up to 10× cheaper per query |
| **Semantic cache** | Returns cached response for repeated or similar prompts | 100% on cache hits |
| **Prompt compression** | Strips whitespace, filler phrases, duplicate content | 5–15% |
| **Context trimming** | Drops oldest messages when context exceeds budget | 20–50% on long conversations |
| **Governance hooks** *(roadmap)* | Flag sensitive data, enforce prompt policies, log interactions | — |

---

## Setup (5 steps)

### 1. Install Node / npm

If you don't have npm, ask your support team to install [Node.js](https://nodejs.org).

### 2. Install dependencies

```bash
npm install
```

### 3. Build

```bash
npm run compile
```

### 4. Set the environment variable

**Linux / macOS:**

```bash
export ANTHROPIC_BASE_URL=http://localhost:8787
```

**Windows (office / restricted environments):**

Run `set_env.bat` — double-click or run from a terminal. Sets `ANTHROPIC_BASE_URL` permanently for your user session via `setx`.

### 5. Launch

Open the folder in VS Code and press `F5`.

---

## Configuration

Open Settings (`Ctrl+,`) → search `Claude Optimizer`.

| Setting | Description |
| --- | --- |
| `claudeOptimizer.proxyPort` | Proxy port (default: 8787) |
| `claudeOptimizer.enableCache` | Semantic response cache |
| `claudeOptimizer.cacheThreshold` | Similarity threshold 0–1 (default: 0.92) |
| `claudeOptimizer.enableModelRouter` | Auto-route to cheaper models |
| `claudeOptimizer.enablePromptCompression` | Compress prompts before sending |

Sensitive values via env vars:
`ANTHROPIC_API_KEY`, `JIRA_API_TOKEN`, `GITHUB_TOKEN`, `AZURE_TENANT_ID`, `DATABRICKS_TOKEN`, `DATABASE_URL`

---

## Commands

| Command | Description |
| --- | --- |
| `Claude Optimizer: Show Dashboard` | Live token savings dashboard |
| `Claude Optimizer: Toggle ON/OFF` | Pause/resume the proxy |
| `Claude Optimizer: Clear Cache` | Wipe the semantic cache |
| `Claude Optimizer: Optimize Selected Prompt` | Analyze selected text |

---

## Debugging

Output panel → select **"Claude Optimizer"**.

Key lines:

- `Proxy started on port 8787` — running
- `Incoming: model=...` — request received
- `Streaming: <model> rejected ... escalating to <model>` — model escalation in progress
- `Cache HIT` — saved a full round-trip

---

## Roadmap

- [ ] Governance dashboard — audit log of all Claude interactions
- [ ] Sensitive data detection — flag PII/secrets before they leave your machine
- [ ] Prompt policy enforcement — block or warn on policy violations
- [ ] Cost alerts — notify when daily spend exceeds threshold
- [ ] Team mode — shared cache and governance rules across a team

---

## The challenge

VS Code has no official API for intercepting Claude Code's calls. Claude Steward works by acting as a local proxy via `ANTHROPIC_BASE_URL` — a controlled man-in-the-middle on `localhost`. No extra API subscription required.

---

## Contributing

PRs and issues welcome.

- One thing per PR
- No speculative abstractions
- If it's broken, open an issue before fixing
