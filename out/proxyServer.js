"use strict";
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
exports.ProxyServer = void 0;
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const ANTHROPIC_HOST = 'api.anthropic.com';
class ProxyServer {
    constructor(config, cache, optimizer, router, tokenCounter, stats) {
        this.server = null;
        this.config = config;
        this.cache = cache;
        this.optimizer = optimizer;
        this.router = router;
        this.tokenCounter = tokenCounter;
        this.stats = stats;
    }
    start() {
        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => {
                console.log(`[Claude Optimizer] >> ${req.method} ${req.url} enabled=${this.config.enabled}`);
                this.handleRequest(req, res).catch(err => {
                    console.error('[Claude Optimizer] Proxy error:', err);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'Proxy internal error', type: 'proxy_error' } }));
                });
            });
            this.server.on('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    reject(new Error(`Port ${this.config.port} is already in use. Change claudeOptimizer.proxyPort in settings.`));
                }
                else {
                    reject(err);
                }
            });
            this.server.listen(this.config.port, '127.0.0.1', () => {
                resolve();
            });
        });
    }
    stop() {
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => resolve());
                this.server = null;
            }
            else {
                resolve();
            }
        });
    }
    isRunning() {
        return this.server !== null && this.server.listening;
    }
    updateConfig(config) {
        this.config = { ...this.config, ...config };
        this.router.setEnabled(config.enableModelRouter ?? this.config.enableModelRouter);
    }
    toggle() {
        this.config.enabled = !this.config.enabled;
        return this.config.enabled;
    }
    isEnabled() {
        return this.config.enabled;
    }
    async handleRequest(req, res) {
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
        let body;
        try {
            body = JSON.parse(rawBody);
        }
        catch {
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
        let techniques = [];
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
        }
        else {
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
    forwardStreaming(req, body, res, onDone) {
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
            proxyRes.on('data', (chunk) => {
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
    forwardToAnthropic(req, body) {
        return new Promise((resolve, reject) => {
            const bodyStr = JSON.stringify(body);
            const headers = this.buildForwardHeaders(req, bodyStr);
            const proxyReq = https.request({
                hostname: ANTHROPIC_HOST, port: 443,
                path: req.url || '/v1/messages', method: 'POST', headers
            }, (proxyRes) => {
                let data = '';
                proxyRes.on('data', (chunk) => { data += chunk; });
                proxyRes.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    }
                    catch {
                        resolve(data);
                    }
                });
            });
            proxyReq.on('error', reject);
            proxyReq.write(bodyStr);
            proxyReq.end();
        });
    }
    // Build headers for forwarding — pass ALL original headers, fix host + content-length
    buildForwardHeaders(req, bodyStr) {
        const headers = {};
        for (const [key, val] of Object.entries(req.headers)) {
            if (val !== undefined)
                headers[key] = val;
        }
        headers['host'] = ANTHROPIC_HOST;
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(Buffer.byteLength(bodyStr));
        // Fallback: if no auth header at all, try config key
        if (!headers['authorization'] && !headers['x-api-key']) {
            const key = this.config.apiKey || process.env.ANTHROPIC_API_KEY || '';
            if (key)
                headers['x-api-key'] = key;
        }
        return headers;
    }
    forwardRaw(req, body, res) {
        const options = {
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
        if (body)
            proxyReq.write(body);
        proxyReq.end();
    }
    buildStat(params) {
        const costUSD = this.router.estimateCost(params.finalModel, params.inputTokens, params.outputTokens);
        const savedCostUSD = this.router.estimateSavings(params.originalModel, params.finalModel, params.inputTokens, params.outputTokens) + (params.savedByCompression / 1000000) * 3.0;
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
exports.ProxyServer = ProxyServer;
function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => resolve(data));
        req.on('error', reject);
    });
}
