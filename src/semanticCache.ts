/**
 * Semantic Cache
 * Caches Claude responses and returns them for sufficiently similar prompts.
 * Uses TF-IDF cosine similarity for fast local matching (no external embeddings needed).
 */

import NodeCache from 'node-cache';
import { AnthropicRequestBody } from './tokenCounter';

interface CacheEntry {
  request: AnthropicRequestBody;
  response: any;
  promptKey: string;
  tokens: number;
  timestamp: number;
  hits: number;
}

export interface CacheResult {
  hit: boolean;
  response?: any;
  similarity?: number;
  savedTokens?: number;
}

export class SemanticCache {
  private cache: NodeCache;
  private entries: CacheEntry[] = [];
  private threshold: number;
  private totalSavedTokens = 0;
  private totalHits = 0;

  constructor(threshold = 0.92, ttlSeconds = 3600) {
    this.threshold = threshold;
    this.cache = new NodeCache({ stdTTL: ttlSeconds, checkperiod: 300 });
  }

  lookup(body: AnthropicRequestBody, estimatedTokens: number): CacheResult {
    const key = this.buildKey(body);

    // Exact match first (fastest)
    const exact = this.cache.get<CacheEntry>(key);
    if (exact) {
      exact.hits++;
      this.totalHits++;
      this.totalSavedTokens += estimatedTokens;
      return { hit: true, response: exact.response, similarity: 1.0, savedTokens: estimatedTokens };
    }

    // Semantic match
    const promptText = this.extractPromptText(body);
    let bestMatch: CacheEntry | null = null;
    let bestSimilarity = 0;

    for (const entry of this.entries) {
      if (entry.request.model !== body.model) continue;
      const sim = cosineSimilarity(
        tfidfVector(promptText, this.corpus()),
        tfidfVector(this.extractPromptText(entry.request), this.corpus())
      );
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

  store(body: AnthropicRequestBody, response: any, tokens: number): void {
    const key = this.buildKey(body);
    const entry: CacheEntry = {
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

  clear(): void {
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

  private buildKey(body: AnthropicRequestBody): string {
    const lastMessage = body.messages[body.messages.length - 1];
    const content = typeof lastMessage.content === 'string'
      ? lastMessage.content
      : JSON.stringify(lastMessage.content);
    return `${body.model}:${simpleHash(content)}`;
  }

  private extractPromptText(body: AnthropicRequestBody): string {
    const parts: string[] = [];
    if (body.system) parts.push(typeof body.system === 'string' ? body.system : JSON.stringify(body.system));
    for (const msg of body.messages) {
      if (typeof msg.content === 'string') parts.push(msg.content);
    }
    return parts.join(' ').toLowerCase();
  }

  private corpus(): string[] {
    return this.entries.map(e => this.extractPromptText(e.request));
  }

  updateThreshold(threshold: number): void {
    this.threshold = threshold;
  }
}

// --- TF-IDF Cosine Similarity ---

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2);
}

function tfidfVector(text: string, corpus: string[]): Map<string, number> {
  const tokens = tokenize(text);
  const tf = new Map<string, number>();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) || 0) + 1);
  }

  const vector = new Map<string, number>();
  const N = corpus.length + 1;

  for (const [term, count] of tf) {
    const df = corpus.filter(doc => doc.includes(term)).length + 1;
    const idf = Math.log(N / df);
    vector.set(term, (count / tokens.length) * idf);
  }

  return vector;
}

function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
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

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}
