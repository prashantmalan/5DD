"use strict";
/**
 * Model Router
 * Uses Haiku as a cheap classifier to pick the right model for each request.
 *
 * Waterfall:  Haiku → Sonnet → Opus
 *   simple   → Haiku   (greetings, short Q&A, trivial tasks)
 *   moderate → Sonnet  (coding, analysis, debugging, explanation)
 *   complex  → Opus    (deep architecture, multi-system reasoning)
 *
 * Only the last user message is sent to the classifier — never the full context.
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
exports.ModelRouter = void 0;
const https = __importStar(require("https"));
// Model pricing per 1M tokens (input / output) — sourced from platform.claude.com/docs/en/about-claude/pricing
// Cache writes = input * 1.25 (5-min TTL tier)
// Cache reads  = input * 0.10
const MODEL_COSTS = {
    'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00 },
    'claude-haiku-4-5': { input: 1.00, output: 5.00 },
    'claude-haiku-3-5': { input: 0.80, output: 4.00 },
    'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
    'claude-sonnet-4-5': { input: 3.00, output: 15.00 },
    'claude-opus-4-6': { input: 5.00, output: 25.00 },
    'claude-opus-4-5': { input: 5.00, output: 25.00 },
    'claude-opus-4-1': { input: 15.00, output: 75.00 },
    'claude-opus-4': { input: 15.00, output: 75.00 },
    'claude-opus-3': { input: 15.00, output: 75.00 },
};
const MODEL_HIERARCHY = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-6'];
const CLASSIFIER_PROMPT = `Classify the complexity of this user request. Reply with ONLY one word:

simple   = greeting, thanks, trivial yes/no, one-liner, explain/describe/summarize existing code, read-only questions about code, bash/git/log output interpretation
moderate = writing or editing code, debugging, implementing features, file edits, refactoring
complex  = multi-system architecture, deep research, very long multi-step implementation

Request: "{{MESSAGE}}"

Reply:`;
function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString(36);
}
class ModelRouter {
    constructor(config = true) {
        this.routingLog = [];
        // LRU-style classifier cache: hash(lastMessage) → complexity
        this.classifierCache = new Map();
        if (typeof config === 'boolean') {
            this.config = { enabled: config };
        }
        else {
            this.config = config;
        }
    }
    async route(body, requestApiKey) {
        const originalModel = body.model;
        if (!this.config.enabled) {
            const result = { originalModel, selectedModel: originalModel, reason: 'routing disabled', downgraded: false };
            this.routingLog.push(result);
            return result;
        }
        const decision = await this.decide(body, requestApiKey);
        const result = { originalModel, ...decision };
        this.routingLog.push(result);
        return result;
    }
    async decide(body, requestApiKey) {
        const originalModel = body.model;
        const lastMessage = this.extractLastUserMessage(body);
        // Conservative mode: never downgrade — honour the requested model exactly
        if ((this.config.mode ?? 'balanced') === 'conservative') {
            return { selectedModel: originalModel, reason: 'conservative mode', downgraded: false };
        }
        // No message text — keep original
        if (!lastMessage.trim()) {
            return { selectedModel: originalModel, reason: 'no message text', downgraded: false };
        }
        // Pre-classify locally — instant, no API call
        const preClass = this.preClassify(body, lastMessage);
        if (preClass) {
            const finalModel = this.applyConstraints(this.complexityToModel(preClass), originalModel);
            return {
                selectedModel: finalModel,
                reason: `pre-classified: ${preClass}`,
                downgraded: this.modelRank(finalModel) < this.modelRank(originalModel),
            };
        }
        // Check classifier cache (hash of last user message) — instant
        const cacheKey = simpleHash(lastMessage.slice(0, 500));
        const cached = this.classifierCache.get(cacheKey);
        if (cached) {
            const finalModel = this.applyConstraints(this.complexityToModel(cached), originalModel);
            return {
                selectedModel: finalModel,
                reason: `classifier-cache: ${cached}`,
                downgraded: this.modelRank(finalModel) < this.modelRank(originalModel),
            };
        }
        // No cache hit — fire classification in the background (zero latency for this request).
        // The result will be cached and applied to the NEXT identical/similar message.
        const apiKey = requestApiKey || this.config.apiKey || process.env.ANTHROPIC_API_KEY || '';
        if (apiKey) {
            this.classifyInBackground(lastMessage, cacheKey, apiKey);
        }
        return { selectedModel: originalModel, reason: 'classifier pending (background)', downgraded: false };
    }
    /** Fire-and-forget: classifies the message and stores the result in cache. */
    classifyInBackground(message, cacheKey, apiKey) {
        withTimeout(this.classify(message, apiKey), 4000)
            .then(complexity => {
            if (this.classifierCache.size >= ModelRouter.CLASSIFIER_CACHE_MAX) {
                this.classifierCache.delete(this.classifierCache.keys().next().value);
            }
            this.classifierCache.set(cacheKey, complexity);
        })
            .catch(() => { });
    }
    /**
     * Fast local pre-classification — returns a complexity level when the request
     * matches a well-known cheap pattern, skipping the Haiku API call entirely.
     * Returns null to defer to the classifier.
     */
    preClassify(body, lastMessage) {
        // Bash / git / log / file-read tool results → Haiku can handle the follow-up
        if (this.hasBashToolResults(body))
            return 'simple';
        const msg = lastMessage.trim();
        const short = msg.length < 400;
        // Read-only / explanation requests
        const explainPattern = /\b(explain|describe|understand|summarize|what does|what is|how does|tell me about|overview of|walk me through|clarify|what('s| is) (this|that|the)|show me what|what are|list (all|the)|which files?|where is|find (the|all)|look(ing)? (at|for)|read (the|this|that)|check (the|this)|show (me )?(the|this|that)?)\b/i;
        if (explainPattern.test(msg) && short)
            return 'simple';
        // Very short messages (< 80 chars) that don't contain code-write signals
        const codeWriteSignal = /\b(write|create|implement|add|build|generate|make|refactor|fix|update|change|edit|modify|delete|remove|migrate|convert|port|rewrite)\b/i;
        if (msg.length < 80 && !codeWriteSignal.test(msg))
            return 'simple';
        // Git/terminal one-liners
        const terminalPattern = /^(git |npm |yarn |pnpm |ls |cd |cat |pwd |which |echo |curl |grep |find |chmod |mkdir |cp |mv )/i;
        if (terminalPattern.test(msg) && short)
            return 'simple';
        // Explicit code-write requests → keep on Sonnet
        if (codeWriteSignal.test(msg))
            return 'moderate';
        return null;
    }
    /**
     * Returns true when the last user message is a tool_result response to a
     * Bash-type tool use in the preceding assistant turn.
     */
    hasBashToolResults(body) {
        const msgs = body.messages;
        if (msgs.length < 2)
            return false;
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg.role !== 'user' || !Array.isArray(lastMsg.content))
            return false;
        if (!lastMsg.content.some((b) => b?.type === 'tool_result'))
            return false;
        const prevMsg = msgs[msgs.length - 2];
        if (!prevMsg || prevMsg.role !== 'assistant' || !Array.isArray(prevMsg.content))
            return false;
        return prevMsg.content.some((b) => b?.type === 'tool_use' && /^(bash|execute|run_command|terminal|git|shell)/i.test(b.name ?? ''));
    }
    async classify(message, apiKey) {
        const prompt = CLASSIFIER_PROMPT.replace('{{MESSAGE}}', message.slice(0, 500)); // cap at 500 chars
        const requestBody = JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 5,
            messages: [{ role: 'user', content: prompt }],
        });
        const raw = await httpsPost('api.anthropic.com', '/v1/messages', apiKey, requestBody);
        const response = JSON.parse(raw);
        const text = (response?.content?.[0]?.text || '').trim().toLowerCase();
        if (text.startsWith('simple'))
            return 'simple';
        if (text.startsWith('complex'))
            return 'complex';
        return 'moderate'; // default to moderate if unclear
    }
    complexityToModel(complexity) {
        const mode = this.config.mode ?? 'balanced';
        switch (complexity) {
            case 'simple':
                return 'claude-haiku-4-5-20251001';
            case 'moderate':
                // aggressive: route moderate tasks to Haiku too (max savings, may reduce quality)
                return mode === 'aggressive' ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-6';
            case 'complex':
                return this.config.allowOpus ? 'claude-opus-4-6' : 'claude-sonnet-4-6';
        }
    }
    applyConstraints(targetModel, _originalModel) {
        // Enforce minimum model floor if set
        if (this.config.minimumModel) {
            if (this.modelRank(this.config.minimumModel) > this.modelRank(targetModel)) {
                return this.config.minimumModel;
            }
        }
        return targetModel;
    }
    modelRank(model) {
        // Higher rank = more capable
        const idx = MODEL_HIERARCHY.indexOf(model);
        return idx === -1 ? 1 : idx; // unknown models default to sonnet rank
    }
    extractLastUserMessage(body) {
        const lastUser = [...body.messages].reverse().find(m => m.role === 'user');
        if (!lastUser)
            return '';
        if (typeof lastUser.content === 'string')
            return lastUser.content;
        if (Array.isArray(lastUser.content)) {
            return lastUser.content
                .filter((b) => b?.type === 'text')
                .map((b) => b.text)
                .join(' ');
        }
        return '';
    }
    estimateCost(model, inputTokens, outputTokens, cacheReadTokens = 0, cacheCreationTokens = 0) {
        const costs = MODEL_COSTS[model] || MODEL_COSTS['claude-sonnet-4-6'];
        return (inputTokens / 1000000) * costs.input
            + (outputTokens / 1000000) * costs.output
            + (cacheReadTokens / 1000000) * costs.input * 0.10 // Anthropic charges 10%
            + (cacheCreationTokens / 1000000) * costs.input * 1.25; // Anthropic charges 125%
    }
    inputPriceFor(model) {
        return (MODEL_COSTS[model] || MODEL_COSTS['claude-sonnet-4-6']).input;
    }
    estimateSavings(originalModel, routedModel, inputTokens, outputTokens, cacheReadTokens = 0, cacheCreationTokens = 0) {
        return Math.max(0, this.estimateCost(originalModel, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens) -
            this.estimateCost(routedModel, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens));
    }
    getStats() {
        const downgrades = this.routingLog.filter(r => r.downgraded).length;
        return {
            totalRouted: this.routingLog.length,
            downgrades,
            downgradeRate: this.routingLog.length > 0 ? (downgrades / this.routingLog.length) * 100 : 0,
            log: this.routingLog.slice(-50),
        };
    }
    setEnabled(enabled) {
        this.config.enabled = enabled;
    }
    setConfig(config) {
        this.config = { ...this.config, ...config };
    }
}
exports.ModelRouter = ModelRouter;
ModelRouter.CLASSIFIER_CACHE_MAX = 500;
function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
    ]);
}
function httpsPost(hostname, path, apiKey, body) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname,
            port: 443,
            path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'x-steward-internal': '1', // bypasses proxy optimization loop
            },
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}
