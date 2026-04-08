"use strict";
/**
 * Model Router
 * Automatically selects the cheapest Claude model that can handle the request.
 *
 * Cost tiers (as of 2025):
 *   haiku-4-5     → cheapest  (simple Q&A, formatting, classification)
 *   sonnet-4-6    → mid-tier  (coding, analysis, reasoning)
 *   opus-4-6      → expensive (complex multi-step, deep reasoning)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ModelRouter = void 0;
// Model pricing per 1M tokens (input / output)
const MODEL_COSTS = {
    'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
    'claude-haiku-4-5': { input: 0.80, output: 4.00 },
    'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
    'claude-opus-4-6': { input: 15.00, output: 75.00 },
};
const HAIKU_MODELS = ['claude-haiku-4-5-20251001', 'claude-haiku-4-5'];
const SONNET_MODELS = ['claude-sonnet-4-6'];
const OPUS_MODELS = ['claude-opus-4-6'];
// Keywords/patterns that signal a simple request (safe to route to haiku)
const SIMPLE_PATTERNS = [
    /^(what is|what are|define|explain briefly|list|give me \d+|translate|convert|format|summarize in one|yes or no)/i,
    /^(fix (the |this )?(typo|grammar|spelling))/i,
    /^(rename|reformat|prettify|lint|sort)/i,
    /^(hello|hi|thanks|thank you|ok|okay)/i,
];
// Keywords that require sonnet or higher
const COMPLEX_PATTERNS = [
    /\b(architecture|design pattern|refactor|optimize algorithm|security audit|debug complex)\b/i,
    /\b(implement|build|create|develop).{20,}/i,
    /(step[ -]by[ -]step|detailed explanation|walk me through)/i,
];
// Keywords that require opus
const EXPERT_PATTERNS = [
    /\b(PhD|research paper|mathematical proof|formal verification|write a thesis)\b/i,
    /\b(100[0-9]|[2-9]\d{3})\s*(lines?|loc|functions?)\b/i,
];
class ModelRouter {
    constructor(enabled = true) {
        this.routingLog = [];
        this.enabled = enabled;
    }
    route(body) {
        const originalModel = body.model;
        const decision = this.enabled
            ? this.decide(body)
            : { selectedModel: originalModel, reason: 'routing disabled', downgraded: false };
        const result = { originalModel, ...decision };
        this.routingLog.push(result);
        return result;
    }
    decide(body) {
        const originalModel = body.model;
        const promptText = this.extractText(body);
        const promptLength = promptText.length;
        // Don't downgrade if model is already haiku
        if (HAIKU_MODELS.includes(originalModel)) {
            return { selectedModel: originalModel, reason: 'already optimal', downgraded: false };
        }
        // Check for expert-level complexity
        for (const pattern of EXPERT_PATTERNS) {
            if (pattern.test(promptText)) {
                if (OPUS_MODELS.includes(originalModel)) {
                    return { selectedModel: originalModel, reason: 'expert complexity detected', downgraded: false };
                }
                return { selectedModel: 'claude-opus-4-6', reason: 'expert complexity detected', downgraded: false };
            }
        }
        // Check for complex patterns — needs sonnet at minimum
        for (const pattern of COMPLEX_PATTERNS) {
            if (pattern.test(promptText)) {
                if (SONNET_MODELS.includes(originalModel) || OPUS_MODELS.includes(originalModel)) {
                    return { selectedModel: originalModel, reason: 'complex task, keeping model', downgraded: false };
                }
                return { selectedModel: 'claude-sonnet-4-6', reason: 'complex task pattern', downgraded: false };
            }
        }
        // Long prompts (>2000 chars) suggest complex context — keep sonnet
        if (promptLength > 2000 && !HAIKU_MODELS.includes(originalModel)) {
            return { selectedModel: originalModel, reason: 'long context, keeping model', downgraded: false };
        }
        // Simple patterns → route to haiku
        for (const pattern of SIMPLE_PATTERNS) {
            if (pattern.test(promptText.trim())) {
                return { selectedModel: 'claude-haiku-4-5-20251001', reason: 'simple query pattern', downgraded: true };
            }
        }
        // Short, simple prompts → haiku
        if (promptLength < 200 && body.messages.length <= 2) {
            return { selectedModel: 'claude-haiku-4-5-20251001', reason: 'short simple prompt', downgraded: true };
        }
        // Default: keep original
        return { selectedModel: originalModel, reason: 'no routing rule matched', downgraded: false };
    }
    extractText(body) {
        const parts = [];
        // Only look at the last user message for routing
        const lastUser = [...body.messages].reverse().find(m => m.role === 'user');
        if (lastUser) {
            if (typeof lastUser.content === 'string') {
                parts.push(lastUser.content);
            }
        }
        return parts.join(' ');
    }
    estimateCost(model, inputTokens, outputTokens) {
        const costs = MODEL_COSTS[model] || MODEL_COSTS['claude-sonnet-4-6'];
        return (inputTokens / 1000000) * costs.input + (outputTokens / 1000000) * costs.output;
    }
    estimateSavings(originalModel, routedModel, inputTokens, outputTokens) {
        const originalCost = this.estimateCost(originalModel, inputTokens, outputTokens);
        const routedCost = this.estimateCost(routedModel, inputTokens, outputTokens);
        return Math.max(0, originalCost - routedCost);
    }
    getStats() {
        const downgrades = this.routingLog.filter(r => r.downgraded).length;
        return {
            totalRouted: this.routingLog.length,
            downgrades,
            downgradeRate: this.routingLog.length > 0 ? (downgrades / this.routingLog.length) * 100 : 0,
            log: this.routingLog.slice(-50)
        };
    }
    setEnabled(enabled) {
        this.enabled = enabled;
    }
}
exports.ModelRouter = ModelRouter;
