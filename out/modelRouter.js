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
// Model pricing per 1M tokens (input / output)
const MODEL_COSTS = {
    'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
    'claude-haiku-4-5': { input: 0.80, output: 4.00 },
    'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
    'claude-opus-4-6': { input: 15.00, output: 75.00 },
};
const MODEL_HIERARCHY = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-6'];
const CLASSIFIER_PROMPT = `Classify the complexity of this user request. Reply with ONLY one word:

simple   = greeting, thanks, trivial yes/no, one-liner
moderate = coding task, debugging, explanation, analysis, file edits
complex  = multi-system architecture, deep research, very long multi-step implementation

Request: "{{MESSAGE}}"

Reply:`;
class ModelRouter {
    constructor(config = true) {
        this.routingLog = [];
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
        // No message text — keep original
        if (!lastMessage.trim()) {
            return { selectedModel: originalModel, reason: 'no message text', downgraded: false };
        }
        // Classify via Haiku — prefer key from the incoming request so the proxy
        // works even when claudeOptimizer.anthropicApiKey is not configured in settings
        const apiKey = requestApiKey || this.config.apiKey || process.env.ANTHROPIC_API_KEY || '';
        if (!apiKey) {
            return { selectedModel: originalModel, reason: 'no api key for classifier', downgraded: false };
        }
        let complexity;
        try {
            complexity = await withTimeout(this.classify(lastMessage, apiKey), 2000);
        }
        catch (err) {
            console.warn('[ModelRouter] Classifier skipped (timeout or error):', err.message);
            return { selectedModel: originalModel, reason: 'classifier skipped', downgraded: false };
        }
        const targetModel = this.complexityToModel(complexity);
        const finalModel = this.applyConstraints(targetModel, originalModel);
        const downgraded = this.modelRank(finalModel) < this.modelRank(originalModel);
        return {
            selectedModel: finalModel,
            reason: `classifier: ${complexity}`,
            downgraded,
        };
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
        switch (complexity) {
            case 'simple': return 'claude-haiku-4-5-20251001';
            case 'moderate': return 'claude-sonnet-4-6';
            case 'complex': return this.config.allowOpus ? 'claude-opus-4-6' : 'claude-sonnet-4-6';
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
