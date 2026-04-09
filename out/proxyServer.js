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
        console.log(`[Claude Optimizer] Incoming: model=${body.model} thinking=${JSON.stringify(body.thinking)} stream=${body.stream}`);
        // ── OPTIMIZATION PIPELINE ────────────────────────────────────────────────
        // Everything below is wrapped in try/catch. If any optimization step fails,
        // we fall back to forwarding the sanitized (but otherwise unmodified) request.
        const isStreaming = body.stream === true;
        let savedByCompression = 0;
        let techniques = [];
        let modelDowngraded = false;
        const originalModel = body.model;
        let optimizedBody = body;
        try {
            // Token count
            const tokenCountResult = this.tokenCounter.countRequest(body);
            const originalTokens = tokenCountResult.prompt;
            console.log(`[Claude Optimizer] Request tokens: ${originalTokens}`);
            // 1. Cache check — only for non-streaming requests
            if (this.config.enableCache && !isStreaming) {
                const cacheResult = this.cache.lookup(body, originalTokens);
                if (cacheResult.hit && cacheResult.response) {
                    console.log(`[Claude Optimizer] Cache HIT`);
                    const cacheHitStat = this.buildStat({
                        body, originalModel: body.model, finalModel: body.model,
                        inputTokens: originalTokens, outputTokens: cacheResult.response?.usage?.output_tokens ?? 0,
                        savedByCompression: 0, savedByCache: originalTokens, cacheHit: true,
                        modelDowngraded: false, techniques: ['cache-hit'],
                    });
                    cacheHitStat.savedCostUSD = this.router.estimateCost(body.model, originalTokens, cacheHitStat.outputTokens);
                    this.stats.record(cacheHitStat);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(cacheResult.response));
                    return;
                }
            }
            // 2. Prompt optimization
            if (this.config.enableCompression) {
                const result = this.optimizer.optimize(body);
                optimizedBody = result.body;
                savedByCompression = result.savedTokens;
                techniques = result.techniques;
            }
            // 3. Model routing
            if (this.config.enableModelRouter) {
                const reqApiKey = req.headers['x-api-key'] ||
                    req.headers['authorization']?.replace(/^Bearer\s+/i, '') ||
                    this.config.apiKey;
                const routing = await this.router.route(optimizedBody, reqApiKey);
                optimizedBody.model = routing.selectedModel;
                modelDowngraded = routing.downgraded;
                // When routing to a model that doesn't support thinking, strip everything related
                if (optimizedBody.model.includes('haiku')) {
                    delete optimizedBody.thinking;
                    delete optimizedBody.strategy;
                    delete optimizedBody.betas;
                    delete optimizedBody.effort;
                    delete optimizedBody.context_management;
                    delete optimizedBody.output_config;
                    // Strip thinking blocks from message history
                    if (optimizedBody.messages) {
                        optimizedBody.messages = optimizedBody.messages.map(msg => {
                            if (!Array.isArray(msg.content))
                                return msg;
                            const filtered = msg.content.filter((b) => b?.type !== 'thinking' && b?.type !== 'redacted_thinking');
                            return filtered.length === msg.content.length ? msg : { ...msg, content: filtered };
                        });
                    }
                    // Scrub thinking betas from headers
                    if (req.headers['anthropic-beta']) {
                        const cleaned = (Array.isArray(req.headers['anthropic-beta'])
                            ? req.headers['anthropic-beta']
                            : [req.headers['anthropic-beta']])
                            .flatMap(b => b.split(',').map(s => s.trim()))
                            .filter(b => !b.toLowerCase().includes('thinking'));
                        if (cleaned.length > 0) {
                            req.headers['anthropic-beta'] = cleaned.join(',');
                        }
                        else {
                            delete req.headers['anthropic-beta'];
                        }
                    }
                }
                // For non-Haiku models: DON'T touch thinking — the original request had it configured correctly
            }
        }
        catch (e) {
            // Optimization failed — fall back to sanitized original body
            console.error('[Claude Optimizer] Optimization pipeline failed, forwarding original:', e);
            optimizedBody = body;
        }
        // Sanitize is now done at every forward point (forwardRaw, forwardToAnthropic, forwardStreaming)
        console.log(`[Claude Optimizer] Pre-forward: model=${optimizedBody.model} thinking=${JSON.stringify(optimizedBody.thinking)} strategy=${JSON.stringify(optimizedBody.strategy)}`);
        // ── FORWARD ──────────────────────────────────────────────────────────────
        // If anything goes wrong forwarding the optimized body, fall back to the
        // original raw request as an absolute last resort.
        try {
            if (isStreaming) {
                this.forwardStreaming(req, optimizedBody, res, (inputTokens, outputTokens) => {
                    const finalInputTokens = inputTokens || this.tokenCounter.countRequest(body).prompt;
                    this.stats.record(this.buildStat({
                        body: optimizedBody, originalModel, finalModel: optimizedBody.model,
                        inputTokens: finalInputTokens, outputTokens, savedByCompression,
                        savedByCache: 0, cacheHit: false, modelDowngraded, techniques,
                    }));
                });
            }
            else {
                const response = await this.forwardWithFallback(req, optimizedBody);
                // Last resort: if optimized request errored and it was modified, retry with raw
                if (response?.error && optimizedBody !== body) {
                    console.warn('[Claude Optimizer] Optimized request failed, retrying with original');
                    this.forwardRaw(req, rawBody, res);
                    return;
                }
                const inputTokens = response?.usage?.input_tokens ?? this.tokenCounter.countRequest(body).prompt;
                const outputTokens = response?.usage?.output_tokens ?? 0;
                if (this.config.enableCache && !response?.error) {
                    this.cache.store(optimizedBody, response, inputTokens);
                }
                this.stats.record(this.buildStat({
                    body: optimizedBody, originalModel, finalModel: optimizedBody.model,
                    inputTokens, outputTokens, savedByCompression,
                    savedByCache: 0, cacheHit: false, modelDowngraded, techniques,
                }));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(response));
            }
        }
        catch (e) {
            console.error('[Claude Optimizer] Forward failed, raw passthrough:', e);
            this.forwardRaw(req, rawBody, res);
        }
    }
    /**
     * Forward non-streaming request, escalating to the next model tier on 400 errors.
     * Escalation order: haiku → sonnet → opus
     */
    async forwardWithFallback(req, body) {
        const MODEL_ESCALATION = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-6'];
        let currentBody = body;
        while (true) {
            const response = await this.forwardToAnthropic(req, currentBody);
            // Success — return as-is
            if (!response?.error)
                return response;
            // On 400 errors, try escalating to the next model
            const currentIdx = MODEL_ESCALATION.indexOf(currentBody.model);
            if (currentIdx !== -1 && currentIdx < MODEL_ESCALATION.length - 1) {
                const nextModel = MODEL_ESCALATION[currentIdx + 1];
                console.warn(`[Claude Optimizer] Model ${currentBody.model} rejected request (${response.error.message?.slice(0, 80)}), escalating to ${nextModel}`);
                currentBody = { ...currentBody, model: nextModel };
                // If thinking isn't enabled, ensure strategy is also stripped on escalation
                if (!currentBody.thinking || (currentBody.thinking.type !== 'enabled' && currentBody.thinking.type !== 'adaptive')) {
                    delete currentBody.strategy;
                    delete currentBody.thinking;
                }
                continue;
            }
            // No escalation possible — return the error response
            return response;
        }
    }
    // Pipe a streaming response — buffers status before committing to client so we can escalate on 400
    forwardStreaming(req, body, res, onDone) {
        const MODEL_ESCALATION = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-6'];
        const attempt = (currentBody) => {
            this.sanitizeThinkingFields(currentBody, req);
            const bodyStr = JSON.stringify(currentBody);
            const headers = this.buildForwardHeaders(req, bodyStr, currentBody.model, currentBody);
            const proxyReq = https.request({
                hostname: ANTHROPIC_HOST,
                port: 443,
                path: req.url || '/v1/messages',
                method: 'POST',
                headers
            }, (proxyRes) => {
                // On 400, try escalating before committing response headers to client
                if (proxyRes.statusCode === 400) {
                    let errData = '';
                    proxyRes.on('data', (c) => { errData += c.toString(); });
                    proxyRes.on('end', () => {
                        let parsed = {};
                        try {
                            parsed = JSON.parse(errData);
                        }
                        catch { }
                        const currentIdx = MODEL_ESCALATION.indexOf(currentBody.model);
                        if (currentIdx !== -1 && currentIdx < MODEL_ESCALATION.length - 1) {
                            const nextModel = MODEL_ESCALATION[currentIdx + 1];
                            console.warn(`[Claude Optimizer] Streaming: ${currentBody.model} rejected (${parsed?.error?.message?.slice(0, 80)}), escalating to ${nextModel}`);
                            const escalated = { ...currentBody, model: nextModel };
                            if (!escalated.thinking || (escalated.thinking.type !== 'enabled' && escalated.thinking.type !== 'adaptive')) {
                                delete escalated.strategy;
                                delete escalated.thinking;
                                delete escalated.context_management;
                                delete escalated.output_config;
                            }
                            attempt(escalated);
                        }
                        else {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(errData);
                            onDone(0, 0);
                        }
                    });
                    return;
                }
                res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
                let buffer = '';
                let inputTokens = 0;
                let outputTokens = 0;
                proxyRes.on('data', (chunk) => {
                    res.write(chunk);
                    buffer += chunk.toString();
                    const inputMatch = buffer.match(/"input_tokens":(\d+)/);
                    const outputMatch = buffer.match(/"output_tokens":(\d+)/);
                    if (inputMatch)
                        inputTokens = parseInt(inputMatch[1]);
                    if (outputMatch)
                        outputTokens = parseInt(outputMatch[1]);
                });
                proxyRes.on('end', () => { res.end(); onDone(inputTokens, outputTokens); });
                proxyRes.on('error', () => res.end());
            });
            proxyReq.on('error', () => { res.writeHead(502); res.end('Bad Gateway'); });
            proxyReq.write(bodyStr);
            proxyReq.end();
        };
        attempt(body);
    }
    forwardToAnthropic(req, body) {
        return new Promise((resolve, reject) => {
            this.sanitizeThinkingFields(body, req);
            const bodyStr = JSON.stringify(body);
            const headers = this.buildForwardHeaders(req, bodyStr, body.model, body);
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
    /**
     * Ensure thinking/strategy consistency in a parsed body.
     * strategy requires thinking.type to be "enabled" or "adaptive".
     * Also strips thinking-related beta headers when thinking is not active.
     */
    sanitizeThinkingFields(body, req) {
        const hasValidThinking = body.thinking &&
            (body.thinking.type === 'enabled' || body.thinking.type === 'adaptive');
        if (!hasValidThinking) {
            delete body.strategy;
            delete body.thinking;
            delete body.context_management;
            delete body.output_config;
            if (req && req.headers['anthropic-beta']) {
                const cleaned = (Array.isArray(req.headers['anthropic-beta'])
                    ? req.headers['anthropic-beta']
                    : [req.headers['anthropic-beta']])
                    .flatMap((b) => b.split(',').map(s => s.trim()))
                    .filter((b) => !b.toLowerCase().includes('thinking'));
                if (cleaned.length > 0) {
                    req.headers['anthropic-beta'] = cleaned.join(',');
                }
                else {
                    delete req.headers['anthropic-beta'];
                }
            }
        }
        return body;
    }
    // Build headers for forwarding — pass ALL original headers, fix host + content-length
    buildForwardHeaders(req, bodyStr, _targetModel, _body) {
        const headers = {};
        for (const [key, val] of Object.entries(req.headers)) {
            if (val !== undefined)
                headers[key] = val;
        }
        // Force uncompressed responses so we can read error bodies as plain text
        headers['accept-encoding'] = 'identity';
        headers['host'] = ANTHROPIC_HOST;
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(Buffer.byteLength(bodyStr));
        // Fallback: if no auth header at all, try config key
        if (!headers['authorization'] && !headers['x-api-key']) {
            const key = this.config.apiKey || process.env.ANTHROPIC_API_KEY || '';
            if (key)
                headers['x-api-key'] = key;
        }
        // Note: thinking betas are stripped in handleRequest when routing to Haiku.
        // Do NOT strip here — the original request needs its betas intact for Sonnet/Opus.
        return headers;
    }
    forwardRaw(req, body, res) {
        // Sanitize thinking/strategy even in raw passthrough to prevent 400 errors
        let finalBody = body;
        try {
            const parsed = JSON.parse(body);
            this.sanitizeThinkingFields(parsed, req);
            finalBody = JSON.stringify(parsed);
        }
        catch {
            // Not JSON — pass through unchanged
        }
        const options = {
            hostname: ANTHROPIC_HOST,
            port: 443,
            path: req.url || '/',
            method: req.method,
            headers: { ...req.headers, host: ANTHROPIC_HOST, 'content-length': String(Buffer.byteLength(finalBody)) }
        };
        const proxyReq = https.request(options, (proxyRes) => {
            res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
            proxyRes.pipe(res);
        });
        proxyReq.on('error', () => {
            res.writeHead(502);
            res.end('Bad Gateway');
        });
        if (finalBody)
            proxyReq.write(finalBody);
        proxyReq.end();
    }
    buildStat(params) {
        // Cache hits don't incur API costs since they're served from cache
        const costUSD = params.cacheHit ? 0 : this.router.estimateCost(params.finalModel, params.inputTokens, params.outputTokens);
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
