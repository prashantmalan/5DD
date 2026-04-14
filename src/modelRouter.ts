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

import * as https from 'https';
import { AnthropicRequestBody } from './tokenCounter';

export interface RoutingDecision {
  originalModel: string;
  selectedModel: string;
  reason: string;
  downgraded: boolean;
}

export interface ModelRouterConfig {
  enabled: boolean;
  apiKey?: string;
  minimumModel?: string;
  allowOpus?: boolean;   // default false — Opus is very expensive
}

// Model pricing per 1M tokens (input / output) — sourced from platform.claude.com/docs/en/about-claude/pricing
// Cache writes = input * 1.25 (5-min TTL tier)
// Cache reads  = input * 0.10
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 1.00,  output: 5.00  },
  'claude-haiku-4-5':          { input: 1.00,  output: 5.00  },
  'claude-haiku-3-5':          { input: 0.80,  output: 4.00  },
  'claude-sonnet-4-6':         { input: 3.00,  output: 15.00 },
  'claude-sonnet-4-5':         { input: 3.00,  output: 15.00 },
  'claude-opus-4-6':           { input: 5.00,  output: 25.00 },
  'claude-opus-4-5':           { input: 5.00,  output: 25.00 },
  'claude-opus-4-1':           { input: 15.00, output: 75.00 },
  'claude-opus-4':             { input: 15.00, output: 75.00 },
  'claude-opus-3':             { input: 15.00, output: 75.00 },
};

const MODEL_HIERARCHY = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-6'];

const CLASSIFIER_PROMPT = `Classify the complexity of this user request. Reply with ONLY one word:

simple   = greeting, thanks, trivial yes/no, one-liner, explain/describe/summarize existing code, read-only questions about code, bash/git/log output interpretation
moderate = writing or editing code, debugging, implementing features, file edits, refactoring
complex  = multi-system architecture, deep research, very long multi-step implementation

Request: "{{MESSAGE}}"

Reply:`;

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}

export class ModelRouter {
  private config: ModelRouterConfig;
  private routingLog: RoutingDecision[] = [];
  // LRU-style classifier cache: hash(lastMessage) → complexity
  private classifierCache = new Map<string, 'simple' | 'moderate' | 'complex'>();
  private static readonly CLASSIFIER_CACHE_MAX = 500;

  constructor(config: ModelRouterConfig | boolean = true) {
    if (typeof config === 'boolean') {
      this.config = { enabled: config };
    } else {
      this.config = config;
    }
  }

  async route(body: AnthropicRequestBody, requestApiKey?: string): Promise<RoutingDecision> {
    const originalModel = body.model;

    if (!this.config.enabled) {
      const result: RoutingDecision = { originalModel, selectedModel: originalModel, reason: 'routing disabled', downgraded: false };
      this.routingLog.push(result);
      return result;
    }

    const decision = await this.decide(body, requestApiKey);
    const result: RoutingDecision = { originalModel, ...decision };
    this.routingLog.push(result);
    return result;
  }

  private async decide(body: AnthropicRequestBody, requestApiKey?: string): Promise<Omit<RoutingDecision, 'originalModel'>> {
    const originalModel = body.model;
    const lastMessage = this.extractLastUserMessage(body);

    // No message text — keep original
    if (!lastMessage.trim()) {
      return { selectedModel: originalModel, reason: 'no message text', downgraded: false };
    }

    // Pre-classify locally — no API call needed
    const preClass = this.preClassify(body, lastMessage);
    if (preClass) {
      const finalModel = this.applyConstraints(this.complexityToModel(preClass), originalModel);
      return {
        selectedModel: finalModel,
        reason: `pre-classified: ${preClass}`,
        downgraded: this.modelRank(finalModel) < this.modelRank(originalModel),
      };
    }

    // Check classifier cache first (hash of last user message)
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

    // Classify via Haiku — prefer key from the incoming request so the proxy
    // works even when claudeOptimizer.anthropicApiKey is not configured in settings
    const apiKey = requestApiKey || this.config.apiKey || process.env.ANTHROPIC_API_KEY || '';
    if (!apiKey) {
      return { selectedModel: originalModel, reason: 'no api key for classifier', downgraded: false };
    }

    let complexity: 'simple' | 'moderate' | 'complex';
    try {
      complexity = await withTimeout(this.classify(lastMessage, apiKey), 1500);
    } catch (err) {
      console.warn('[ModelRouter] Classifier skipped (timeout or error):', (err as Error).message);
      return { selectedModel: originalModel, reason: 'classifier skipped', downgraded: false };
    }

    // Store in cache, evict oldest if at capacity
    if (this.classifierCache.size >= ModelRouter.CLASSIFIER_CACHE_MAX) {
      this.classifierCache.delete(this.classifierCache.keys().next().value!);
    }
    this.classifierCache.set(cacheKey, complexity);

    const targetModel = this.complexityToModel(complexity);
    const finalModel = this.applyConstraints(targetModel, originalModel);
    const downgraded = this.modelRank(finalModel) < this.modelRank(originalModel);

    return {
      selectedModel: finalModel,
      reason: `classifier: ${complexity}`,
      downgraded,
    };
  }

  /**
   * Fast local pre-classification — returns a complexity level when the request
   * matches a well-known cheap pattern, skipping the Haiku API call entirely.
   * Returns null to defer to the classifier.
   */
  private preClassify(body: AnthropicRequestBody, lastMessage: string): 'simple' | 'moderate' | null {
    // Bash / git / log tool results → Haiku can handle the follow-up
    if (this.hasBashToolResults(body)) return 'simple';

    // Read-only explanation requests — generic keywords, model-agnostic
    const explainPattern = /\b(explain|describe|understand|summarize|what does|what is|how does|tell me about|overview of|walk me through|clarify|what('s| is) (this|that|the)|show me what)\b/i;
    if (explainPattern.test(lastMessage) && lastMessage.length < 600) return 'simple';

    return null;
  }

  /**
   * Returns true when the last user message is a tool_result response to a
   * Bash-type tool use in the preceding assistant turn.
   */
  private hasBashToolResults(body: AnthropicRequestBody): boolean {
    const msgs = body.messages;
    if (msgs.length < 2) return false;

    const lastMsg = msgs[msgs.length - 1];
    if (lastMsg.role !== 'user' || !Array.isArray(lastMsg.content)) return false;
    if (!lastMsg.content.some((b: any) => b?.type === 'tool_result')) return false;

    const prevMsg = msgs[msgs.length - 2];
    if (!prevMsg || prevMsg.role !== 'assistant' || !Array.isArray(prevMsg.content)) return false;

    return prevMsg.content.some(
      (b: any) => b?.type === 'tool_use' && /^(bash|execute|run_command|terminal|git|shell)/i.test(b.name ?? '')
    );
  }

  private async classify(message: string, apiKey: string): Promise<'simple' | 'moderate' | 'complex'> {
    const prompt = CLASSIFIER_PROMPT.replace('{{MESSAGE}}', message.slice(0, 500)); // cap at 500 chars

    const requestBody = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 5,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = await httpsPost('api.anthropic.com', '/v1/messages', apiKey, requestBody);
    const response = JSON.parse(raw);
    const text = (response?.content?.[0]?.text || '').trim().toLowerCase();

    if (text.startsWith('simple'))   return 'simple';
    if (text.startsWith('complex'))  return 'complex';
    return 'moderate'; // default to moderate if unclear
  }

  private complexityToModel(complexity: 'simple' | 'moderate' | 'complex'): string {
    switch (complexity) {
      case 'simple':   return 'claude-haiku-4-5-20251001';
      case 'moderate': return 'claude-sonnet-4-6';
      case 'complex':  return this.config.allowOpus ? 'claude-opus-4-6' : 'claude-sonnet-4-6';
    }
  }

  private applyConstraints(targetModel: string, _originalModel: string): string {
    // Enforce minimum model floor if set
    if (this.config.minimumModel) {
      if (this.modelRank(this.config.minimumModel) > this.modelRank(targetModel)) {
        return this.config.minimumModel;
      }
    }
    return targetModel;
  }

  private modelRank(model: string): number {
    // Higher rank = more capable
    const idx = MODEL_HIERARCHY.indexOf(model);
    return idx === -1 ? 1 : idx; // unknown models default to sonnet rank
  }

  private extractLastUserMessage(body: AnthropicRequestBody): string {
    const lastUser = [...body.messages].reverse().find(m => m.role === 'user');
    if (!lastUser) return '';

    if (typeof lastUser.content === 'string') return lastUser.content;

    if (Array.isArray(lastUser.content)) {
      return lastUser.content
        .filter((b: any) => b?.type === 'text')
        .map((b: any) => b.text)
        .join(' ');
    }

    return '';
  }

  estimateCost(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens = 0,
    cacheCreationTokens = 0,
  ): number {
    const costs = MODEL_COSTS[model] || MODEL_COSTS['claude-sonnet-4-6'];
    return (inputTokens         / 1_000_000) * costs.input
         + (outputTokens        / 1_000_000) * costs.output
         + (cacheReadTokens     / 1_000_000) * costs.input * 0.10   // Anthropic charges 10%
         + (cacheCreationTokens / 1_000_000) * costs.input * 1.25;  // Anthropic charges 125%
  }

  inputPriceFor(model: string): number {
    return (MODEL_COSTS[model] || MODEL_COSTS['claude-sonnet-4-6']).input;
  }

  estimateSavings(
    originalModel: string,
    routedModel: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens = 0,
    cacheCreationTokens = 0,
  ): number {
    return Math.max(
      0,
      this.estimateCost(originalModel, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens) -
      this.estimateCost(routedModel,   inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens),
    );
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

  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }

  setConfig(config: Partial<ModelRouterConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

function httpsPost(hostname: string, path: string, apiKey: string, body: string): Promise<string> {
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
