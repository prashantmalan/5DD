"use strict";
/**
 * Prompt Optimizer
 * Reduces token usage by compressing prompts without losing meaning.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PromptOptimizer = void 0;
// Max chars to keep in a single tool_result block before truncating
const TOOL_RESULT_MAX_CHARS = 8000;
// Token budget: if total prompt exceeds this, trim oldest messages
const CONTEXT_TOKEN_BUDGET = 40000;
// Minimum messages to always keep (never trim below this)
const MIN_MESSAGES_TO_KEEP = 6;
class PromptOptimizer {
    constructor(tokenCounter) {
        this.tokenCounter = tokenCounter;
    }
    optimize(body) {
        const originalTokens = this.tokenCounter.countRequest(body).prompt;
        const techniques = [];
        let optimized = JSON.parse(JSON.stringify(body));
        // 1. Normalize whitespace in system prompt
        if (optimized.system && typeof optimized.system === 'string') {
            const before = optimized.system.length;
            optimized.system = this.compressWhitespace(optimized.system);
            if (optimized.system.length < before) {
                techniques.push('whitespace-compression');
            }
        }
        // 2. Compress each message — handle both string and array content
        for (let i = 0; i < optimized.messages.length; i++) {
            const msg = optimized.messages[i];
            if (typeof msg.content === 'string') {
                const before = msg.content;
                msg.content = this.compressWhitespace(msg.content);
                msg.content = this.removeRedundantPhrases(msg.content);
                if (msg.content !== before && !techniques.includes('whitespace-compression')) {
                    techniques.push('whitespace-compression');
                }
            }
            else if (Array.isArray(msg.content)) {
                let changed = false;
                msg.content = msg.content.map((block) => {
                    if (!block || typeof block !== 'object')
                        return block;
                    // text blocks: compress whitespace + filler
                    if (block.type === 'text' && typeof block.text === 'string') {
                        const before = block.text;
                        block = { ...block, text: this.compressWhitespace(block.text) };
                        block = { ...block, text: this.removeRedundantPhrases(block.text) };
                        if (block.text !== before)
                            changed = true;
                    }
                    // tool_result blocks: truncate oversized content
                    if (block.type === 'tool_result') {
                        block = this.trimToolResult(block);
                        changed = true;
                    }
                    return block;
                });
                if (changed && !techniques.includes('whitespace-compression')) {
                    techniques.push('whitespace-compression');
                }
            }
        }
        // 3. Trim tool_result in assistant messages (tool_use results embedded in content)
        //    Already handled above, but also check for nested tool results
        optimized = this.trimOversizedToolResults(optimized, techniques);
        // 4. Context window trim — token-budget based, not message-count based
        const tokensAfterCompression = this.tokenCounter.countRequest(optimized).prompt;
        if (tokensAfterCompression > CONTEXT_TOKEN_BUDGET) {
            optimized = this.trimContextByTokens(optimized, CONTEXT_TOKEN_BUDGET);
            techniques.push('context-trim');
        }
        // 5. Deduplicate repeated code blocks
        optimized = this.deduplicateContent(optimized, techniques);
        const optimizedTokens = this.tokenCounter.countRequest(optimized).prompt;
        const savedTokens = Math.max(0, originalTokens - optimizedTokens);
        return { body: optimized, originalTokens, optimizedTokens, savedTokens, techniques };
    }
    compressWhitespace(text) {
        return text
            .replace(/\r\n/g, '\n') // normalize line endings
            .replace(/\n{3,}/g, '\n\n') // max 2 consecutive blank lines
            .replace(/[ \t]{2,}/g, ' ') // collapse multiple spaces/tabs
            .replace(/^\s+|\s+$/g, '') // trim leading/trailing
            .trim();
        // NOTE: intentionally NOT stripping indentation (/\n +/g) — that breaks code blocks
    }
    removeRedundantPhrases(text) {
        const fillers = [
            /^(Sure,?\s+|Of course,?\s+|Certainly,?\s+|Absolutely,?\s+)/gi,
            /^(I'd be happy to help you with that\.?\s*)/gi,
            /^(As an AI language model,?\s+)/gi,
            /^(As a helpful assistant,?\s+)/gi,
            /(Is there anything else I can help you with\??\s*)$/gi,
            /(Let me know if you (need|have) any (more |other )?questions\.?\s*)$/gi,
            /(Feel free to ask if you need (more |further )?clarification\.?\s*)$/gi,
        ];
        let result = text;
        for (const pattern of fillers) {
            result = result.replace(pattern, '');
        }
        return result.trim();
    }
    /**
     * Truncate a tool_result block whose content exceeds TOOL_RESULT_MAX_CHARS.
     * Keeps the first half and last quarter so the model still sees context + outcome.
     */
    trimToolResult(block) {
        if (!block || block.type !== 'tool_result')
            return block;
        if (typeof block.content === 'string') {
            if (block.content.length > TOOL_RESULT_MAX_CHARS) {
                const keep = TOOL_RESULT_MAX_CHARS;
                const head = Math.floor(keep * 0.6);
                const tail = keep - head;
                block = {
                    ...block,
                    content: block.content.slice(0, head) +
                        `\n...[truncated ${block.content.length - keep} chars]...\n` +
                        block.content.slice(-tail),
                };
            }
        }
        else if (Array.isArray(block.content)) {
            block = {
                ...block,
                content: block.content.map((inner) => {
                    if (inner?.type === 'text' && typeof inner.text === 'string' && inner.text.length > TOOL_RESULT_MAX_CHARS) {
                        const keep = TOOL_RESULT_MAX_CHARS;
                        const head = Math.floor(keep * 0.6);
                        const tail = keep - head;
                        return {
                            ...inner,
                            text: inner.text.slice(0, head) +
                                `\n...[truncated ${inner.text.length - keep} chars]...\n` +
                                inner.text.slice(-tail),
                        };
                    }
                    return inner;
                }),
            };
        }
        return block;
    }
    /**
     * Walk all messages and trim any tool_result blocks that are still oversized.
     * This catches cases where tool results are embedded inside assistant messages.
     */
    trimOversizedToolResults(body, techniques) {
        let trimmed = false;
        const messages = body.messages.map((msg) => {
            if (!Array.isArray(msg.content))
                return msg;
            const newContent = msg.content.map((block) => {
                if (block?.type === 'tool_result') {
                    const before = JSON.stringify(block).length;
                    const after = this.trimToolResult(block);
                    if (JSON.stringify(after).length < before)
                        trimmed = true;
                    return after;
                }
                return block;
            });
            return { ...msg, content: newContent };
        });
        if (trimmed && !techniques.includes('tool-result-trim')) {
            techniques.push('tool-result-trim');
        }
        return { ...body, messages };
    }
    /**
     * Remove oldest messages until we're under the token budget.
     * Always keeps at least MIN_MESSAGES_TO_KEEP recent messages.
     * Ensures tool_use/tool_result pairs are never split.
     * Prepends a context note so the model knows history was trimmed.
     */
    trimContextByTokens(body, budget) {
        let messages = [...body.messages];
        while (messages.length > MIN_MESSAGES_TO_KEEP) {
            const testBody = { ...body, messages };
            if (this.tokenCounter.countRequest(testBody).prompt <= budget)
                break;
            messages = messages.slice(1); // drop oldest
            // After dropping, strip any orphaned tool_result blocks at the new head.
            // An orphaned tool_result has no preceding tool_use in the remaining messages.
            messages = this.stripOrphanedToolResults(messages);
        }
        const droppedCount = body.messages.length - messages.length;
        if (droppedCount > 0) {
            const summaryMsg = {
                role: 'user',
                content: `[Context note: ${droppedCount} earlier messages were trimmed to save tokens. The conversation continues below.]`,
            };
            messages = [summaryMsg, ...messages];
        }
        return { ...body, messages };
    }
    /**
     * Remove tool_result blocks from the first user message if their tool_use_id
     * has no corresponding tool_use in the remaining messages.
     */
    stripOrphanedToolResults(messages) {
        if (messages.length === 0)
            return messages;
        // Collect all tool_use ids present in the remaining messages
        const validToolUseIds = new Set();
        for (const msg of messages) {
            if (Array.isArray(msg.content)) {
                for (const block of msg.content) {
                    if (block?.type === 'tool_use' && block.id) {
                        validToolUseIds.add(block.id);
                    }
                }
            }
        }
        // Strip orphaned tool_result blocks from the first message
        const first = messages[0];
        if (!Array.isArray(first.content))
            return messages;
        const cleaned = first.content.filter((block) => {
            if (block?.type === 'tool_result') {
                return validToolUseIds.has(block.tool_use_id);
            }
            return true;
        });
        if (cleaned.length === first.content.length)
            return messages; // nothing removed
        // If the first message is now empty, drop it entirely
        if (cleaned.length === 0)
            return messages.slice(1);
        return [{ ...first, content: cleaned }, ...messages.slice(1)];
    }
    deduplicateContent(body, techniques) {
        const seen = new Map();
        let deduped = false;
        const messages = body.messages.map((msg, idx) => {
            const compressContent = (text) => {
                const blocks = text.match(/```[\s\S]{100,}?```/g) || [];
                let result = text;
                for (const block of blocks) {
                    const hash = simpleHash(block);
                    if (seen.has(hash)) {
                        result = result.replace(block, `[same code as message ${seen.get(hash) + 1}]`);
                        deduped = true;
                    }
                    else {
                        seen.set(hash, idx);
                    }
                }
                return result;
            };
            if (typeof msg.content === 'string') {
                return { ...msg, content: compressContent(msg.content) };
            }
            else if (Array.isArray(msg.content)) {
                const newContent = msg.content.map((block) => {
                    if (block?.type === 'text' && typeof block.text === 'string') {
                        return { ...block, text: compressContent(block.text) };
                    }
                    return block;
                });
                return { ...msg, content: newContent };
            }
            return msg;
        });
        if (deduped && !techniques.includes('content-dedup')) {
            techniques.push('content-dedup');
        }
        return { ...body, messages };
    }
    optimizeSystemPrompt(systemPrompt) {
        let optimized = this.compressWhitespace(systemPrompt);
        const sentences = optimized.split(/\.\s+/);
        const unique = [...new Set(sentences)];
        optimized = unique.join('. ');
        return optimized;
    }
}
exports.PromptOptimizer = PromptOptimizer;
function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString(36);
}
