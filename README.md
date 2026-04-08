# Claude Token Optimizer — VS Code Extension

Runs silently in the background and cuts your Anthropic API costs by 40–70%.

## How it works

```
Your App  →  localhost:8787 (proxy)  →  Anthropic API
```

Set one env var and you're done:
```bash
export ANTHROPIC_BASE_URL=http://localhost:8787
```

## What it does automatically

| Technique | Typical saving |
|---|---|
| Semantic cache — returns cached response for similar prompts | 100% on cache hits |
| Prompt compression — strips whitespace, filler phrases, duplicate content | 5–15% |
| Context trimming — summarizes old messages instead of sending all | 20–50% on long convos |
| Model router — sends simple queries to haiku instead of sonnet/opus | 10× cheaper per query |

## Smart context injection

Instead of dumping full files/logs/wikis into your prompt, the extension:
- Watches log files and extracts **only the erroring lines + stack trace**
- Reads git history and sends **only recent commits + current diff**
- Queries Jira/Confluence for **summaries, not full pages**
- Checks CI/CD for **failed step only, not the full build log**

## Setup

### 1. Install dependencies
```bash
cd path/to/extension
npm install
npm run compile
```

### 2. Open in VS Code
Press `F5` to launch the Extension Development Host.

### 3. Configure integrations (optional)
Open Settings (`Ctrl+,`) and search for `Claude Optimizer`.

| Setting | Description |
|---|---|
| `claudeOptimizer.proxyPort` | Proxy port (default: 8787) |
| `claudeOptimizer.enableCache` | Semantic response cache |
| `claudeOptimizer.cacheThreshold` | Similarity threshold 0–1 (default: 0.92) |
| `claudeOptimizer.enableModelRouter` | Auto-route to cheaper models |
| `claudeOptimizer.enablePromptCompression` | Compress prompts |
| `claudeOptimizer.jira.baseUrl` | Jira instance URL |
| `claudeOptimizer.cicd.provider` | `github-actions` / `azure-devops` / `jenkins` |
| `claudeOptimizer.azure.tenantId` | Azure AD tenant ID |
| `claudeOptimizer.databricks.host` | Databricks workspace URL |
| `claudeOptimizer.terraform.workspacePath` | Path to terraform workspace |
| `claudeOptimizer.database.connectionString` | DB connection string |

Sensitive values (tokens, secrets) can be set via environment variables instead:
`ANTHROPIC_API_KEY`, `JIRA_API_TOKEN`, `GITHUB_TOKEN`, `AZURE_TENANT_ID`, `DATABRICKS_TOKEN`, `DATABASE_URL`

## Commands

| Command | Description |
|---|---|
| `Claude Optimizer: Show Dashboard` | Open token savings dashboard |
| `Claude Optimizer: Start Proxy` | Start the proxy server |
| `Claude Optimizer: Stop Proxy` | Stop the proxy server |
| `Claude Optimizer: Clear Cache` | Wipe the semantic cache |
| `Claude Optimizer: Optimize Selected Prompt` | Analyze selected text |

## Dashboard

Click the status bar item (`$(shield) Claude Optimizer`) to open the dashboard showing:
- Total tokens saved + cost saved
- Cache hit rate
- Model downgrade rate
- Recent request log with per-request breakdown
