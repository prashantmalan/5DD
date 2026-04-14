/**
 * PII Filter
 * Detects and redacts sensitive data in prompt text before it reaches the Anthropic API.
 * Redacted values are stored in a per-session vault so they can optionally be
 * restored in responses (future work).
 *
 * Patterns detected:
 *   • API keys / secrets  (sk-, pk-, ghp_, xox, Bearer tokens, etc.)
 *   • Email addresses
 *   • Phone numbers (E.164 and common US/intl formats)
 *   • IPv4 addresses (private and public)
 *   • Credit card numbers (Luhn-valid, 13-19 digit, common separators)
 *
 * Replacement format: [PII:TYPE:ID]  e.g. [PII:email:a3f2]
 * This is reversible: the vault maps ID → original value.
 */

import * as path from 'path';
import * as fs from 'fs';
import { AnthropicRequestBody } from './tokenCounter';

export interface RedactionResult {
  body: AnthropicRequestBody;
  count: number;          // how many values were redacted
  types: string[];        // which categories were hit
}

interface VaultEntry {
  id: string;
  type: string;
  original: string;
  redacted: string;
  timestamp: number;
}

// ─── Detection patterns ──────────────────────────────────────────────────────

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  // API keys / secrets (order matters — put more specific first)
  { name: 'api-key', re: /\b(sk-[A-Za-z0-9\-_]{20,}|pk-[A-Za-z0-9\-_]{20,}|ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82}|xox[baprs]-[A-Za-z0-9\-]+|AIza[A-Za-z0-9\-_]{35}|AKIA[A-Z0-9]{16})\b/g },
  // Bearer tokens in Authorization headers or inline
  { name: 'bearer-token', re: /\bBearer\s+([A-Za-z0-9\-_\.~+/]+=*)\b/g },
  // Email addresses
  { name: 'email', re: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g },
  // Phone numbers — E.164 or common formats
  { name: 'phone', re: /(?<!\d)(\+?1[\s\-.]?)?\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}(?!\d)/g },
  // IPv4 — skip loopback / link-local
  { name: 'ipv4', re: /\b(?!127\.|169\.254\.|0\.0\.0\.0)(\d{1,3}\.){3}\d{1,3}\b/g },
];

// ─── Luhn check for credit cards ─────────────────────────────────────────────

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const CC_RE = /\b(?:\d[ \-]?){13,19}\b/g;

function redactCreditCards(text: string, vault: VaultEntry[]): string {
  return text.replace(CC_RE, match => {
    const digits = match.replace(/[ \-]/g, '');
    if (digits.length < 13 || digits.length > 19) return match;
    if (!luhn(digits)) return match;
    return makeToken('credit-card', match, vault);
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shortId(): string {
  return Math.random().toString(36).slice(2, 6);
}

function makeToken(type: string, original: string, vault: VaultEntry[]): string {
  const id = shortId();
  const redacted = `[PII:${type}:${id}]`;
  vault.push({ id, type, original, redacted, timestamp: Date.now() });
  return redacted;
}

function redactText(text: string, vault: VaultEntry[]): { text: string; count: number; types: Set<string> } {
  let out = text;
  let count = 0;
  const types = new Set<string>();

  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, match => {
      count++;
      types.add(name);
      return makeToken(name, match, vault);
    });
  }

  // Credit cards (separate due to Luhn check)
  const before = out;
  out = redactCreditCards(out, vault);
  if (out !== before) { count++; types.add('credit-card'); }

  return { text: out, count, types };
}

// ─── Main export ─────────────────────────────────────────────────────────────

export class PiiFilter {
  private vault: VaultEntry[] = [];
  private vaultPath: string | null;
  private enabled: boolean;

  constructor(opts: { storagePath?: string; enabled?: boolean } = {}) {
    this.enabled = opts.enabled ?? true;
    this.vaultPath = opts.storagePath
      ? path.join(opts.storagePath, 'pii-vault.jsonl')
      : null;
  }

  /** Redact PII from all message content in a request body. Returns a copy. */
  filter(body: AnthropicRequestBody): RedactionResult {
    if (!this.enabled) {
      return { body, count: 0, types: [] };
    }

    const sessionVault: VaultEntry[] = [];
    let totalCount = 0;
    const allTypes = new Set<string>();

    const redactContent = (content: unknown): unknown => {
      if (typeof content === 'string') {
        const r = redactText(content, sessionVault);
        totalCount += r.count;
        r.types.forEach(t => allTypes.add(t));
        return r.text;
      }
      if (Array.isArray(content)) {
        return content.map(block => {
          if (block && typeof block === 'object' && typeof (block as any).text === 'string') {
            const r = redactText((block as any).text, sessionVault);
            totalCount += r.count;
            r.types.forEach(t => allTypes.add(t));
            return { ...block, text: r.text };
          }
          return block;
        });
      }
      return content;
    };

    const newMessages = body.messages.map(msg => ({
      ...msg,
      content: redactContent(msg.content) as string | any[],
    }));

    const newSystem = body.system ? redactContent(body.system) : body.system;

    if (sessionVault.length > 0) {
      this.vault.push(...sessionVault);
      this.persist(sessionVault);
    }

    return {
      body: { ...body, messages: newMessages, system: newSystem as any },
      count: totalCount,
      types: [...allTypes],
    };
  }

  /** How many values have been redacted this session */
  get redactionCount(): number {
    return this.vault.length;
  }

  private persist(entries: VaultEntry[]): void {
    if (!this.vaultPath) return;
    try {
      const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
      fs.appendFileSync(this.vaultPath, lines, 'utf8');
    } catch {
      // Vault write failure is non-fatal — redaction still happens in memory
    }
  }
}
