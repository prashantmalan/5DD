/**
 * Proxy Server
 * Runs on localhost and intercepts all Anthropic API calls.
 * Your app just needs: ANTHROPIC_BASE_URL=http://localhost:8787
 *
 * Pipeline per request:
 *   1. Deserialize request body
 *   2. Check semantic cache → return cached response if hit
 *   3. Run prompt optimizer (compression, context trim)
 *   4. Run model router (downgrade if appropriate)
 *   5. Forward to Anthropic API
 *   6. Store response in cache
 *   7. Record stats
 */

import * as http from 'http';
import * as https from 'https';
import { SemanticCache } from './semanticCache';
import { PromptOptimizer } from './promptOptimizer';
import { ModelRouter } from './modelRouter';
import { TokenCounter, AnthropicRequestBody } from './tokenCounter';
import { StatsTracker, RequestStat } from './statsTracker';

const ANTHROPIC_HOST = 'api.anthropic.com';

export interface ProxyConfig {
  port: number;
  enabled: boolean;          // master on/off switch — when off, passes through unchanged
  enableCache: boolean;
  enableCompression: boolean;
  enableModelRouter: boolean;
  apiKey: string;
}

export class ProxyServer {
  private server: http.Server | null = null;
  private cache: SemanticCache;
  private optimizer: PromptOptimizer;
  private router: ModelRouter;
  private tokenCounter: TokenCounter;
  private stats: StatsTracker;
  private config: ProxyConfig;

  constructor(
    config: ProxyConfig,
    cache: SemanticCache,
    optimizer: PromptOptimizer,
    router: ModelRouter,
    tokenCounter: TokenCounter,
    stats: StatsTracker
  ) {
    this.config = config;
    this.cache = cache;
    this.optimizer = optimizer;
    this.router = router;
    this.tokenCounter = tokenCounter;
    this.stats = stats;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        console.log(`[Claude Optimizer] >> ${req.method} ${req.url} enabled=${this.config.enabled}`);
        this.handleRequest(req, res).catch(err => {
          console.error('[Claude Optimizer] Proxy error:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Proxy internal error', type: 'proxy_error' } }));
        });
      });

      this.server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${this.config.port} is already in use. Change claudeOptimizer.proxyPort in settings.`));
        } else {
          reject(err);
        }
      });

      this.server.listen(this.config.port, '127.0.0.1', () => {
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
        this.server = null;
      } else {
        resolve();
      }
    });
  }

  isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  updateConfig(config: Partial<ProxyConfig>): void {
    this.config = { ...this.config, ...config };
    this.router.setEnabled(config.enableModelRouter ?? this.config.enableModelRouter);
  }

  toggle(): boolean {
    this.config.enabled = !this.config.enabled;
    return this.config.enabled;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const rawBody = await readBody(req);

    // Master switch OFF → pass through completely unchanged
    if (!this.config.enabled) {
      this.forwardRaw(req, rawBody, res);
      return;
    }

    const isMessagesEndpoint = req.url?.includes('/messages') || req.url?.includes('/completions');
    if (!isMessagesEndpoint || req.method !== 'POST') {
      this.forwardRaw(req, rawBody, res);
      return;
    }

    let body: AnthropicRequestBody;
    try {
      body = JSON.parse(rawBody);
    } catch {
      this.forwardRaw(req, rawBody, res);
      return;
    }

    const isStreaming = body.stream === true;
    const originalTokens = this.tokenCounter.countRequest(body).prompt;

    // 1. Cache check — only for non-streaming requests
    if (this.config.enableCache && !isStreaming) {
      const cacheResult = this.cache.lookup(body, originalTokens);
      if (cacheResult.hit && cacheResult.response) {
        this.stats.record(this.buildStat({
          body, originalModel: body.model, finalModel: body.model,
          inputTokens: 0, outputTokens: 0, savedByCompression: 0,
          savedByCache: originalTokens, cacheHit: true, modelDowngraded: false,
          techniques: ['cache-hit'],
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(cacheResult.response));
        return;
      }
    }

    // 2. Prompt optimization
    let savedByCompression = 0;
    let techniques: string[] = [];
    if (this.config.enableCompression) {
      const result = this.optimizer.optimize(body);
      body = result.body;
      savedByCompression = result.savedTokens;
      techniques = result.techniques;
    }

    // 3. Model routing
    let modelDowngraded = false;
    const originalModel = body.model;
    if (this.config.enableModelRouter) {
      const routing = this.router.route(body);
      body.model = routing.selectedModel;
      modelDowngraded = routing.downgraded;
    }

    // 4. Forward — streaming requests piped directly, non-streaming buffered
    if (isStreaming) {
      this.forwardStreaming(req, body, res, (inputTokens, outputTokens) => {
        this.stats.record(this.buildStat({
          body, originalModel, finalModel: body.model,
          inputTokens, outputTokens, savedByCompression,
          savedByCache: 0, cacheHit: false, modelDowngraded, techniques,
        }));
      });
    } else {
      const response = await this.forwardToAnthropic(req, body);
      const inputTokens = response?.usage?.input_tokens || originalTokens - savedByCompression;
      const outputTokens = response?.usage?.output_tokens || 0;

      if (this.config.enableCache) {
        this.cache.store(body, response, inputTokens);
      }
      this.stats.record(this.buildStat({
        body, originalModel, finalModel: body.model,
        inputTokens, outputTokens, savedByCompression,
        savedByCache: 0, cacheHit: false, modelDowngraded, techniques,
      }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    }
  }

  // Pipe a streaming response straight through — never buffers, no hang
  private forwardStreaming(
    req: http.IncomingMessage,
    body: AnthropicRequestBody,
    res: http.ServerResponse,
    onDone: (inputTokens: number, outputTokens: number) => void
  ): void {
    const bodyStr = JSON.stringify(body);
    const headers = this.buildForwardHeaders(req, bodyStr);

    const proxyReq = https.request({
      hostname: ANTHROPIC_HOST,
      port: 443,
      path: req.url || '/v1/messages',
      method: 'POST',
      headers
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);

      let buffer = '';
      let inputTokens = 0;
      let outputTokens = 0;

      proxyRes.on('data', (chunk: Buffer) => {
        res.write(chunk);
        // Parse usage from SSE stream for stats
        buffer += chunk.toString();
        const usageMatch = buffer.match(/"input_tokens":(\d+).*?"output_tokens":(\d+)/s);
        if (usageMatch) {
          inputTokens = parseInt(usageMatch[1]);
          outputTokens = parseInt(usageMatch[2]);
        }
      });
      proxyRes.on('end', () => {
        res.end();
        onDone(inputTokens, outputTokens);
      });
      proxyRes.on('error', () => res.end());
    });

    proxyReq.on('error', () => {
      res.writeHead(502);
      res.end('Bad Gateway');
    });
    proxyReq.write(bodyStr);
    proxyReq.end();
  }

  private forwardToAnthropic(
    req: http.IncomingMessage,
    body: AnthropicRequestBody
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const bodyStr = JSON.stringify(body);
      const headers = this.buildForwardHeaders(req, bodyStr);

      const proxyReq = https.request({
        hostname: ANTHROPIC_HOST, port: 443,
        path: req.url || '/v1/messages', method: 'POST', headers
      }, (proxyRes) => {
        let data = '';
        proxyRes.on('data', (chunk: any) => { data += chunk; });
        proxyRes.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve(data); }
        });
      });

      proxyReq.on('error', reject);
      proxyReq.write(bodyStr);
      proxyReq.end();
    });
  }

  // Build headers for forwarding — pass ALL original headers, fix host + content-length
  private buildForwardHeaders(req: http.IncomingMessage, bodyStr: string): Record<string, string | string[]> {
    const headers: Record<string, string | string[]> = {};
    for (const [key, val] of Object.entries(req.headers)) {
      if (val !== undefined) headers[key] = val as string | string[];
    }
    headers['host'] = ANTHROPIC_HOST;
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(bodyStr));
    // Fallback: if no auth header at all, try config key
    if (!headers['authorization'] && !headers['x-api-key']) {
      const key = this.config.apiKey || process.env.ANTHROPIC_API_KEY || '';
      if (key) headers['x-api-key'] = key;
    }
    return headers;
  }

  private forwardRaw(req: http.IncomingMessage, body: string, res: http.ServerResponse): void {
    const options: https.RequestOptions = {
      hostname: ANTHROPIC_HOST,
      port: 443,
      path: req.url || '/',
      method: req.method,
      headers: { ...req.headers, host: ANTHROPIC_HOST }
    };

    const proxyReq = https.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', () => {
      res.writeHead(502);
      res.end('Bad Gateway');
    });

    if (body) proxyReq.write(body);
    proxyReq.end();
  }

  private buildStat(params: {
    body: AnthropicRequestBody;
    originalModel: string;
    finalModel: string;
    inputTokens: number;
    outputTokens: number;
    savedByCompression: number;
    savedByCache: number;
    cacheHit: boolean;
    modelDowngraded: boolean;
    techniques: string[];
  }): RequestStat {
    const costUSD = this.router.estimateCost(params.finalModel, params.inputTokens, params.outputTokens);
    const savedCostUSD = this.router.estimateSavings(
      params.originalModel,
      params.finalModel,
      params.inputTokens,
      params.outputTokens
    ) + (params.savedByCompression / 1_000_000) * 3.0;

    return {
      timestamp: Date.now(),
      model: params.finalModel,
      originalModel: params.originalModel,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      savedTokensByCompression: params.savedByCompression,
      savedTokensByCache: params.savedByCache,
      cacheHit: params.cacheHit,
      modelDowngraded: params.modelDowngraded,
      costUSD,
      savedCostUSD,
      techniques: params.techniques,
    };
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
