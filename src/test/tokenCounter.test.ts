import { TokenCounter, AnthropicRequestBody } from '../tokenCounter';

function body(messages: { role: string; content: string }[], system?: string): AnthropicRequestBody {
  return {
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages,
    ...(system ? { system } : {}),
  };
}

describe('TokenCounter', () => {
  let counter: TokenCounter;

  beforeEach(() => {
    counter = new TokenCounter();
  });

  // ── countRequest ─────────────────────────────────────────────────────────

  test('returns a non-negative token count for a simple message', () => {
    const result = counter.countRequest(body([{ role: 'user', content: 'Hello world' }]));
    expect(result.prompt).toBeGreaterThan(0);
  });

  test('longer message → more tokens than short message', () => {
    const short = counter.countRequest(body([{ role: 'user', content: 'Hi' }]));
    const long  = counter.countRequest(body([{ role: 'user', content: 'Hello, please write a comprehensive essay on the history of computing technology from Charles Babbage to modern GPUs.' }]));
    expect(long.prompt).toBeGreaterThan(short.prompt);
  });

  test('system prompt adds to token count', () => {
    const without = counter.countRequest(body([{ role: 'user', content: 'hello' }]));
    const with_   = counter.countRequest(body([{ role: 'user', content: 'hello' }], 'You are a knowledgeable assistant with expertise in all technical topics.'));
    expect(with_.prompt).toBeGreaterThan(without.prompt);
  });

  test('multi-turn conversation is larger than single turn', () => {
    const single = counter.countRequest(body([{ role: 'user', content: 'What is 2+2?' }]));
    const multi  = counter.countRequest(body([
      { role: 'user',      content: 'What is 2+2?' },
      { role: 'assistant', content: 'The answer is 4.' },
      { role: 'user',      content: 'And what is 4+4?' },
    ]));
    expect(multi.prompt).toBeGreaterThan(single.prompt);
  });

  test('estimated flag is a boolean', () => {
    const result = counter.countRequest(body([{ role: 'user', content: 'test' }]));
    expect(typeof result.estimated).toBe('boolean');
  });
});
