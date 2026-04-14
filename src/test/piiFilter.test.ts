import { PiiFilter } from '../piiFilter';
import { AnthropicRequestBody } from '../tokenCounter';

function makeBody(text: string): AnthropicRequestBody {
  return {
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: text }],
  };
}

describe('PiiFilter', () => {
  let filter: PiiFilter;

  beforeEach(() => {
    filter = new PiiFilter({ enabled: true });
  });

  // ── enabled/disabled ─────────────────────────────────────────────────────

  test('passes body through unchanged when disabled', () => {
    const f = new PiiFilter({ enabled: false });
    const body = makeBody('my email is user@example.com');
    const result = f.filter(body);
    expect(result.count).toBe(0);
    expect((result.body.messages[0].content as string)).toContain('user@example.com');
  });

  // ── email detection ──────────────────────────────────────────────────────

  test('redacts email addresses', () => {
    const result = filter.filter(makeBody('contact me at alice@example.com please'));
    expect(result.count).toBeGreaterThan(0);
    expect(result.types).toContain('email');
    expect((result.body.messages[0].content as string)).not.toContain('alice@example.com');
    expect((result.body.messages[0].content as string)).toMatch(/\[PII:email:[a-z0-9]+\]/);
  });

  test('redacts multiple emails in one message', () => {
    const result = filter.filter(makeBody('from: a@foo.com to: b@bar.org'));
    expect(result.count).toBeGreaterThanOrEqual(2);
  });

  // ── API key detection ────────────────────────────────────────────────────

  test('redacts sk- style API keys', () => {
    const result = filter.filter(makeBody('use key sk-ant-api03-AAABBBCCCDDDEEEFFFGGGHHH1234567890'));
    expect(result.types).toContain('api-key');
    expect((result.body.messages[0].content as string)).not.toContain('sk-ant');
  });

  test('redacts GitHub PATs (ghp_)', () => {
    const result = filter.filter(makeBody('token: ghp_AAABBBCCCDDDEEEFFFGGGHHH123456789012'));
    expect(result.types).toContain('api-key');
  });

  test('redacts AWS access key IDs (AKIA)', () => {
    const result = filter.filter(makeBody('AWS key AKIAIOSFODNN7EXAMPLE'));
    expect(result.types).toContain('api-key');
  });

  // ── phone detection ──────────────────────────────────────────────────────

  test('redacts US phone numbers', () => {
    const result = filter.filter(makeBody('call me at (555) 123-4567'));
    expect(result.types).toContain('phone');
    expect((result.body.messages[0].content as string)).not.toContain('555');
  });

  // ── IPv4 detection ───────────────────────────────────────────────────────

  test('redacts public IPv4 addresses', () => {
    const result = filter.filter(makeBody('server is at 203.0.113.42'));
    expect(result.types).toContain('ipv4');
  });

  test('does NOT redact loopback 127.0.0.1', () => {
    const result = filter.filter(makeBody('proxy runs on 127.0.0.1:8787'));
    expect(result.types).not.toContain('ipv4');
  });

  // ── credit card detection ────────────────────────────────────────────────

  test('redacts a valid Luhn credit card number', () => {
    // 4111 1111 1111 1111 is the canonical Visa test number (Luhn valid)
    const result = filter.filter(makeBody('card: 4111 1111 1111 1111'));
    expect(result.types).toContain('credit-card');
    expect((result.body.messages[0].content as string)).not.toContain('4111');
  });

  test('does NOT redact invalid (non-Luhn) number sequences', () => {
    const result = filter.filter(makeBody('order 1234 5678 9012 3456'));
    // 1234567890123456 fails Luhn check
    expect(result.types).not.toContain('credit-card');
  });

  // ── content block (array) messages ──────────────────────────────────────

  test('redacts PII in content-block array messages', () => {
    const body: AnthropicRequestBody = {
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'my email is ceo@corp.io' },
          { type: 'text', text: 'no secrets here' },
        ],
      }],
    };
    const result = filter.filter(body);
    expect(result.types).toContain('email');
    const blocks = result.body.messages[0].content as any[];
    expect(blocks[0].text).not.toContain('ceo@corp.io');
    expect(blocks[1].text).toBe('no secrets here');
  });

  // ── system prompt ────────────────────────────────────────────────────────

  test('redacts PII in system prompt', () => {
    const body: AnthropicRequestBody = {
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hello' }],
      system: 'You know the admin email is root@secret.internal',
    };
    const result = filter.filter(body);
    expect(result.types).toContain('email');
    expect(result.body.system as string).not.toContain('root@secret.internal');
  });

  // ── redaction counter ────────────────────────────────────────────────────

  test('tracks total redactionCount across multiple filter() calls', () => {
    filter.filter(makeBody('a@b.com'));
    filter.filter(makeBody('c@d.com'));
    expect(filter.redactionCount).toBe(2);
  });
});
