"use strict";
/**
 * Semantic Cache
 * Caches Claude responses and returns them for sufficiently similar prompts.
 * Uses TF-IDF cosine similarity for fast local matching (no external embeddings needed).
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SemanticCache = void 0;
const node_cache_1 = __importDefault(require("node-cache"));
class SemanticCache {
    constructor(threshold = 0.92, ttlSeconds = 3600) {
        this.entries = [];
        this.totalSavedTokens = 0;
        this.totalHits = 0;
        this.threshold = threshold;
        this.cache = new node_cache_1.default({ stdTTL: ttlSeconds, checkperiod: 300 });
    }
    lookup(body, estimatedTokens) {
        const key = this.buildKey(body);
        // Exact match first (fastest)
        const exact = this.cache.get(key);
        if (exact) {
            exact.hits++;
            this.totalHits++;
            this.totalSavedTokens += estimatedTokens;
            return { hit: true, response: exact.response, similarity: 1.0, savedTokens: estimatedTokens };
        }
        // Semantic match
        const promptText = this.extractPromptText(body);
        let bestMatch = null;
        let bestSimilarity = 0;
        for (const entry of this.entries) {
            if (entry.request.model !== body.model)
                continue;
            const sim = cosineSimilarity(tfidfVector(promptText, this.corpus()), tfidfVector(this.extractPromptText(entry.request), this.corpus()));
            if (sim > bestSimilarity) {
                bestSimilarity = sim;
                bestMatch = entry;
            }
        }
        if (bestMatch && bestSimilarity >= this.threshold) {
            bestMatch.hits++;
            this.totalHits++;
            this.totalSavedTokens += estimatedTokens;
            return {
                hit: true,
                response: bestMatch.response,
                similarity: bestSimilarity,
                savedTokens: estimatedTokens
            };
        }
        return { hit: false, similarity: bestSimilarity };
    }
    store(body, response, tokens) {
        const key = this.buildKey(body);
        const entry = {
            request: body,
            response,
            promptKey: key,
            tokens,
            timestamp: Date.now(),
            hits: 0
        };
        this.cache.set(key, entry);
        this.entries.push(entry);
        // Keep entries list bounded
        if (this.entries.length > 500) {
            this.entries = this.entries
                .sort((a, b) => b.hits - a.hits)
                .slice(0, 400);
        }
    }
    clear() {
        this.cache.flushAll();
        this.entries = [];
    }
    getStats() {
        return {
            size: this.entries.length,
            totalHits: this.totalHits,
            totalSavedTokens: this.totalSavedTokens
        };
    }
    buildKey(body) {
        const lastMessage = body.messages[body.messages.length - 1];
        const content = typeof lastMessage.content === 'string'
            ? lastMessage.content
            : JSON.stringify(lastMessage.content);
        return `${body.model}:${simpleHash(content)}`;
    }
    extractPromptText(body) {
        const parts = [];
        if (body.system)
            parts.push(typeof body.system === 'string' ? body.system : JSON.stringify(body.system));
        for (const msg of body.messages) {
            if (typeof msg.content === 'string')
                parts.push(msg.content);
        }
        return parts.join(' ').toLowerCase();
    }
    corpus() {
        return this.entries.map(e => this.extractPromptText(e.request));
    }
    updateThreshold(threshold) {
        this.threshold = threshold;
    }
}
exports.SemanticCache = SemanticCache;
// --- TF-IDF Cosine Similarity ---
function tokenize(text) {
    return text
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 2);
}
function tfidfVector(text, corpus) {
    const tokens = tokenize(text);
    const tf = new Map();
    for (const t of tokens) {
        tf.set(t, (tf.get(t) || 0) + 1);
    }
    const vector = new Map();
    const N = corpus.length + 1;
    for (const [term, count] of tf) {
        const df = corpus.filter(doc => doc.includes(term)).length + 1;
        const idf = Math.log(N / df);
        vector.set(term, (count / tokens.length) * idf);
    }
    return vector;
}
function cosineSimilarity(a, b) {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (const [term, valA] of a) {
        const valB = b.get(term) || 0;
        dot += valA * valB;
        normA += valA * valA;
    }
    for (const valB of b.values()) {
        normB += valB * valB;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}
function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString(36);
}
