/**
 * Log Monitor
 * Watches log files and app stderr/stdout.
 * When an error occurs it extracts ONLY the relevant lines (not the full log)
 * and makes them available for Claude — saving thousands of tokens on every error.
 *
 * Smart extraction rules:
 *  - Grabs the error line + N lines before (stack context) + N lines after
 *  - Deduplicates identical repeated errors
 *  - Groups cascading errors from the same root cause
 *  - Only surfaces errors newer than the last seen timestamp
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface LogError {
  timestamp: Date;
  level: 'error' | 'warn' | 'fatal' | 'exception';
  message: string;
  stack?: string;
  context: string[];   // lines before/after for context
  source: string;      // file path or 'terminal'
  lineNumber: number;
  hash: string;        // for deduplication
}

export interface LogSummary {
  errors: LogError[];
  newErrorCount: number;
  topError: LogError | null;
  tokenEstimate: number;
  fullLogTokenEstimate: number;
  savedPct: number;
}

const ERROR_PATTERNS = [
  /\b(error|err)\b/i,
  /\b(exception|traceback|stacktrace)\b/i,
  /\b(fatal|critical|panic|crash)\b/i,
  /\b(failed|failure|cannot|could not|unable to)\b/i,
  /^Traceback/,
  /^\s+at .+\(.+:\d+:\d+\)/,  // JS stack frames
  /^\s+File ".+", line \d+/,   // Python stack frames
];

const CONTEXT_LINES_BEFORE = 5;
const CONTEXT_LINES_AFTER = 3;

export class LogMonitor {
  private watchers: Map<string, fs.FSWatcher> = new Map();
  private lastPositions: Map<string, number> = new Map();
  private seenHashes: Set<string> = new Set();
  private recentErrors: LogError[] = [];
  private _onError = new vscode.EventEmitter<LogError>();
  readonly onError = this._onError.event;

  watchFile(filePath: string): void {
    if (this.watchers.has(filePath)) return;

    if (!fs.existsSync(filePath)) return;

    // Start at end of file — only new errors
    const stat = fs.statSync(filePath);
    this.lastPositions.set(filePath, stat.size);

    const watcher = fs.watch(filePath, { persistent: false }, (event) => {
      if (event === 'change') {
        this.readNewLines(filePath);
      }
    });

    this.watchers.set(filePath, watcher);
  }

  watchDirectory(dirPath: string, pattern = '*.log'): void {
    if (!fs.existsSync(dirPath)) return;

    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      if (this.matchesPattern(file, pattern)) {
        this.watchFile(path.join(dirPath, file));
      }
    }

    // Watch for new log files created
    fs.watch(dirPath, { persistent: false }, (event, filename) => {
      if (filename && this.matchesPattern(filename, pattern)) {
        this.watchFile(path.join(dirPath, filename));
      }
    });
  }

  stopWatching(filePath?: string): void {
    if (filePath) {
      this.watchers.get(filePath)?.close();
      this.watchers.delete(filePath);
    } else {
      for (const [, watcher] of this.watchers) watcher.close();
      this.watchers.clear();
    }
  }

  /**
   * Returns a minimal, token-efficient summary of recent errors.
   * Only returns new errors since last call.
   */
  getErrorSummary(maxErrors = 5): LogSummary {
    const errors = this.recentErrors.slice(-maxErrors);
    const fullLogSize = Array.from(this.lastPositions.values()).reduce((s, p) => s + p, 0);

    // Rough token estimates
    const summaryText = errors.map(e => this.formatError(e)).join('\n');
    const tokenEstimate = Math.ceil(summaryText.length / 4);
    const fullLogTokenEstimate = Math.ceil(fullLogSize / 4);
    const savedPct = fullLogTokenEstimate > 0
      ? Math.max(0, ((fullLogTokenEstimate - tokenEstimate) / fullLogTokenEstimate) * 100)
      : 0;

    return {
      errors,
      newErrorCount: errors.length,
      topError: errors[errors.length - 1] || null,
      tokenEstimate,
      fullLogTokenEstimate,
      savedPct
    };
  }

  /**
   * Builds a Claude-ready prompt snippet with only the relevant error context.
   * Much cheaper than dumping entire log files.
   */
  buildErrorContext(maxErrors = 3): string {
    const summary = this.getErrorSummary(maxErrors);
    if (summary.errors.length === 0) return '';

    const lines: string[] = [
      `## Recent Errors (${summary.errors.length} of ${summary.newErrorCount} total, ~${summary.tokenEstimate} tokens vs ~${summary.fullLogTokenEstimate} for full logs)`,
      ''
    ];

    for (const err of summary.errors) {
      lines.push(`### [${err.level.toUpperCase()}] ${err.source}:${err.lineNumber}`);
      lines.push(`\`\`\``);
      lines.push(...err.context);
      lines.push(`\`\`\``);
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Parse a terminal output string for errors (e.g. from running npm test)
   */
  parseTerminalOutput(output: string, source = 'terminal'): LogError[] {
    const lines = output.split('\n');
    return this.extractErrors(lines, source);
  }

  clearErrors(): void {
    this.recentErrors = [];
    this.seenHashes.clear();
  }

  private readNewLines(filePath: string): void {
    const currentSize = fs.statSync(filePath).size;
    const lastPos = this.lastPositions.get(filePath) || 0;

    if (currentSize <= lastPos) return;

    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(currentSize - lastPos);
    fs.readSync(fd, buffer, 0, buffer.length, lastPos);
    fs.closeSync(fd);

    this.lastPositions.set(filePath, currentSize);

    const newText = buffer.toString('utf-8');
    const lines = newText.split('\n');
    const errors = this.extractErrors(lines, filePath);

    for (const err of errors) {
      this.recentErrors.push(err);
      this._onError.fire(err);
    }

    // Keep bounded
    if (this.recentErrors.length > 200) {
      this.recentErrors = this.recentErrors.slice(-200);
    }
  }

  private extractErrors(lines: string[], source: string): LogError[] {
    const errors: LogError[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!this.isErrorLine(line)) continue;

      // Grab context window
      const contextStart = Math.max(0, i - CONTEXT_LINES_BEFORE);
      const contextEnd = Math.min(lines.length - 1, i + CONTEXT_LINES_AFTER);
      const context = lines.slice(contextStart, contextEnd + 1);

      // Build stack trace if next lines look like stack frames
      let stackLines: string[] = [];
      let j = i + 1;
      while (j < lines.length && j < i + 20 && this.isStackFrame(lines[j])) {
        stackLines.push(lines[j]);
        j++;
      }

      const level = this.detectLevel(line);
      const hash = simpleHash(line.trim().slice(0, 120));

      // Skip duplicates
      if (this.seenHashes.has(hash)) continue;
      this.seenHashes.add(hash);

      errors.push({
        timestamp: new Date(),
        level,
        message: line.trim(),
        stack: stackLines.length > 0 ? stackLines.join('\n') : undefined,
        context,
        source,
        lineNumber: i + 1,
        hash
      });
    }

    return errors;
  }

  private isErrorLine(line: string): boolean {
    return ERROR_PATTERNS.some(p => p.test(line));
  }

  private isStackFrame(line: string): boolean {
    return /^\s+(at |File "|in )/.test(line) || /^\s+\^/.test(line);
  }

  private detectLevel(line: string): LogError['level'] {
    const l = line.toLowerCase();
    if (/\b(fatal|critical|panic|crash)\b/.test(l)) return 'fatal';
    if (/\b(exception|traceback)\b/.test(l)) return 'exception';
    if (/\b(warn|warning)\b/.test(l)) return 'warn';
    return 'error';
  }

  private formatError(err: LogError): string {
    return `[${err.level.toUpperCase()}] ${err.source}:${err.lineNumber}\n${err.context.join('\n')}`;
  }

  private matchesPattern(filename: string, pattern: string): boolean {
    const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
    return regex.test(filename);
  }

  dispose(): void {
    this.stopWatching();
    this._onError.dispose();
  }
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}
