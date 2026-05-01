import { sanitizeThinkingFields, stripHaikuUnsupported, modelTier, tierRank } from '../requestSanitizer';

// ── modelTier ─────────────────────────────────────────────────────────────────

describe('modelTier', () => {
  test('classifies haiku models', () => {
    expect(modelTier('claude-haiku-4-5-20251001')).toBe('haiku');
  });
  test('classifies sonnet models', () => {
    expect(modelTier('claude-sonnet-4-6')).toBe('sonnet');
    expect(modelTier('claude-sonnet-4-5')).toBe('sonnet');
  });
  test('classifies opus models', () => {
    expect(modelTier('claude-opus-4-7')).toBe('opus');
  });
  test('returns unknown for unrecognised strings', () => {
    expect(modelTier('gpt-4o')).toBe('unknown');
  });
});

// ── tierRank ──────────────────────────────────────────────────────────────────

describe('tierRank', () => {
  test('haiku < sonnet < opus', () => {
    expect(tierRank('haiku')).toBeLessThan(tierRank('sonnet'));
    expect(tierRank('sonnet')).toBeLessThan(tierRank('opus'));
  });
});

// ── sanitizeThinkingFields ────────────────────────────────────────────────────

describe('sanitizeThinkingFields — no thinking', () => {
  test('strips effort when thinking is absent', () => {
    const body: any = { model: 'claude-sonnet-4-6', effort: 'x_high' };
    sanitizeThinkingFields(body);
    expect(body.effort).toBeUndefined();
  });

  test('strips effort when thinking is disabled', () => {
    const body: any = { model: 'claude-sonnet-4-6', thinking: { type: 'disabled' }, effort: 'high' };
    sanitizeThinkingFields(body);
    expect(body.effort).toBeUndefined();
    expect(body.thinking).toBeUndefined();
  });

  test('strips strategy when thinking is absent', () => {
    const body: any = { model: 'claude-sonnet-4-6', strategy: 'auto' };
    sanitizeThinkingFields(body);
    expect(body.strategy).toBeUndefined();
  });

  test('strips context_management and output_config when thinking is absent', () => {
    const body: any = { model: 'claude-sonnet-4-6', context_management: {}, output_config: {} };
    sanitizeThinkingFields(body);
    expect(body.context_management).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });

  test('leaves unrelated fields intact', () => {
    const body: any = { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1024 };
    sanitizeThinkingFields(body);
    expect(body.messages).toBeDefined();
    expect(body.max_tokens).toBe(1024);
  });
});

describe('sanitizeThinkingFields — with valid thinking', () => {
  test('preserves effort when thinking is enabled', () => {
    const body: any = { model: 'claude-opus-4-7', thinking: { type: 'enabled', budget_tokens: 2000 }, effort: 'x_high' };
    sanitizeThinkingFields(body);
    expect(body.thinking).toBeDefined();
    expect(body.effort).toBe('x_high');
  });

  test('downgrades x_high effort to high for Sonnet', () => {
    const body: any = { model: 'claude-sonnet-4-6', thinking: { type: 'enabled', budget_tokens: 1000 }, effort: 'x_high' };
    sanitizeThinkingFields(body);
    expect(body.effort).toBe('high');
  });

  test('downgrades x_high effort to high for Haiku', () => {
    const body: any = { model: 'claude-haiku-4-5-20251001', thinking: { type: 'enabled', budget_tokens: 500 }, effort: 'x_high' };
    sanitizeThinkingFields(body);
    expect(body.effort).toBe('high');
  });

  test('keeps high effort unchanged for Sonnet', () => {
    const body: any = { model: 'claude-sonnet-4-6', thinking: { type: 'enabled', budget_tokens: 1000 }, effort: 'high' };
    sanitizeThinkingFields(body);
    expect(body.effort).toBe('high');
  });
});

describe('sanitizeThinkingFields — beta headers', () => {
  function makeReq(betaValue: string | string[]) {
    return { headers: { 'anthropic-beta': betaValue } } as any;
  }

  test('strips thinking-related beta when thinking is absent', () => {
    const req = makeReq('interleaved-thinking-2025-05-14,other-beta');
    sanitizeThinkingFields({ model: 'claude-sonnet-4-6' }, req);
    expect(req.headers['anthropic-beta']).toBe('other-beta');
  });

  test('removes anthropic-beta header entirely when all entries are thinking-related', () => {
    const req = makeReq('interleaved-thinking-2025-05-14');
    sanitizeThinkingFields({ model: 'claude-sonnet-4-6' }, req);
    expect(req.headers['anthropic-beta']).toBeUndefined();
  });

  test('leaves beta header intact when thinking is enabled', () => {
    const req = makeReq('interleaved-thinking-2025-05-14');
    sanitizeThinkingFields({ model: 'claude-opus-4-7', thinking: { type: 'enabled', budget_tokens: 2000 } }, req);
    expect(req.headers['anthropic-beta']).toBe('interleaved-thinking-2025-05-14');
  });
});

// ── stripHaikuUnsupported ─────────────────────────────────────────────────────

describe('stripHaikuUnsupported', () => {
  test('removes thinking, strategy, effort, priority', () => {
    const body: any = {
      model: 'claude-haiku-4-5-20251001',
      thinking: { type: 'enabled', budget_tokens: 500 },
      strategy: 'auto',
      effort: 'high',
      priority: 1,
    };
    stripHaikuUnsupported(body);
    expect(body.thinking).toBeUndefined();
    expect(body.strategy).toBeUndefined();
    expect(body.effort).toBeUndefined();
    expect(body.priority).toBeUndefined();
  });

  test('caps max_tokens at 8192', () => {
    const body: any = { model: 'claude-haiku-4-5-20251001', max_tokens: 16000 };
    stripHaikuUnsupported(body);
    expect(body.max_tokens).toBe(8192);
  });

  test('leaves max_tokens under limit unchanged', () => {
    const body: any = { model: 'claude-haiku-4-5-20251001', max_tokens: 4096 };
    stripHaikuUnsupported(body);
    expect(body.max_tokens).toBe(4096);
  });

  test('strips thinking blocks from message history', () => {
    const body: any = {
      model: 'claude-haiku-4-5-20251001',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '<thoughts>' },
            { type: 'text', text: 'hello' },
          ],
        },
      ],
    };
    stripHaikuUnsupported(body);
    expect(body.messages[0].content).toHaveLength(1);
    expect(body.messages[0].content[0].type).toBe('text');
  });

  test('strips redacted_thinking blocks from message history', () => {
    const body: any = {
      model: 'claude-haiku-4-5-20251001',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'redacted_thinking', data: '...' },
            { type: 'text', text: 'answer' },
          ],
        },
      ],
    };
    stripHaikuUnsupported(body);
    expect(body.messages[0].content).toHaveLength(1);
    expect(body.messages[0].content[0].type).toBe('text');
  });
});
