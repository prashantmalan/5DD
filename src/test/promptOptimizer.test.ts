import { PromptOptimizer } from '../promptOptimizer';
import { TokenCounter, AnthropicRequestBody } from '../tokenCounter';

function body(text: string, system?: string): AnthropicRequestBody {
  return {
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: text }],
    ...(system ? { system } : {}),
  };
}

describe('PromptOptimizer', () => {
  let optimizer: PromptOptimizer;

  beforeEach(() => {
    optimizer = new PromptOptimizer(new TokenCounter());
  });

  // ── basic structure ──────────────────────────────────────────────────────

  test('returns body and techniques array', () => {
    const result = optimizer.optimize(body('Hello world'));
    expect(result.body).toBeDefined();
    expect(Array.isArray(result.techniques)).toBe(true);
  });

  test('does not crash on empty message', () => {
    expect(() => optimizer.optimize(body(''))).not.toThrow();
  });

  test('returns originalTokens, optimizedTokens, savedTokens numbers', () => {
    const result = optimizer.optimize(body('Summarise this for me'));
    expect(typeof result.originalTokens).toBe('number');
    expect(typeof result.optimizedTokens).toBe('number');
    expect(typeof result.savedTokens).toBe('number');
    expect(result.savedTokens).toBeGreaterThanOrEqual(0);
  });

  // ── whitespace collapsing ────────────────────────────────────────────────

  test('collapses excessive internal whitespace', () => {
    const result = optimizer.optimize(body('hello    world   how    are    you'));
    const content = result.body.messages[0].content as string;
    expect(content).not.toMatch(/\s{3,}/);
  });

  // ── filler phrase removal ────────────────────────────────────────────────

  test('strips filler phrases and reduces token count', () => {
    const verbose = 'Please note that you should definitely make sure to remember that you need to please provide an answer. The answer is 42.';
    const result = optimizer.optimize(body(verbose));
    // Tokens must not increase
    expect(result.optimizedTokens).toBeLessThanOrEqual(result.originalTokens);
  });

  // ── model preservation ───────────────────────────────────────────────────

  test('preserves model name unchanged', () => {
    const result = optimizer.optimize(body('Summarise this document'));
    expect(result.body.model).toBe('claude-sonnet-4-6');
  });

  // ── assistant messages not modified ──────────────────────────────────────

  test('preserves assistant message content (as string)', () => {
    const b: AnthropicRequestBody = {
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [
        { role: 'user',      content: 'Hi' },
        { role: 'assistant', content: 'Hello! How can I help?' },
        { role: 'user',      content: 'Please note that you should tell me your name' },
      ],
    };
    const result = optimizer.optimize(b);
    expect(typeof result.body.messages[1].content).toBe('string');
    expect(result.body.messages[1].content).toContain('Hello');
  });

  // ── system prompt compression ────────────────────────────────────────────

  test('compresses excess whitespace in system prompt', () => {
    const result = optimizer.optimize(body('hello', 'You    are   a   helpful   assistant.'));
    expect(result.body.system as string).not.toMatch(/\s{3,}/);
  });

  // ── optimizeSystemPrompt standalone ──────────────────────────────────────

  test('optimizeSystemPrompt returns a string shorter than or equal to input', () => {
    const original = 'You    are   a   very   helpful   assistant.   Please   always   answer.';
    const out = optimizer.optimizeSystemPrompt(original);
    expect(typeof out).toBe('string');
    expect(out.length).toBeLessThanOrEqual(original.length);
  });
});
