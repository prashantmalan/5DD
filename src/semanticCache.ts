/**
 * Semantic Cache
 * Caches Claude responses and returns them for sufficiently similar prompts.
 * Uses TF-IDF cosine similarity for fast local matching (no external embeddings needed).
 *
 * Design notes:
 *  - Semantic key is the LAST USER MESSAGE only (not full history / system prompt).
 *    Two different conversations asking the same question should match.
 *  - IDF is maintained incrementally: a termDf map is updated on each store(),
 *    so lookup is O(N * terms) rather than O(N² * terms).
 *  - Prompt text is stored on the entry at write-time; corpus() is never called.
 */

import NodeCache from 'node-cache';
import { AnthropicRequestBody } from './tokenCounter';

interface CacheEntry {
  request: AnthropicRequestBody;
  response: any;
  promptKey: string;
  promptText: string;   // last-user-message text, pre-extracted at store-time
  cachedTf: Map<string, number>;  // pre-computed normalized TF — avoids re-tokenizing on every lookup
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

  // Incremental IDF: maps term → number of documents containing it
  private termDf = new Map<string, number>();

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

    if (this.entries.length === 0) return { hit: false };

    // Semantic match — compare last-user-message only
    const queryText = this.extractLastUserMessage(body);
    const N = this.entries.length + 1;
    const queryVec = this.tfidfVector(queryText, N);

    let bestMatch: CacheEntry | null = null;
    let bestSimilarity = 0;

    for (const entry of this.entries) {
      if (entry.request.model !== body.model) continue;
      const entryVec = this.tfidfVectorFromTf(entry.cachedTf, N);
      const sim = cosineSimilarity(queryVec, entryVec);
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
    const promptText = this.extractLastUserMessage(body);

    // Update incremental IDF
    const seenTerms = new Set(tokenize(promptText));
    for (const term of seenTerms) {
      this.termDf.set(term, (this.termDf.get(term) ?? 0) + 1);
    }

    const entry: CacheEntry = {
      request: body,
      response,
      promptKey: key,
      promptText,
      cachedTf: buildTf(promptText),
      tokens,
      timestamp: Date.now(),
      hits: 0
    };
    this.cache.set(key, entry);
    this.entries.push(entry);

    // Keep entries list bounded — evict lowest-hit entries
    if (this.entries.length > 500) {
      const evicted = this.entries
        .sort((a, b) => a.hits - b.hits)
        .slice(0, 100);
      // Undo their DF contributions
      for (const e of evicted) {
        for (const term of new Set(tokenize(e.promptText))) {
          const df = (this.termDf.get(term) ?? 1) - 1;
          if (df <= 0) this.termDf.delete(term);
          else this.termDf.set(term, df);
        }
      }
      this.entries = this.entries
        .sort((a, b) => b.hits - a.hits)
        .slice(0, 400);
    }
  }

  clear(): void {
    this.cache.flushAll();
    this.entries = [];
    this.termDf.clear();
  }

  getStats() {
    return {
      size: this.entries.length,
      totalHits: this.totalHits,
      totalSavedTokens: this.totalSavedTokens
    };
  }

  /** Exact-match key: model + hash of last user message */
  private buildKey(body: AnthropicRequestBody): string {
    const text = this.extractLastUserMessage(body);
    return `${body.model}:${simpleHash(text)}`;
  }

  /** Extract only the last user-role message text for semantic matching */
  private extractLastUserMessage(body: AnthropicRequestBody): string {
    // Walk backwards to find the last user message
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const msg = body.messages[i];
      if (msg.role !== 'user') continue;
      if (typeof msg.content === 'string') return msg.content.toLowerCase();
      if (Array.isArray(msg.content)) {
        return msg.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join(' ')
          .toLowerCase();
      }
    }
    return '';
  }

  /** TF-IDF vector from raw text — used for the query vector at lookup time */
  private tfidfVector(text: string, N: number): Map<string, number> {
    return this.tfidfVectorFromTf(buildTf(text), N);
  }

  /** TF-IDF vector from a pre-computed TF map — used for cached entries (no re-tokenizing) */
  private tfidfVectorFromTf(tf: Map<string, number>, N: number): Map<string, number> {
    const vector = new Map<string, number>();
    for (const [term, freq] of tf) {
      const df = (this.termDf.get(term) ?? 0) + 1;
      const idf = Math.log(N / df);
      vector.set(term, freq * idf);
    }
    return vector;
  }

  updateThreshold(threshold: number): void {
    this.threshold = threshold;
  }
}

// --- Helpers ---

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2);
}

/** Build normalized TF map from text — stored on entry at write-time */
function buildTf(text: string): Map<string, number> {
  const tokens = tokenize(text);
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  // Normalize by total token count so frequency is comparable across entries of different lengths
  for (const [t, c] of tf) tf.set(t, c / (tokens.length || 1));
  return tf;
}

function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const [term, valA] of a) {
    const valB = b.get(term) ?? 0;
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
