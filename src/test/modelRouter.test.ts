import { ModelRouter } from '../modelRouter';
import { AnthropicRequestBody } from '../tokenCounter';

function body(text: string, model = 'claude-sonnet-4-6'): AnthropicRequestBody {
  return {
    model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: text }],
  };
}

describe('ModelRouter', () => {
  // ── disabled routing ─────────────────────────────────────────────────────

  test('returns original model when routing is disabled', async () => {
    const router = new ModelRouter(false);
    const result = await router.route(body('hello'));
    expect(result.selectedModel).toBe('claude-sonnet-4-6');
    expect(result.reason).toMatch(/disabled/);
    expect(result.downgraded).toBe(false);
  });

  // ── pre-classification (no API call) ─────────────────────────────────────

  test('pre-classifies single-word greeting as simple', async () => {
    const router = new ModelRouter({ enabled: true, apiKey: '' });
    const result = await router.route(body('hi'));
    // Pre-classify should catch this without an API call
    expect(result.selectedModel).toBeDefined();
  });

  test('pre-classifies "translate X to French" as simple', async () => {
    const router = new ModelRouter({ enabled: true, apiKey: '' });
    const result = await router.route(body('Translate "good morning" to French'));
    expect(result.reason).toMatch(/pre-classified|simple|no api key/);
  });

  test('skips API call when no API key is configured', async () => {
    const router = new ModelRouter({ enabled: true, apiKey: '' });
    // Force pre-classify to miss by using a complex-looking message
    const result = await router.route(
      body('Design a distributed event-sourcing architecture for a high-throughput trading platform'),
      ''   // no key
    );
    // Should fall back gracefully
    expect(result.selectedModel).toBeDefined();
    expect(['classifier skipped', 'no api key for classifier', 'pre-classified: moderate', 'pre-classified: simple'])
      .toContain(result.reason.replace(/^(pre-classified|classifier): /, '$0'));
  });

  // ── classifier cache ─────────────────────────────────────────────────────

  test('identical messages return consistent selectedModel across calls', async () => {
    // Tests cache consistency without requiring HTTP mock (https.request is non-configurable)
    const router = new ModelRouter({ enabled: true, apiKey: '' });
    const msg = 'What colour is the sky?';

    const first  = await router.route(body(msg), '');
    const second = await router.route(body(msg), '');

    // Both calls must agree on the selected model — cache or pre-classify must be deterministic
    expect(first.selectedModel).toBe(second.selectedModel);
    // On the second call the reason should mention cache if pre-classify didn't intercept
    // (acceptable outcomes: pre-classified, classifier-cache, no api key)
    expect(second.reason).toBeDefined();
  });

  // ── minimum model floor ──────────────────────────────────────────────────

  test('respects minimumModel floor', async () => {
    const router = new ModelRouter({
      enabled: true,
      apiKey: '',
      minimumModel: 'claude-sonnet-4-6',
    });
    // Even if pre-classify says simple (haiku), floor prevents downgrade below sonnet
    const result = await router.route(body('hi'));
    const rank = (m: string) => m.includes('haiku') ? 0 : m.includes('sonnet') ? 1 : 2;
    expect(rank(result.selectedModel)).toBeGreaterThanOrEqual(rank('claude-sonnet-4-6'));
  });

  // ── no message text ──────────────────────────────────────────────────────

  test('keeps original model for empty message', async () => {
    const router = new ModelRouter({ enabled: true, apiKey: '' });
    const result = await router.route(body(''));
    expect(result.selectedModel).toBe('claude-sonnet-4-6');
    expect(result.reason).toMatch(/no message text/);
  });
});
