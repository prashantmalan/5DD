// Standalone proxy worker — forked as a detached child process by the extension host.
// Survives VS Code extension host restarts; communicates with parent via one-shot IPC
// then switches to HTTP-only (parent polls :8787 and :8788).
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { TokenCounter } from './tokenCounter';
import { PromptOptimizer } from './promptOptimizer';
import { SemanticCache } from './semanticCache';
import { ModelRouter } from './modelRouter';
import { ProxyServer, ProxyConfig, MessageTrace } from './proxyServer';
import { DashboardServer } from './dashboard/dashboardServer';
import { WorkerStats } from './workerStats';
import { ModelRouterConfig } from './modelRouter';

export interface WorkerConfig {
  proxy: ProxyConfig;
  dashboardPort: number;
  cacheThreshold: number;
  routerConfig: ModelRouterConfig;
}

const PID_FILE = path.join(os.tmpdir(), 'claude-steward.pid');

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (!raw) { console.error('[Worker] No config arg'); process.exit(1); }
  const cfg: WorkerConfig = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));

  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
  const cleanup = (): never => {
    try { fs.unlinkSync(PID_FILE); } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
  process.on('exit', () => { try { fs.unlinkSync(PID_FILE); } catch {} });

  const log = (msg: string) =>
    process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${msg}\n`);

  const stats      = new WorkerStats();
  const tc         = new TokenCounter();
  await Promise.race([
    tc.init(),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('TokenCounter init timeout')), 10_000)),
  ]);
  const cache      = new SemanticCache(cfg.cacheThreshold);
  const optimizer  = new PromptOptimizer(tc);
  const router     = new ModelRouter(cfg.routerConfig);

  const proxy = new ProxyServer(cfg.proxy, cache, optimizer, router, tc, stats, log);

  const dashboard = new DashboardServer(
    stats, cfg.dashboardPort, () => proxy.getTraces() as MessageTrace[], cfg.proxy.port
  );

  proxy.setOnTrace(trace => {
    dashboard.pushEvent('request', {
      cacheHit: trace.cacheHit,
      modelDowngraded: trace.originalModel !== trace.finalModel,
      savedCostUSD: trace.savedCostUSD,
    });
  });

  proxy.setOnRestart(() => {
    proxy.stop().then(() => proxy.start()).catch(e => log(`Restart error: ${e}`));
  });
  proxy.setOnShutdown(cleanup);

  await proxy.start();
  try { await dashboard.start(); } catch (e: any) {
    log(`Dashboard port ${cfg.dashboardPort} in use — dashboard skipped: ${e.message}`);
  }

  // Tell parent we're ready; parent will disconnect IPC so we become independent.
  if (process.send) {
    process.send({ type: 'ready', port: cfg.proxy.port });
  }

  log(`Worker PID=${process.pid} proxy=:${cfg.proxy.port} dashboard=:${cfg.dashboardPort}`);
}

main().catch(err => {
  process.stderr.write(`[Worker] Fatal: ${err}\n`);
  process.exit(1);
});
