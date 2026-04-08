/**
 * Token Counter
 * Estimates token counts for Claude messages using cl100k_base encoding.
 * Claude uses a BPE tokenizer similar to GPT-4; this gives a close estimate.
 */

export interface TokenCount {
  prompt: number;
  estimated: boolean;
}

// Simple regex-based tokenizer for environments where tiktoken isn't available
function roughTokenCount(text: any): number {
  if (!text) return 0;
  const str = typeof text === 'string' ? text : JSON.stringify(text);
  const words = str.split(/\s+/).length;
  const chars = str.length;
  return Math.ceil((words * 1.3 + chars / 5) / 2);
}

export class TokenCounter {
  private encoder: any = null;
  private ready = false;

  async init(): Promise<void> {
    try {
      // Try to load tiktoken for accurate counts
      const tiktoken = await import('tiktoken');
      this.encoder = tiktoken.get_encoding('cl100k_base');
      this.ready = true;
    } catch {
      // Fallback to rough estimate
      this.ready = false;
    }
  }

  count(text: string): TokenCount {
    if (this.ready && this.encoder) {
      try {
        const tokens = this.encoder.encode(text);
        return { prompt: tokens.length, estimated: false };
      } catch {
        return { prompt: roughTokenCount(text), estimated: true };
      }
    }
    return { prompt: roughTokenCount(text), estimated: true };
  }

  countMessages(messages: Array<{ role: string; content: string | any[] }>): TokenCount {
    let total = 0;
    // Claude API overhead per message
    const PER_MESSAGE_OVERHEAD = 4;
    const BASE_OVERHEAD = 3;

    for (const msg of messages) {
      const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      const count = this.count(text);
      total += count.prompt + PER_MESSAGE_OVERHEAD;
    }
    total += BASE_OVERHEAD;

    return { prompt: total, estimated: !this.ready };
  }

  countRequest(body: AnthropicRequestBody): TokenCount {
    let total = 0;

    if (body.system) {
      const sys = typeof body.system === 'string' ? body.system : JSON.stringify(body.system);
      total += this.count(sys).prompt;
    }

    if (body.messages) {
      total += this.countMessages(body.messages).prompt;
    }

    return { prompt: total, estimated: !this.ready };
  }

  dispose(): void {
    if (this.encoder) {
      try {
        this.encoder.free();
      } catch {}
    }
  }
}

export interface AnthropicRequestBody {
  model: string;
  messages: Array<{ role: string; content: string | any[] }>;
  system?: string | any[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  [key: string]: any;
}
