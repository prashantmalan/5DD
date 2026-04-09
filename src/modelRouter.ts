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

// Model pricing per 1M tokens (input / output)
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 0.80,  output: 4.00  },
  'claude-haiku-4-5':          { input: 0.80,  output: 4.00  },
  'claude-sonnet-4-6':         { input: 3.00,  output: 15.00 },
  'claude-opus-4-6':           { input: 15.00, output: 75.00 },
};

const MODEL_HIERARCHY = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-6'];

const CLASSIFIER_PROMPT = `Classify the complexity of this user request. Reply with ONLY one word:

simple   = greeting, thanks, trivial yes/no, one-liner
moderate = coding task, debugging, explanation, analysis, file edits
complex  = multi-system architecture, deep research, very long multi-step implementation

Request: "{{MESSAGE}}"

Reply:`;

export class ModelRouter {
  private config: ModelRouterConfig;
  private routingLog: RoutingDecision[] = [];

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

    // Classify via Haiku — prefer key from the incoming request so the proxy
    // works even when claudeOptimizer.anthropicApiKey is not configured in settings
    const apiKey = requestApiKey || this.config.apiKey || process.env.ANTHROPIC_API_KEY || '';
    if (!apiKey) {
      return { selectedModel: originalModel, reason: 'no api key for classifier', downgraded: false };
    }

    let complexity: 'simple' | 'moderate' | 'complex';
    try {
      complexity = await withTimeout(this.classify(lastMessage, apiKey), 2000);
    } catch (err) {
      console.warn('[ModelRouter] Classifier skipped (timeout or error):', (err as Error).message);
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

  estimateCost(model: string, inputTokens: number, outputTokens: number): number {
    const costs = MODEL_COSTS[model] || MODEL_COSTS['claude-sonnet-4-6'];
    return (inputTokens / 1_000_000) * costs.input + (outputTokens / 1_000_000) * costs.output;
  }

  estimateSavings(originalModel: string, routedModel: string, inputTokens: number, outputTokens: number): number {
    return Math.max(0, this.estimateCost(originalModel, inputTokens, outputTokens) - this.estimateCost(routedModel, inputTokens, outputTokens));
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
