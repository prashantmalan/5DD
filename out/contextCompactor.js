"use strict";
/**
 * Context Compactor
 * When a conversation grows large (> COMPACT_THRESHOLD turns), uses Haiku to
 * summarize the older turns into a compact block injected into the system prompt.
 * The recent KEEP_RECENT turns are always kept verbatim for continuity.
 *
 * Zero-latency design (same pattern as ModelRouter classifier):
 *   - On cache miss: forward original body this turn, fire Haiku summary in background
 *   - On cache hit:  apply summary instantly (no API call on the hot path)
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
exports.ContextCompactor = void 0;
const https = __importStar(require("https"));
const COMPACT_THRESHOLD = 8; // start compacting after this many message turns
const KEEP_RECENT = 4; // always preserve this many recent turns verbatim
const COMPACT_INTERVAL_MS = 10 * 60 * 1000; // force compaction every 10 minutes
const SUMMARY_PROMPT = `You are a context compactor for an AI coding assistant session.
Summarize the key information from the conversation turns below so the assistant can continue effectively.

Extract and preserve:
- Variables, constants, function/class names that were defined or modified
- File paths and their purpose (what each file contains or does)
- Key decisions made and why
- Current task state: what has been completed, what is still pending
- Important constraints, requirements, or user preferences
- Any errors encountered and how they were resolved

Be concise but complete. Use bullet points. Do not include conversational filler.

Conversation to summarize:
{{TURNS}}

Summary:`;
function quickHash(msgs) {
    // Hash the roles + first 100 chars of each message content
    const key = msgs.map(m => m.role + ':' + contentText(m).slice(0, 100)).join('|');
    let h = 0;
    for (let i = 0; i < key.length; i++) {
        h = Math.imul(31, h) + key.charCodeAt(i) | 0;
    }
    return h.toString(36);
}
function contentText(msg) {
    if (typeof msg.content === 'string')
        return msg.content;
    if (Array.isArray(msg.content)) {
        return msg.content
            .filter((b) => b?.type === 'text')
            .map((b) => b.text || '')
            .join(' ');
    }
    return '';
}
function turnsToText(msgs) {
    return msgs.map(m => {
        const role = m.role === 'assistant' ? 'Assistant' : 'User';
        const text = contentText(m).slice(0, 800); // cap each turn
        return `${role}: ${text}`;
    }).join('\n\n');
}
class ContextCompactor {
    constructor() {
        this.summaryCache = new Map(); // cacheKey → summary text
        this.pendingKeys = new Set(); // in-flight summarizations
        this.sessionStart = new Map(); // sessionKey → start timestamp
    }
    /**
     * Returns a (possibly compacted) request body.
     * compacted=true means old turns were replaced with a cached summary.
     */
    compact(body, apiKey) {
        const messages = body.messages;
        // Derive a session key from first message content (stable across requests in same session)
        const sessionKey = messages.length > 0 ? quickHash(messages.slice(0, 1)) : '';
        if (sessionKey && !this.sessionStart.has(sessionKey)) {
            this.sessionStart.set(sessionKey, Date.now());
        }
        const sessionAge = sessionKey ? Date.now() - (this.sessionStart.get(sessionKey) ?? Date.now()) : 0;
        const timeForced = sessionAge >= COMPACT_INTERVAL_MS;
        if (messages.length <= COMPACT_THRESHOLD && !timeForced) {
            return { body, compacted: false };
        }
        const splitAt = messages.length - KEEP_RECENT;
        const oldTurns = messages.slice(0, splitAt);
        const recent = messages.slice(splitAt);
        const cacheKey = quickHash(oldTurns);
        const cached = this.summaryCache.get(cacheKey);
        if (cached) {
            return { body: this.applyCompaction(body, cached, recent), compacted: true };
        }
        // No summary yet — fire background summarization, return original this turn
        if (!this.pendingKeys.has(cacheKey) && apiKey) {
            this.pendingKeys.add(cacheKey);
            this.summarizeInBackground(oldTurns, cacheKey, apiKey);
        }
        return { body, compacted: false };
    }
    applyCompaction(body, summary, recentMessages) {
        const summaryBlock = `<context_summary>\n` +
            `Earlier turns have been compacted to save tokens. Key context:\n\n` +
            summary +
            `\n</context_summary>`;
        let newSystem;
        if (!body.system) {
            newSystem = summaryBlock;
        }
        else if (typeof body.system === 'string') {
            newSystem = summaryBlock + '\n\n' + body.system;
        }
        else {
            // array of content blocks — prepend as a text block
            newSystem = [{ type: 'text', text: summaryBlock }, ...body.system];
        }
        return { ...body, system: newSystem, messages: recentMessages };
    }
    summarizeInBackground(oldTurns, cacheKey, apiKey) {
        const turns = turnsToText(oldTurns);
        const prompt = SUMMARY_PROMPT.replace('{{TURNS}}', turns);
        this.callHaiku(prompt, apiKey)
            .then(summary => {
            this.summaryCache.set(cacheKey, summary);
            this.pendingKeys.delete(cacheKey);
            // Evict oldest entry if cache grows large
            if (this.summaryCache.size > 100) {
                this.summaryCache.delete(this.summaryCache.keys().next().value);
            }
        })
            .catch(() => {
            this.pendingKeys.delete(cacheKey);
        });
    }
    callHaiku(prompt, apiKey) {
        const body = JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 600,
            messages: [{ role: 'user', content: prompt }],
        });
        return new Promise((resolve, reject) => {
            const req = https.request({
                hostname: 'api.anthropic.com',
                port: 443,
                path: '/v1/messages',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                    'x-steward-internal': '1', // prevents proxy loop
                },
            }, (res) => {
                let data = '';
                res.on('data', c => { data += c; });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        resolve(parsed?.content?.[0]?.text?.trim() || '');
                    }
                    catch {
                        reject(new Error('parse error'));
                    }
                });
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }
}
exports.ContextCompactor = ContextCompactor;
