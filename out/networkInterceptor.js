"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.NetworkInterceptor = void 0;
const https = __importStar(require("https"));
const http = __importStar(require("http"));
// undici ships with Node ≥ 18.  Import dynamically so we don't hard-fail on
// older Node versions.  We only need ProxyAgent + setGlobalDispatcher.
let undiciSetGlobalDispatcher;
let undiciGetGlobalDispatcher;
let undiciProxyAgent;
try {
    // undici is a built-in in Node ≥ 18; may also be installed as a package
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const u = require('undici');
    undiciSetGlobalDispatcher = u.setGlobalDispatcher;
    undiciGetGlobalDispatcher = u.getGlobalDispatcher;
    undiciProxyAgent = u.ProxyAgent;
}
catch {
    // undici not available – skip that layer
}
class NetworkInterceptor {
    constructor(proxyPort, logFn) {
        this.proxyPort = proxyPort;
        this.originalUndiciDispatcher = null;
        this.active = false;
        this.log = logFn ?? console.log;
        this.originalHttpsRequest = https.request.bind(https);
        this.originalFetch =
            typeof globalThis.fetch === 'function'
                ? globalThis.fetch.bind(globalThis)
                : undefined;
    }
    install() {
        if (this.active)
            return;
        this.active = true;
        const port = this.proxyPort;
        const log = this.log;
        const origHttps = this.originalHttpsRequest;
        log(`[Interceptor] Installing on proxy port ${port}`);
        // ── Layer 1: undici global dispatcher ────────────────────────────────────
        // undici.fetch (which backs Node 18+ globalThis.fetch) reads the global
        // dispatcher at request-time, so patching it here catches traffic even
        // when SDK code already captured a reference to globalThis.fetch.
        if (undiciSetGlobalDispatcher &&
            undiciGetGlobalDispatcher &&
            undiciProxyAgent) {
            try {
                this.originalUndiciDispatcher = undiciGetGlobalDispatcher();
                const ProxyAgentCtor = undiciProxyAgent;
                // Build a custom dispatcher that selectively routes anthropic traffic.
                // undici doesn't have a built-in "conditional proxy" concept, so we
                // subclass the current global dispatcher and override dispatch().
                const self = this;
                class SelectiveProxy {
                    dispatch(options, handler) {
                        const origin = typeof options.origin === 'string'
                            ? options.origin
                            : options.origin?.toString?.() ?? '';
                        if (origin.includes('api.anthropic.com')) {
                            log(`[Interceptor/undici] Redirecting ${options.method ?? 'REQ'} ${origin}${options.path ?? ''}`);
                            // Replace origin so undici connects to our proxy instead
                            const proxyDispatcher = new ProxyAgentCtor(`http://127.0.0.1:${port}`);
                            return proxyDispatcher.dispatch(options, handler);
                        }
                        return self.originalUndiciDispatcher.dispatch(options, handler);
                    }
                    close() { return self.originalUndiciDispatcher?.close?.(); }
                    destroy() { return self.originalUndiciDispatcher?.destroy?.(); }
                }
                undiciSetGlobalDispatcher(new SelectiveProxy());
                log('[Interceptor] undici global dispatcher patched ✓');
            }
            catch (e) {
                log(`[Interceptor] undici patch failed (non-fatal): ${e.message}`);
            }
        }
        else {
            log('[Interceptor] undici not available – skipping dispatcher layer');
        }
        // ── Layer 2: globalThis.fetch ─────────────────────────────────────────────
        if (this.originalFetch) {
            const origFetch = this.originalFetch;
            globalThis.fetch = function (input, init) {
                const url = typeof input === 'string'
                    ? input
                    : input instanceof URL
                        ? input.href
                        : input.url;
                if (url && url.includes('api.anthropic.com')) {
                    log(`[Interceptor/fetch] Redirecting ${url}`);
                    const redirected = url.replace(/https:\/\/api\.anthropic\.com/, `http://127.0.0.1:${port}`);
                    const newInput = typeof input === 'string'
                        ? redirected
                        : input instanceof URL
                            ? new URL(redirected)
                            : new Request(redirected, input);
                    return origFetch(newInput, init);
                }
                return origFetch(input, init);
            };
            log('[Interceptor] globalThis.fetch patched ✓');
        }
        else {
            log('[Interceptor] globalThis.fetch not available – skipping');
        }
        // ── Layer 3: https.request ────────────────────────────────────────────────
        try {
            const patchedRequest = function (urlOrOptions, optionsOrCallback, callback) {
                if (!isAnthropicHost(urlOrOptions)) {
                    return origHttps(urlOrOptions, optionsOrCallback, callback);
                }
                log(`[Interceptor/https] Redirecting request to proxy`);
                if (typeof urlOrOptions === 'string' ||
                    urlOrOptions instanceof URL) {
                    const u = typeof urlOrOptions === 'string'
                        ? new URL(urlOrOptions)
                        : urlOrOptions;
                    const merged = typeof optionsOrCallback === 'object' && optionsOrCallback !== null
                        ? { ...optionsOrCallback }
                        : {};
                    merged.hostname = '127.0.0.1';
                    merged.host = '127.0.0.1';
                    merged.port = port;
                    merged.path =
                        (merged.path ?? '') || u.pathname + u.search;
                    merged.method = merged.method ?? 'GET';
                    delete merged.servername;
                    const cb = typeof optionsOrCallback === 'function'
                        ? optionsOrCallback
                        : callback;
                    return http.request(merged, cb);
                }
                const opts = {
                    ...urlOrOptions,
                };
                opts.hostname = '127.0.0.1';
                opts.host = '127.0.0.1';
                opts.port = port;
                delete opts.servername;
                const cb = typeof optionsOrCallback === 'function'
                    ? optionsOrCallback
                    : callback;
                return http.request(opts, cb);
            };
            try {
                Object.defineProperty(https, 'request', {
                    value: patchedRequest,
                    writable: true,
                    configurable: true,
                });
            }
            catch {
                https.request = patchedRequest;
            }
            log('[Interceptor] https.request patched ✓');
        }
        catch (e) {
            log(`[Interceptor] https.request patch failed (non-fatal): ${e.message}`);
        }
        // ── Self-test ─────────────────────────────────────────────────────────────
        this.selfTest().catch(() => { });
    }
    uninstall() {
        if (!this.active)
            return;
        this.active = false;
        try {
            Object.defineProperty(https, 'request', {
                value: this.originalHttpsRequest,
                writable: true,
                configurable: true,
            });
        }
        catch {
            try {
                https.request = this.originalHttpsRequest;
            }
            catch { /* swallow */ }
        }
        if (this.originalFetch) {
            globalThis.fetch = this.originalFetch;
        }
        if (undiciSetGlobalDispatcher &&
            this.originalUndiciDispatcher) {
            try {
                undiciSetGlobalDispatcher(this.originalUndiciDispatcher);
            }
            catch { /* swallow */ }
            this.originalUndiciDispatcher = null;
        }
        this.log('[Interceptor] Uninstalled — all patches removed');
    }
    /**
     * Makes a lightweight HTTP probe to verify the proxy is reachable and
     * that at least one interception layer is routing traffic through it.
     */
    async selfTest() {
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
exports.NetworkInterceptor = NetworkInterceptor;
function isAnthropicHost(urlOrOptions) {
    if (typeof urlOrOptions === 'string')
        return urlOrOptions.includes('api.anthropic.com');
    if (urlOrOptions instanceof URL)
        return urlOrOptions.hostname === 'api.anthropic.com';
    const h = urlOrOptions.hostname ?? urlOrOptions.host ?? '';
    return (h === 'api.anthropic.com' || h.startsWith('api.anthropic.com:'));
}
