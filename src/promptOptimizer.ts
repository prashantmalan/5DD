/**
 * Prompt Optimizer
 * Reduces token usage by compressing prompts without losing meaning.
 */

import { AnthropicRequestBody, TokenCounter } from './tokenCounter';

export interface OptimizationResult {
  body: AnthropicRequestBody;
  originalTokens: number;
  optimizedTokens: number;
  savedTokens: number;
  techniques: string[];
}

export class PromptOptimizer {
  constructor(private tokenCounter: TokenCounter) {}

  optimize(body: AnthropicRequestBody): OptimizationResult {
    const originalTokens = this.tokenCounter.countRequest(body).prompt;
    const techniques: string[] = [];

    let optimized = JSON.parse(JSON.stringify(body)) as AnthropicRequestBody;

    // 1. Normalize whitespace in system prompt
    if (optimized.system && typeof optimized.system === 'string') {
      const before = optimized.system.length;
      optimized.system = this.compressWhitespace(optimized.system);
      if (optimized.system.length < before) {
        techniques.push('whitespace-compression');
      }
    }

    // 2. Compress each message
    for (let i = 0; i < optimized.messages.length; i++) {
      const msg = optimized.messages[i];
      if (typeof msg.content === 'string') {
        msg.content = this.compressWhitespace(msg.content);
        msg.content = this.removeRedundantPhrases(msg.content);
      }
    }

    // 3. Trim context window — keep last N messages + first system context
    const maxMessages = 20;
    if (optimized.messages.length > maxMessages) {
      optimized = this.trimContext(optimized, maxMessages);
      techniques.push('context-trim');
    }

    // 4. Deduplicate repeated content in messages
    optimized = this.deduplicateContent(optimized);

    const optimizedTokens = this.tokenCounter.countRequest(optimized).prompt;
    const savedTokens = Math.max(0, originalTokens - optimizedTokens);

    if (savedTokens > 0 && !techniques.includes('whitespace-compression')) {
      techniques.push('content-dedup');
    }

    return { body: optimized, originalTokens, optimizedTokens, savedTokens, techniques };
  }

  private compressWhitespace(text: string): string {
    return text
      .replace(/\r\n/g, '\n')           // normalize line endings
      .replace(/\n{3,}/g, '\n\n')       // max 2 consecutive blank lines
      .replace(/[ \t]{2,}/g, ' ')       // collapse multiple spaces/tabs
      .replace(/^\s+|\s+$/g, '')        // trim leading/trailing
      .replace(/\n +/g, '\n')           // remove indentation from plain prose
      .trim();
  }

  private removeRedundantPhrases(text: string): string {
    const fillers = [
      // Verbose preambles that add zero information
      /^(Sure,?\s+|Of course,?\s+|Certainly,?\s+|Absolutely,?\s+)/gi,
      /^(I'd be happy to help you with that\.?\s*)/gi,
      /^(As an AI language model,?\s+)/gi,
      /^(As a helpful assistant,?\s+)/gi,
      // Trailing filler
      /(Is there anything else I can help you with\??\s*)$/gi,
      /(Let me know if you (need|have) any (more |other )?questions\.?\s*)$/gi,
      /(Feel free to ask if you need (more |further )?clarification\.?\s*)$/gi,
    ];

    let result = text;
    for (const pattern of fillers) {
      result = result.replace(pattern, '');
    }
    return result.trim();
  }

  private trimContext(body: AnthropicRequestBody, maxMessages: number): AnthropicRequestBody {
    if (body.messages.length <= maxMessages) return body;

    const messages = body.messages;
    const recentMessages = messages.slice(-maxMessages);

    // Build a summary of dropped messages
    const droppedCount = messages.length - maxMessages;
    const summaryMsg = {
      role: 'user' as const,
      content: `[Context note: ${droppedCount} earlier messages were summarized to save tokens. The conversation continues below.]`
    };

    return {
      ...body,
      messages: [summaryMsg, ...recentMessages]
    };
  }

  private deduplicateContent(body: AnthropicRequestBody): AnthropicRequestBody {
    // Find large repeated blocks (e.g. same code block pasted multiple times)
    const seen = new Map<string, number>();
    const messages = body.messages.map((msg, idx) => {
      if (typeof msg.content !== 'string') return msg;

      // Extract code blocks and large text blocks
      const blocks = msg.content.match(/```[\s\S]{100,}?```/g) || [];

      let content = msg.content;
      for (const block of blocks) {
        const hash = simpleHash(block);
        if (seen.has(hash)) {
          // Replace duplicate block with a reference
          content = content.replace(block, `[same code as message ${seen.get(hash)! + 1}]`);
        } else {
          seen.set(hash, idx);
        }
      }

      return { ...msg, content };
    });

    return { ...body, messages };
  }

  optimizeSystemPrompt(systemPrompt: string): string {
    let optimized = this.compressWhitespace(systemPrompt);

    // Remove duplicate instructions (same sentence appearing twice)
    const sentences = optimized.split(/\.\s+/);
    const unique = [...new Set(sentences)];
    optimized = unique.join('. ');

    return optimized;
  }
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
