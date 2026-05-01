import * as http from 'http';

// ── Model-tier helpers ────────────────────────────────────────────────────────

export type ModelTier = 'haiku' | 'sonnet' | 'opus' | 'unknown';

export function modelTier(model: string): ModelTier {
  if (model.includes('haiku')) return 'haiku';
  if (model.includes('sonnet')) return 'sonnet';
  if (model.includes('opus')) return 'opus';
  return 'unknown';
}

export function tierRank(tier: ModelTier): number {
  return tier === 'haiku' ? 0 : tier === 'sonnet' ? 1 : tier === 'opus' ? 2 : 1;
}

// ── sanitizeThinkingFields ────────────────────────────────────────────────────
// Ensures thinking/strategy/effort consistency before forwarding.
// Mutates body in place and optionally cleans thinking-beta headers on req.

export function sanitizeThinkingFields(body: any, req?: http.IncomingMessage): any {
  const hasValidThinking =
    body.thinking &&
    (body.thinking.type === 'enabled' || body.thinking.type === 'adaptive');

  if (!hasValidThinking) {
    delete body.strategy;
    delete body.thinking;
    delete body.context_management;
    delete body.output_config;
    // effort is only valid alongside thinking blocks
    delete body.effort;
    if (req?.headers['anthropic-beta']) {
      const cleaned = (Array.isArray(req.headers['anthropic-beta'])
        ? req.headers['anthropic-beta']
        : [req.headers['anthropic-beta'] as string])
        .flatMap((b: string) => b.split(',').map(s => s.trim()))
        .filter((b: string) => !b.toLowerCase().includes('thinking'));
      if (cleaned.length > 0) {
        req.headers['anthropic-beta'] = cleaned.join(',');
      } else {
        delete req.headers['anthropic-beta'];
      }
    }
  } else if (body.effort === 'x_high' && body.model && !body.model.includes('opus')) {
    // x_high effort is only supported on Opus; downgrade for Haiku/Sonnet
    body.effort = 'high';
  }

  return body;
}

// ── Haiku-specific stripping ──────────────────────────────────────────────────
// Called after routing decides to downgrade to Haiku.

export function stripHaikuUnsupported(body: any, req?: http.IncomingMessage): void {
  delete body.thinking;
  delete body.strategy;
  delete body.betas;
  delete body.effort;
  delete body.context_management;
  delete body.output_config;
  delete body.priority;

  if (body.max_tokens && body.max_tokens > 8192) {
    body.max_tokens = 8192;
  }

  // Remove thinking blocks from message history
  if (body.messages) {
    body.messages = body.messages.map((msg: any) => {
      if (!Array.isArray(msg.content)) return msg;
      const filtered = msg.content.filter(
        (b: any) => b?.type !== 'thinking' && b?.type !== 'redacted_thinking'
      );
      return filtered.length === msg.content.length ? msg : { ...msg, content: filtered };
    });
  }

  // Scrub thinking-related beta headers
  if (req?.headers['anthropic-beta']) {
    const cleaned = (Array.isArray(req.headers['anthropic-beta'])
      ? req.headers['anthropic-beta']
      : [req.headers['anthropic-beta'] as string])
      .flatMap(b => b.split(',').map(s => s.trim()))
      .filter(b => !b.toLowerCase().includes('thinking'));
    if (cleaned.length > 0) {
      req.headers['anthropic-beta'] = cleaned.join(',');
    } else {
      delete req.headers['anthropic-beta'];
    }
  }
}
