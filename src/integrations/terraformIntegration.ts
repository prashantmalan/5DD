/**
 * Terraform Integration
 * Reads local terraform state + runs plan summary.
 * Token strategy: summarize resources by type, only show what changed.
 * Never dumps the full .tfstate (can be megabytes).
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { IntegrationProvider } from '../contextBuilder';

export interface TerraformConfig {
  workspacePath: string;
}

export class TerraformIntegration implements IntegrationProvider {
  constructor(private config: TerraformConfig) {}

  async getMinimalContext(query: string, level: number): Promise<string> {
    const results: string[] = ['## Terraform Context'];

    const stateFile = this.findStateFile();
    if (stateFile) {
      results.push(this.summarizeState(stateFile, level));
    } else {
      results.push('No terraform.tfstate found.');
    }

    if (level >= 2) {
      const plan = this.getPlanSummary();
      if (plan) results.push(plan);
    }

    return results.join('\n\n');
  }

  private summarizeState(stateFile: string, level: number): string {
    try {
      const raw = fs.readFileSync(stateFile, 'utf-8');
      const state = JSON.parse(raw);
      const resources = (state.resources || []).filter((r: any) => r.mode !== 'data');

      const byType = new Map<string, string[]>();
      for (const r of resources) {
        const list = byType.get(r.type) || [];
        list.push(r.name);
        byType.set(r.type, list);
      }

      const lines = [`### State: ${resources.length} managed resources`];
      for (const [type, names] of byType) {
        lines.push(level === 1
          ? `- ${type} (${names.length})`
          : `- ${type}: ${names.join(', ')}`);
      }

      const mtime = fs.statSync(stateFile).mtime.toISOString().slice(0, 19);
      lines.push(`Last applied: ${mtime}`);
      return lines.join('\n');
    } catch (e) {
      return `State parse error: ${e}`;
    }
  }

  private getPlanSummary(): string {
    try {
      const out = execSync('terraform plan -no-color 2>&1', {
        cwd: this.config.workspacePath,
        timeout: 30000,
        encoding: 'utf-8',
      });
      // Only keep the summary line (last 5 lines)
      const tail = out.split('\n').slice(-6).join('\n').trim();
      return `### Plan\n${tail}`;
    } catch {
      return '';
    }
  }

  private findStateFile(): string | null {
    const candidates = [
      path.join(this.config.workspacePath, 'terraform.tfstate'),
      path.join(this.config.workspacePath, '.terraform', 'terraform.tfstate'),
    ];
    return candidates.find(c => fs.existsSync(c)) || null;
  }
}
