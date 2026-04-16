import { StatsTracker, RequestStat, SessionStats } from '../statsTracker';

// ── vscode ExtensionContext mock ────────────────────────────────────────────
const store: Record<string, any> = {};
const mockContext = {
  workspaceState: {
    get: (key: string, def: any) => store[key] ?? def,
    update: (key: string, val: any) => { store[key] = val; },
  },
} as any;

function makeStat(overrides: Partial<RequestStat> = {}): RequestStat {
  return {
    timestamp: Date.now(),
    model: 'claude-sonnet-4-6',
    originalModel: 'claude-sonnet-4-6',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    savedTokensByCompression: 0,
    savedTokensByCache: 0,
    cacheHit: false,
    modelDowngraded: false,
    costUSD: 0.001,
    savedCostUSD: 0,
    savedCostByCompression: 0,
    savedCostByRouting: 0,
    techniques: [],
    ...overrides,
  };
}

describe('StatsTracker', () => {
  let tracker: StatsTracker;

  beforeEach(() => {
    Object.keys(store).forEach(k => delete store[k]);
    tracker = new StatsTracker(mockContext);
  });

  test('starts with zero stats', () => {
    const s = tracker.getSessionStats();
    expect(s.totalRequests).toBe(0);
    expect(s.totalCostUSD).toBe(0);
    expect(s.totalInputTokens).toBe(0);
  });

  test('records a request and reflects it in getSessionStats()', () => {
    tracker.record(makeStat({ inputTokens: 200, outputTokens: 100, costUSD: 0.002 }));
    const s = tracker.getSessionStats();
    expect(s.totalRequests).toBe(1);
    expect(s.totalCostUSD).toBeCloseTo(0.002);
    expect(s.totalInputTokens).toBe(200);
    expect(s.totalOutputTokens).toBe(100);
  });

  test('accumulates across multiple records', () => {
    tracker.record(makeStat({ costUSD: 0.001 }));
    tracker.record(makeStat({ costUSD: 0.002 }));
    tracker.record(makeStat({ costUSD: 0.003 }));
    const s = tracker.getSessionStats();
    expect(s.totalRequests).toBe(3);
    expect(s.totalCostUSD).toBeCloseTo(0.006);
  });

  test('excludes cache-hit tokens from totalInputTokens', () => {
    tracker.record(makeStat({ inputTokens: 100, cacheHit: false }));
    tracker.record(makeStat({ inputTokens: 200, cacheHit: true }));  // these should not count
    expect(tracker.getSessionStats().totalInputTokens).toBe(100);
  });

  test('counts cacheHit requests', () => {
    tracker.record(makeStat({ cacheHit: true }));
    tracker.record(makeStat({ cacheHit: false }));
    tracker.record(makeStat({ cacheHit: true }));
    expect(tracker.getSessionStats().cacheHits).toBe(2);
  });

  test('counts modelDowngraded requests', () => {
    tracker.record(makeStat({ modelDowngraded: true }));
    tracker.record(makeStat({ modelDowngraded: true }));
    tracker.record(makeStat({ modelDowngraded: false }));
    expect(tracker.getSessionStats().modelDowngrades).toBe(2);
  });

  test('tracks saved tokens from compression and cache', () => {
    tracker.record(makeStat({ savedTokensByCompression: 30, savedTokensByCache: 20 }));
    tracker.record(makeStat({ savedTokensByCompression: 10, savedTokensByCache: 5 }));
    expect(tracker.getSessionStats().totalSavedTokens).toBe(65);
  });

  test('tracks totalSavedCostUSD', () => {
    tracker.record(makeStat({ savedCostUSD: 0.0005 }));
    tracker.record(makeStat({ savedCostUSD: 0.0003 }));
    expect(tracker.getSessionStats().totalSavedCostUSD).toBeCloseTo(0.0008);
  });

  test('getRecentActivity returns latest N in reverse order', () => {
    for (let i = 0; i < 5; i++) {
      tracker.record(makeStat({ timestamp: i * 1000 }));
    }
    const recent = tracker.getRecentActivity(3);
    expect(recent.length).toBe(3);
    expect(recent[0].timestamp).toBeGreaterThan(recent[1].timestamp);
  });

  test('clear() resets all stats', () => {
    tracker.record(makeStat());
    tracker.clear();
    expect(tracker.getSessionStats().totalRequests).toBe(0);
  });

  test('avgSavingsPct is 0 when nothing was saved', () => {
    tracker.record(makeStat({ savedTokensByCompression: 0, savedTokensByCache: 0, inputTokens: 100 }));
    expect(tracker.getSessionStats().avgSavingsPct).toBe(0);
  });
});
