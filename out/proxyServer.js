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
const piiFilter_1 = require("./piiFilter");
const contextCompactor_1 = require("./contextCompactor");
const ANTHROPIC_HOST = 'api.anthropic.com';
const MAX_TRACES = 200;
class ProxyServer {
    getTraces(n = 50) {
        return this.traces.slice(-n).reverse();
    }
    setOnTrace(cb) { this.onTrace = cb; }
    setOnPiiDetected(cb) { this.onPiiDetected = cb; }
    setOnRestartHost(cb) { this.onRestartHost = cb; }
    constructor(config, cache, optimizer, router, tokenCounter, stats, log) {
        this.server = null;
        this.traces = [];
        this.compactor = new contextCompactor_1.ContextCompactor();
        this.config = config;
        this.cache = cache;
        this.optimizer = optimizer;
        this.router = router;
        this.tokenCounter = tokenCounter;
        this.stats = stats;
        this.log = log ?? ((msg) => console.log(msg));
        this.piiFilter = new piiFilter_1.PiiFilter({ enabled: config.enablePiiRedaction });
        // Capture original https.request NOW (before NetworkInterceptor patches it)
        this.httpsRequest = https.request.bind(https);
    }
    start() {
        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => {
                if (req.method === 'POST')
                    this.log(`>> ${req.method} ${req.url}`);
                // Safety net: if anything hangs, respond after 60s rather than blocking forever
                const timeout = setTimeout(() => {
                    if (!res.headersSent) {
                        this.log(`ERROR: Request timeout — raw passthrough to Anthropic`);
                        res.writeHead(504, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: { message: 'Proxy timeout', type: 'proxy_error' } }));
                    }
                }, 60000);
                this.handleRequest(req, res)
                    .catch(err => {
                    this.log(`ERROR: Proxy error: ${err}`);
                    if (!res.headersSent) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: { message: 'Proxy internal error', type: 'proxy_error' } }));
                    }
                })
                    .finally(() => clearTimeout(timeout));
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
            if (!this.server) {
                resolve();
                return;
            }
            const s = this.server;
            this.server = null; // mark as stopped so isRunning() returns false immediately
            // closeAllConnections() (Node 18.2+) force-closes keep-alive sockets so close() resolves promptly
            if (typeof s.closeAllConnections === 'function') {
                s.closeAllConnections();
            }
            s.close(() => resolve());
        });
    }
    isRunning() {
        return this.server !== null && this.server.listening;
    }
    updateConfig(config) {
        this.config = { ...this.config, ...config };
        this.router.setEnabled(config.enableModelRouter ?? this.config.enableModelRouter);
        if (config.modelRouterMode !== undefined) {
            this.router.setConfig({ mode: config.modelRouterMode });
        }
    }
    toggle() {
        this.config.enabled = !this.config.enabled;
        return this.config.enabled;
    }
    isEnabled() {
        return this.config.enabled;
    }
    async handleRequest(req, res) {
        // Health-check used by the NetworkInterceptor self-test
        if (req.url === '/health' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, port: this.config.port }));
            return;
        }
        // Stats/traces served from the proxy port so multi-window ownership works:
        // whoever owns :8787 also owns the authoritative stats.
        if (req.url === '/proxy-stats' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify(this.stats.getSessionStats()));
            return;
        }
        if (req.url === '/proxy-traces' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify(this.getTraces()));
            return;
        }
        if (req.url === '/proxy-clear' && req.method === 'POST') {
            this.stats.clear();
            this.traces = [];
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        if (req.url === '/proxy-restart-host' && req.method === 'POST') {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ ok: true }));
            setTimeout(() => this.onRestartHost?.(), 300);
            return;
        }
        const rawBody = await readBody(req);
        // Internal calls (classify, summarize) — bypass all optimization to prevent loops
        if (req.headers['x-steward-internal']) {
            this.forwardRaw(req, rawBody, res);
            return;
        }
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
        this.log(`[VIA PROXY] model=${body.model} stream=${body.stream}`);
        // ── OPTIMIZATION PIPELINE ────────────────────────────────────────────────
        // Everything below is wrapped in try/catch. If any optimization step fails,
        // we fall back to forwarding the sanitized (but otherwise unmodified) request.
        const isStreaming = body.stream === true;
        // ── GREETING SHORT-CIRCUIT ────────────────────────────────────────────────
        // Only intercept bare single-message greetings (not internal title-gen calls which also have no system prompt but have history)
        const lastMsg = this.extractLastUserMessage(body);
        const isSingleMessage = body.messages.length === 1 && !body.system;
        if (this.isGreeting(lastMsg) && isSingleMessage) {
            this.log(`[VIA PROXY] Greeting intercepted — not forwarded to Anthropic`);
            if (isStreaming) {
                this.greetingResponseSSE(body, res);
            }
            else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(this.greetingResponse(body)));
            }
            return;
        }
        let techniques = [];
        let modelDowngraded = false;
        let routingReason = 'passthrough';
        const originalModel = body.model;
        let optimizedBody = body;
        const requestStart = Date.now();
        // Hoisted so the streaming callback (outside the try block) can read it.
        let originalTokens = this.tokenCounter.countRequest(body).prompt;
        let compressedTokens = originalTokens;
        try {
            // Token count (re-use the already-computed value above)
            this.log(`[VIA PROXY] tokens=${originalTokens}`);
            // 1. Cache check — only for non-streaming requests
            if (this.config.enableCache && !isStreaming) {
                const cacheResult = this.cache.lookup(body, originalTokens);
                if (cacheResult.hit && cacheResult.response) {
                    this.log(`[VIA PROXY] CACHE HIT — not forwarded to Anthropic`);
                    const cacheHitStat = this.buildStat({
                        body, originalModel: body.model, finalModel: body.model,
                        inputTokens: originalTokens, outputTokens: cacheResult.response?.usage?.output_tokens ?? 0,
                        cacheReadTokens: 0, cacheCreationTokens: 0,
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
            // 2. PII redaction
            const piiResult = this.piiFilter.filter(optimizedBody);
            if (piiResult.count > 0) {
                this.log(`[pii] Redacted ${piiResult.count} value(s): ${piiResult.types.join(', ')}`);
                optimizedBody = piiResult.body;
                techniques.push('pii-redact');
                this.onPiiDetected?.(piiResult.types);
            }
            // 3. Prompt optimization + model routing run in parallel — classifier no longer
            //    adds serial latency on top of compression work.
            const reqApiKey = req.headers['x-api-key'] ||
                req.headers['authorization']?.replace(/^Bearer\s+/i, '') ||
                this.config.apiKey;
            // Context compaction — summarize old turns when conversation is long
            const compaction = this.compactor.compact(optimizedBody, reqApiKey);
            if (compaction.compacted) {
                optimizedBody = compaction.body;
            }
            const [, routingResult] = await Promise.all([
                // Compression (sync but wrapped so it runs concurrently with routing await)
                Promise.resolve().then(() => {
                    if (this.config.enableCompression) {
                        const result = this.optimizer.optimize(optimizedBody);
                        optimizedBody = result.body;
                        techniques.push(...result.techniques);
                        compressedTokens = this.tokenCounter.countRequest(optimizedBody).prompt;
                    }
                }),
                // Routing (async — makes Haiku classifier call on cache miss)
                this.config.enableModelRouter
                    ? this.router.route(optimizedBody, reqApiKey)
                    : Promise.resolve(null),
            ]);
            // 4. Apply routing decision
            if (this.config.enableModelRouter && routingResult) {
                const routing = routingResult;
                optimizedBody.model = routing.selectedModel;
                modelDowngraded = routing.downgraded;
                routingReason = routing.reason;
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
            this.log(`WARN: Optimization failed, forwarding original to Anthropic: ${e}`);
            optimizedBody = body;
        }
        // Sanitize is now done at every forward point (forwardRaw, forwardToAnthropic, forwardStreaming)
        this.log(`[VIA PROXY → ANTHROPIC] model=${optimizedBody.model}${modelDowngraded ? ` (routed from ${originalModel})` : ''}`);
        // ── FORWARD ──────────────────────────────────────────────────────────────
        // If anything goes wrong forwarding the optimized body, fall back to the
        // original raw request as an absolute last resort.
        try {
            if (isStreaming) {
                this.forwardStreaming(req, optimizedBody, res, (inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens) => {
                    const finalInputTokens = inputTokens || originalTokens;
                    // Savings = what our optimizer removed (before vs after compression), not Anthropic's cache discount.
                    const actualSavedByCompression = Math.max(0, originalTokens - compressedTokens);
                    this.stats.record(this.buildStat({
                        body: optimizedBody, originalModel, finalModel: optimizedBody.model,
                        inputTokens: finalInputTokens, outputTokens,
                        cacheReadTokens, cacheCreationTokens,
                        savedByCompression: actualSavedByCompression, savedByCache: 0, cacheHit: false, modelDowngraded, techniques,
                    }));
                    this.recordTrace({
                        originalModel, finalModel: optimizedBody.model, routingReason,
                        inputTokens: finalInputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
                        savedByCompression: actualSavedByCompression, techniques, streaming: true, requestStart,
                        messagePreview: lastMsg.slice(0, 80),
                    });
                });
            }
            else {
                const response = await this.forwardWithFallback(req, optimizedBody);
                // Last resort: if optimized request errored and it was modified, retry with raw
                if (response?.error && optimizedBody !== body) {
                    this.log(`WARN: Optimized request failed, retrying original → Anthropic`);
                    this.forwardRaw(req, rawBody, res);
                    return;
                }
                const inputTokens = response?.usage?.input_tokens ?? originalTokens;
                const outputTokens = response?.usage?.output_tokens ?? 0;
                const cacheReadTokens = response?.usage?.cache_read_input_tokens ?? 0;
                const cacheCreationTokens = response?.usage?.cache_creation_input_tokens ?? 0;
                // Savings = what our optimizer removed (before vs after compression), not Anthropic's cache discount.
                const actualSavedByCompression = Math.max(0, originalTokens - compressedTokens);
                if (this.config.enableCache && !response?.error) {
                    this.cache.store(optimizedBody, response, inputTokens);
                }
                this.stats.record(this.buildStat({
                    body: optimizedBody, originalModel, finalModel: optimizedBody.model,
                    inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
                    savedByCompression: actualSavedByCompression,
                    savedByCache: 0, cacheHit: false, modelDowngraded, techniques,
                }));
                this.recordTrace({
                    originalModel, finalModel: optimizedBody.model, routingReason,
                    inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
                    savedByCompression: actualSavedByCompression, techniques, streaming: false, requestStart,
                    messagePreview: lastMsg.slice(0, 80),
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(response));
            }
        }
        catch (e) {
            this.log(`ERROR: Forward failed, raw passthrough → Anthropic: ${e}`);
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
                this.log(`WARN: ${currentBody.model} rejected (${response.error.message?.slice(0, 60)}), escalating → ${nextModel}`);
                currentBody = { ...currentBody, model: nextModel };
                // If thinking isn't enabled, strip all extended-thinking / context fields on escalation
                if (!currentBody.thinking || (currentBody.thinking.type !== 'enabled' && currentBody.thinking.type !== 'adaptive')) {
                    delete currentBody.strategy;
                    delete currentBody.thinking;
                    delete currentBody.context_management;
                    delete currentBody.output_config;
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
            const proxyReq = this.httpsRequest({
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
                            this.log(`WARN: Streaming: ${currentBody.model} rejected (${parsed?.error?.message?.slice(0, 60)}), escalating → ${nextModel}`);
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
                            onDone(0, 0, 0, 0);
                        }
                    });
                    return;
                }
                res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
                let inputTokens = 0;
                let outputTokens = 0;
                let cacheReadTokens = 0;
                let cacheCreationTokens = 0;
                // tail: sliding 2KB window used only for output_tokens (last occurrence wins).
                // input/cache tokens appear once near stream start — captured per-chunk before sliding.
                let tail = '';
                proxyRes.on('data', (chunk) => {
                    res.write(chunk);
                    const str = chunk.toString();
                    // Capture start-of-stream fields on first occurrence (appear in message_start)
                    if (inputTokens === 0) {
                        const m = str.match(/"input_tokens":(\d+)/);
                        if (m)
                            inputTokens = parseInt(m[1]);
                    }
                    if (cacheReadTokens === 0) {
                        const m = str.match(/"cache_read_input_tokens":(\d+)/);
                        if (m)
                            cacheReadTokens = parseInt(m[1]);
                    }
                    if (cacheCreationTokens === 0) {
                        const m = str.match(/"cache_creation_input_tokens":(\d+)/);
                        if (m)
                            cacheCreationTokens = parseInt(m[1]);
                    }
                    // output_tokens: keep last value seen (message_delta overwrites message_start's placeholder)
                    tail = (tail + str).slice(-2048);
                    const om = tail.match(/(?:.*"output_tokens":(\d+))/s);
                    if (om) {
                        const v = parseInt(om[1]);
                        if (v > outputTokens)
                            outputTokens = v;
                    }
                });
                proxyRes.on('end', () => { res.end(); onDone(inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens); });
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
            const proxyReq = this.httpsRequest({
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
    extractLastUserMessage(body) {
        const last = [...body.messages].reverse().find(m => m.role === 'user');
        if (!last)
            return '';
        if (typeof last.content === 'string')
            return last.content;
        if (Array.isArray(last.content)) {
            return last.content.filter((b) => b?.type === 'text').map((b) => b.text).join(' ');
        }
        return '';
    }
    isGreeting(msg) {
        return /^\s*(hi+|hello+|hey+|howdy|greetings|sup|yo|hiya|good\s+(morning|afternoon|evening)|what'?s\s+up)\s*[!?.]*\s*$/i.test(msg.trim());
    }
    greetingResponseSSE(body, res) {
        const replies = [
            "Oh good, a greeting. My favourite. What are we actually building today?",
            "Hi. Tokens spent: ~5. Was it worth it? Let's get to work.",
            "Revolutionary opener. What's the real question?",
            "Hello to you too. Now — what needs fixing?",
        ];
        const text = replies[Math.floor(Math.random() * replies.length)];
        const msgId = `msg_steward_${Date.now()}`;
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        send('message_start', { type: 'message_start', message: {
                id: msgId, type: 'message', role: 'assistant', content: [],
                model: body.model, stop_reason: null, stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 0 }
            } });
        send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        res.write('event: ping\ndata: {"type":"ping"}\n\n');
        send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
        send('content_block_stop', { type: 'content_block_stop', index: 0 });
        send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: text.split(' ').length } });
        send('message_stop', { type: 'message_stop' });
        res.end();
    }
    greetingResponse(body) {
        const replies = [
            "Oh good, a greeting. My favourite. What are we actually building today?",
            "Hi. Tokens spent: ~5. Was it worth it? Let's get to work.",
            "Revolutionary opener. What's the real question?",
            "Hello to you too. Now — what needs fixing?",
        ];
        const text = replies[Math.floor(Math.random() * replies.length)];
        return {
            id: `msg_steward_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [{ type: 'text', text }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: text.split(' ').length },
        };
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
        const proxyReq = this.httpsRequest(options, (proxyRes) => {
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
    recordTrace(params) {
        const routingSavings = this.router.estimateSavings(params.originalModel, params.finalModel, params.inputTokens, params.outputTokens, params.cacheReadTokens, params.cacheCreationTokens);
        const compressionSavings = (params.savedByCompression / 1000000) * this.router.inputPriceFor(params.originalModel);
        // Only count savings from our tool: routing + compression. Anthropic's own prompt-cache
        // discounts are not our savings — they happen regardless of this extension.
        const savedCostUSD = routingSavings + compressionSavings;
        if (params.originalModel !== params.finalModel) {
            const pct = params.originalModel && params.finalModel
                ? ` (${((routingSavings / Math.max(0.000001, routingSavings + this.router.estimateCost(params.finalModel, params.inputTokens, params.outputTokens, params.cacheReadTokens, params.cacheCreationTokens))) * 100).toFixed(0)}% cheaper)`
                : '';
            this.log(`[route] ${params.originalModel.replace('claude-', '')} → ${params.finalModel.replace('claude-', '')} | reason: ${params.routingReason} | saved $${routingSavings.toFixed(4)}${pct}`);
        }
        const originalTokens = params.inputTokens + params.cacheReadTokens + params.cacheCreationTokens + params.savedByCompression;
        const trace = {
            id: Math.random().toString(36).slice(2, 8),
            timestamp: Date.now(),
            originalModel: params.originalModel,
            finalModel: params.finalModel,
            routingReason: params.routingReason,
            inputTokens: params.inputTokens,
            outputTokens: params.outputTokens,
            cacheReadTokens: params.cacheReadTokens,
            cacheCreationTokens: params.cacheCreationTokens,
            savedByCompression: params.savedByCompression,
            originalTokens,
            savedCostUSD,
            savedCostByCompression: compressionSavings,
            savedCostByRouting: routingSavings,
            techniques: params.techniques,
            streaming: params.streaming,
            durationMs: Date.now() - params.requestStart,
            messagePreview: params.messagePreview ?? '',
            cacheHit: params.techniques.includes('semantic-cache'),
        };
        this.traces.push(trace);
        if (this.traces.length > MAX_TRACES)
            this.traces.shift();
        this.onTrace?.(trace);
    }
    buildStat(params) {
        // Cache hits don't incur API costs since they're served from proxy cache
        const costUSD = params.cacheHit ? 0 : this.router.estimateCost(params.finalModel, params.inputTokens, params.outputTokens, params.cacheReadTokens, params.cacheCreationTokens);
        // Savings sources (extension-driven only — Anthropic's built-in prompt cache is excluded
        // because it happens regardless of whether this extension is running):
        //   1. Model routing:  cheaper model selected → delta between original and final model cost
        //   2. Compression:    tokens eliminated before sending → saved at original model's input rate
        const savedCostByRouting = this.router.estimateSavings(params.originalModel, params.finalModel, params.inputTokens, params.outputTokens, params.cacheReadTokens, params.cacheCreationTokens);
        const savedCostByCompression = (params.savedByCompression / 1000000) * this.router.inputPriceFor(params.originalModel);
        const savedCostUSD = savedCostByRouting + savedCostByCompression;
        return {
            timestamp: Date.now(),
            model: params.finalModel,
            originalModel: params.originalModel,
            inputTokens: params.inputTokens,
            outputTokens: params.outputTokens,
            cacheReadTokens: params.cacheReadTokens,
            cacheCreationTokens: params.cacheCreationTokens,
            savedTokensByCompression: params.savedByCompression,
            savedTokensByCache: params.savedByCache,
            cacheHit: params.cacheHit,
            modelDowngraded: params.modelDowngraded,
            costUSD,
            savedCostUSD,
            savedCostByCompression,
            savedCostByRouting,
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
