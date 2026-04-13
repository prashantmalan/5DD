/**
 * Network Interceptor
 * Intercepts api.anthropic.com traffic at multiple levels to guarantee that
 * all Anthropic SDK traffic — regardless of how it's bundled — is redirected
 * to the local proxy.
 *
 * Three interception layers (deepest-first wins):
 *  1. undici global dispatcher  — catches Node 18+ fetch even when the SDK
 *                                  has captured a reference to globalThis.fetch
 *  2. globalThis.fetch patch    — catches any code that reads the global each time
 *  3. https.request patch       — catches legacy node-https usage
 */

import * as https from 'https';
import * as http from 'http';

// undici ships with Node ≥ 18.  Import dynamically so we don't hard-fail on
// older Node versions.  We only need ProxyAgent + setGlobalDispatcher.
let undiciSetGlobalDispatcher: ((d: any) => void) | undefined;
let undiciGetGlobalDispatcher: (() => any) | undefined;
let undiciProxyAgent: (new (url: string) => any) | undefined;

try {
  // undici is a built-in in Node ≥ 18; may also be installed as a package
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const u = require('undici') as any;
  undiciSetGlobalDispatcher = u.setGlobalDispatcher;
  undiciGetGlobalDispatcher = u.getGlobalDispatcher;
  undiciProxyAgent = u.ProxyAgent;
} catch {
  // undici not available – skip that layer
}

export class NetworkInterceptor {
  private originalHttpsRequest: typeof https.request;
  private originalFetch: (typeof globalThis.fetch) | undefined;
  private originalUndiciDispatcher: any = null;
  private active = false;
  private log: (msg: string) => void;

  constructor(
    private readonly proxyPort: number,
    logFn?: (msg: string) => void,
  ) {
    this.log = logFn ?? console.log;
    this.originalHttpsRequest = https.request.bind(https);
    this.originalFetch =
      typeof globalThis.fetch === 'function'
        ? globalThis.fetch.bind(globalThis)
        : undefined;
  }

  install(): void {
    if (this.active) return;
    this.active = true;

    const port = this.proxyPort;
    const log = this.log;
    const origHttps = this.originalHttpsRequest;

    log(`[Interceptor] Installing on proxy port ${port}`);

    // ── Layer 1: undici global dispatcher ────────────────────────────────────
    // undici.fetch (which backs Node 18+ globalThis.fetch) reads the global
    // dispatcher at request-time, so patching it here catches traffic even
    // when SDK code already captured a reference to globalThis.fetch.
    if (
      undiciSetGlobalDispatcher &&
      undiciGetGlobalDispatcher &&
      undiciProxyAgent
    ) {
      try {
        this.originalUndiciDispatcher = undiciGetGlobalDispatcher();
        const ProxyAgentCtor = undiciProxyAgent!;

        // Build a custom dispatcher that selectively routes anthropic traffic.
        // undici doesn't have a built-in "conditional proxy" concept, so we
        // subclass the current global dispatcher and override dispatch().
        const self = this;
        class SelectiveProxy {
          dispatch(options: any, handler: any) {
            const origin: string =
              typeof options.origin === 'string'
                ? options.origin
                : options.origin?.toString?.() ?? '';
            if (origin.includes('api.anthropic.com')) {
              log(`[Interceptor/undici] Redirecting ${options.method ?? 'REQ'} ${origin}${options.path ?? ''}`);
              // Replace origin so undici connects to our proxy instead
              const proxyDispatcher = new ProxyAgentCtor(
                `http://127.0.0.1:${port}`,
              );
              return proxyDispatcher.dispatch(options, handler);
            }
            return self.originalUndiciDispatcher.dispatch(options, handler);
          }
          close() { return self.originalUndiciDispatcher?.close?.(); }
          destroy() { return self.originalUndiciDispatcher?.destroy?.(); }
        }
        undiciSetGlobalDispatcher!(new SelectiveProxy());
        log('[Interceptor] undici global dispatcher patched ✓');
      } catch (e: any) {
        log(`[Interceptor] undici patch failed (non-fatal): ${e.message}`);
      }
    } else {
      log('[Interceptor] undici not available – skipping dispatcher layer');
    }

    // ── Layer 2: globalThis.fetch ─────────────────────────────────────────────
    if (this.originalFetch) {
      const origFetch = this.originalFetch;
      globalThis.fetch = function (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : (input as Request).url;

        if (url && url.includes('api.anthropic.com')) {
          log(`[Interceptor/fetch] Redirecting ${url}`);
          const redirected = url.replace(
            /https:\/\/api\.anthropic\.com/,
            `http://127.0.0.1:${port}`,
          );
          const newInput =
            typeof input === 'string'
              ? redirected
              : input instanceof URL
                ? new URL(redirected)
                : new Request(redirected, input as Request);
          return origFetch(newInput, init);
        }
        return origFetch(input, init);
      };
      log('[Interceptor] globalThis.fetch patched ✓');
    } else {
      log('[Interceptor] globalThis.fetch not available – skipping');
    }

    // ── Layer 3: https.request ────────────────────────────────────────────────
    (https as any).request = function (
      urlOrOptions: string | URL | https.RequestOptions,
      optionsOrCallback?:
        | https.RequestOptions
        | ((res: http.IncomingMessage) => void),
      callback?: (res: http.IncomingMessage) => void,
    ): http.ClientRequest {
      if (!isAnthropicHost(urlOrOptions)) {
        return (origHttps as any)(urlOrOptions, optionsOrCallback, callback);
      }

      log(`[Interceptor/https] Redirecting request to proxy`);

      if (
        typeof urlOrOptions === 'string' ||
        urlOrOptions instanceof URL
      ) {
        const u =
          typeof urlOrOptions === 'string'
            ? new URL(urlOrOptions)
            : urlOrOptions;
        const merged: http.RequestOptions =
          typeof optionsOrCallback === 'object' && optionsOrCallback !== null
            ? { ...(optionsOrCallback as http.RequestOptions) }
            : {};
        merged.hostname = '127.0.0.1';
        merged.host = '127.0.0.1';
        merged.port = port;
        merged.path =
          (merged.path ?? '') || u.pathname + u.search;
        merged.method = merged.method ?? 'GET';
        delete (merged as any).servername;
        const cb =
          typeof optionsOrCallback === 'function'
            ? optionsOrCallback
            : callback;
        return http.request(merged, cb);
      }

      const opts: http.RequestOptions = {
        ...(urlOrOptions as https.RequestOptions),
      };
      opts.hostname = '127.0.0.1';
      opts.host = '127.0.0.1';
      opts.port = port;
      delete (opts as any).servername;
      const cb =
        typeof optionsOrCallback === 'function'
          ? optionsOrCallback
          : callback;
      return http.request(opts, cb);
    };
    log('[Interceptor] https.request patched ✓');

    // ── Self-test ─────────────────────────────────────────────────────────────
    this.selfTest().catch(() => {/* swallow */});
  }

  uninstall(): void {
    if (!this.active) return;
    this.active = false;

    (https as any).request = this.originalHttpsRequest;

    if (this.originalFetch) {
      globalThis.fetch = this.originalFetch;
    }

    if (
      undiciSetGlobalDispatcher &&
      this.originalUndiciDispatcher
    ) {
      try {
        undiciSetGlobalDispatcher(this.originalUndiciDispatcher);
      } catch {/* swallow */}
      this.originalUndiciDispatcher = null;
    }

    this.log('[Interceptor] Uninstalled — all patches removed');
  }

  /**
   * Makes a lightweight HTTP probe to verify the proxy is reachable and
   * that at least one interception layer is routing traffic through it.
   */
  async selfTest(): Promise<boolean> {
    const port = this.proxyPort;
    const log = this.log;
    const url = `http://127.0.0.1:${port}/health`;

    return new Promise((resolve) => {
      const req = http.get(url, (res) => {
        log(`[Interceptor/selfTest] Proxy responded ${res.statusCode} — routing OK`);
        res.resume();
        resolve(true);
      });
      req.on('error', (err) => {
        log(`[Interceptor/selfTest] Proxy unreachable: ${err.message}`);
        resolve(false);
      });
      req.setTimeout(3000, () => {
        req.destroy();
        log('[Interceptor/selfTest] Proxy health check timed out');
        resolve(false);
      });
    });
  }
}

function isAnthropicHost(
  urlOrOptions: string | URL | https.RequestOptions,
): boolean {
  if (typeof urlOrOptions === 'string')
    return urlOrOptions.includes('api.anthropic.com');
  if (urlOrOptions instanceof URL)
    return urlOrOptions.hostname === 'api.anthropic.com';
  const h =
    (urlOrOptions as any).hostname ?? (urlOrOptions as any).host ?? '';
  return (
    h === 'api.anthropic.com' || h.startsWith('api.anthropic.com:')
  );
}
