"use strict";
/**
 * Token Counter
 * Estimates token counts for Claude messages using cl100k_base encoding.
 * Claude uses a BPE tokenizer similar to GPT-4; this gives a close estimate.
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
exports.TokenCounter = void 0;
// Simple regex-based tokenizer for environments where tiktoken isn't available
function roughTokenCount(text) {
    if (!text)
        return 0;
    const str = typeof text === 'string' ? text : JSON.stringify(text);
    const words = str.split(/\s+/).length;
    const chars = str.length;
    return Math.ceil((words * 1.3 + chars / 5) / 2);
}
class TokenCounter {
    constructor() {
        this.encoder = null;
        this.ready = false;
    }
    async init() {
        try {
            // Try to load tiktoken for accurate counts
            const tiktoken = await Promise.resolve().then(() => __importStar(require('tiktoken')));
            this.encoder = tiktoken.get_encoding('cl100k_base');
            this.ready = true;
        }
        catch {
            // Fallback to rough estimate
            this.ready = false;
        }
    }
    count(text) {
        if (this.ready && this.encoder) {
            try {
                const tokens = this.encoder.encode(text);
                return { prompt: tokens.length, estimated: false };
            }
            catch {
                return { prompt: roughTokenCount(text), estimated: true };
            }
        }
        return { prompt: roughTokenCount(text), estimated: true };
    }
    countMessages(messages) {
        let total = 0;
        // Claude API overhead per message
        const PER_MESSAGE_OVERHEAD = 4;
        const BASE_OVERHEAD = 3;
        for (const msg of messages) {
            const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            const count = this.count(text);
            total += count.prompt + PER_MESSAGE_OVERHEAD;
        }
        total += BASE_OVERHEAD;
        return { prompt: total, estimated: !this.ready };
    }
    countRequest(body) {
        let total = 0;
        if (body.system) {
            const sys = typeof body.system === 'string' ? body.system : JSON.stringify(body.system);
            total += this.count(sys).prompt;
        }
        if (body.messages) {
            total += this.countMessages(body.messages).prompt;
        }
        return { prompt: total, estimated: !this.ready };
    }
    dispose() {
        if (this.encoder) {
            try {
                this.encoder.free();
            }
            catch { }
        }
    }
}
exports.TokenCounter = TokenCounter;
