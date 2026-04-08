/**
 * Git Monitor
 * Provides token-efficient git context to Claude.
 *
 * Instead of dumping full diffs or long git logs, it:
 *  - Returns only the N most recent commits with one-line summaries
 *  - Returns only the diff of files actually changed (not all files)
 *  - Truncates large diffs and notes the truncation
 *  - Detects the "interesting" files (most changed, most recent)
 *  - Returns a compact blame snippet when debugging a specific line
 */

import { execSync } from 'child_process';
import * as path from 'path';

export interface CommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  message: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface GitContext {
  branch: string;
  recentCommits: CommitInfo[];
  stagedDiff: string;
  unstagedDiff: string;
  untrackedFiles: string[];
  tokenEstimate: number;
}

const MAX_DIFF_CHARS = 3000;   // ~750 tokens max per diff section
const MAX_COMMITS = 10;

export class GitMonitor {
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Returns a compact, token-efficient git context.
   * Only includes what changed recently — not the full repo history.
   */
  getContext(commitCount = 5): GitContext {
    const branch = this.run('git rev-parse --abbrev-ref HEAD') || 'unknown';
    const recentCommits = this.getRecentCommits(Math.min(commitCount, MAX_COMMITS));
    const stagedDiff = this.getDiff('--cached');
    const unstagedDiff = this.getDiff('');
    const untrackedFiles = this.getUntrackedFiles();

    const contextText = branch + recentCommits.map(c => c.message).join(' ')
      + stagedDiff + unstagedDiff;
    const tokenEstimate = Math.ceil(contextText.length / 4);

    return { branch, recentCommits, stagedDiff, unstagedDiff, untrackedFiles, tokenEstimate };
  }

  /**
   * Returns recent commits as a compact one-liner per commit.
   * Much cheaper than `git log -p`.
   */
  getRecentCommits(n = 5): CommitInfo[] {
    try {
      const log = this.run(
        `git log --oneline --stat -${n} --format="%H|%h|%an|%ar|%s"`
      );
      if (!log) return [];

      const commits: CommitInfo[] = [];
      const lines = log.split('\n');

      for (const line of lines) {
        const parts = line.split('|');
        if (parts.length < 5) continue;
        const [hash, shortHash, author, date, ...msgParts] = parts;
        commits.push({
          hash: hash.trim(),
          shortHash: shortHash.trim(),
          author: author.trim(),
          date: date.trim(),
          message: msgParts.join('|').trim(),
          filesChanged: 0,
          insertions: 0,
          deletions: 0,
        });
      }

      // Get stat summaries separately
      try {
        const stats = this.run(`git log --oneline --shortstat -${n}`);
        const statLines = (stats || '').split('\n');
        let commitIdx = 0;
        for (const line of statLines) {
          const m = line.match(/(\d+) file.*?(\d+) insertion.*?(\d+) deletion/);
          if (m && commits[commitIdx]) {
            commits[commitIdx].filesChanged = parseInt(m[1]);
            commits[commitIdx].insertions = parseInt(m[2]);
            commits[commitIdx].deletions = parseInt(m[3]);
            commitIdx++;
          }
        }
      } catch {}

      return commits;
    } catch {
      return [];
    }
  }

  /**
   * Returns a truncated diff. If the diff is large, truncates and notes how many
   * lines were omitted — so Claude knows to ask for more if needed.
   */
  getDiff(flags: string): string {
    try {
      const full = this.run(`git diff ${flags} --unified=3`);
      if (!full) return '';
      if (full.length <= MAX_DIFF_CHARS) return full;

      const truncated = full.slice(0, MAX_DIFF_CHARS);
      const omittedLines = full.slice(MAX_DIFF_CHARS).split('\n').length;
      return `${truncated}\n\n[... ${omittedLines} lines truncated. Ask for specific file diff if needed.]`;
    } catch {
      return '';
    }
  }

  /**
   * Returns diff for a specific file only.
   */
  getFileDiff(filePath: string, staged = false): string {
    const flag = staged ? '--cached' : '';
    try {
      const diff = this.run(`git diff ${flag} -- "${filePath}"`);
      return diff || '';
    } catch {
      return '';
    }
  }

  /**
   * Returns blame for specific lines around a line number (for debugging).
   * Much cheaper than full file blame.
   */
  getBlameSnippet(filePath: string, lineNumber: number, radius = 10): string {
    const start = Math.max(1, lineNumber - radius);
    const end = lineNumber + radius;
    try {
      return this.run(`git blame -L ${start},${end} -- "${filePath}"`) || '';
    } catch {
      return '';
    }
  }

  getUntrackedFiles(): string[] {
    try {
      const out = this.run('git ls-files --others --exclude-standard');
      return out ? out.split('\n').filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  /**
   * Builds a Claude-ready compact context string.
   * Token-efficient: only recent activity, truncated diffs.
   */
  buildContextBlock(commitCount = 3): string {
    const ctx = this.getContext(commitCount);
    const lines: string[] = [];

    lines.push(`## Git Context (branch: ${ctx.branch})`);

    if (ctx.recentCommits.length > 0) {
      lines.push(`### Recent Commits`);
      for (const c of ctx.recentCommits) {
        lines.push(`- \`${c.shortHash}\` ${c.date} — ${c.message} (+${c.insertions}/-${c.deletions})`);
      }
      lines.push('');
    }

    if (ctx.stagedDiff) {
      lines.push(`### Staged Changes`);
      lines.push('```diff');
      lines.push(ctx.stagedDiff);
      lines.push('```');
      lines.push('');
    }

    if (ctx.unstagedDiff) {
      lines.push(`### Unstaged Changes`);
      lines.push('```diff');
      lines.push(ctx.unstagedDiff);
      lines.push('```');
      lines.push('');
    }

    if (ctx.untrackedFiles.length > 0) {
      lines.push(`### Untracked Files: ${ctx.untrackedFiles.join(', ')}`);
    }

    lines.push(`*~${ctx.tokenEstimate} tokens (ask for full diff of a specific file if needed)*`);
    return lines.join('\n');
  }

  private run(command: string): string {
    try {
      return execSync(command, {
        cwd: this.workspaceRoot,
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
    } catch {
      return '';
    }
  }
}
