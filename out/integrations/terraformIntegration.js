"use strict";
/**
 * Terraform Integration
 * Reads local terraform state + runs plan summary.
 * Token strategy: summarize resources by type, only show what changed.
 * Never dumps the full .tfstate (can be megabytes).
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
exports.TerraformIntegration = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
class TerraformIntegration {
    constructor(config) {
        this.config = config;
    }
    async getMinimalContext(query, level) {
        const results = ['## Terraform Context'];
        const stateFile = this.findStateFile();
        if (stateFile) {
            results.push(this.summarizeState(stateFile, level));
        }
        else {
            results.push('No terraform.tfstate found.');
        }
        if (level >= 2) {
            const plan = this.getPlanSummary();
            if (plan)
                results.push(plan);
        }
        return results.join('\n\n');
    }
    summarizeState(stateFile, level) {
        try {
            const raw = fs.readFileSync(stateFile, 'utf-8');
            const state = JSON.parse(raw);
            const resources = (state.resources || []).filter((r) => r.mode !== 'data');
            const byType = new Map();
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
        }
        catch (e) {
            return `State parse error: ${e}`;
        }
    }
    getPlanSummary() {
        try {
            const out = (0, child_process_1.execSync)('terraform plan -no-color 2>&1', {
                cwd: this.config.workspacePath,
                timeout: 30000,
                encoding: 'utf-8',
            });
            // Only keep the summary line (last 5 lines)
            const tail = out.split('\n').slice(-6).join('\n').trim();
            return `### Plan\n${tail}`;
        }
        catch {
            return '';
        }
    }
    findStateFile() {
        const candidates = [
            path.join(this.config.workspacePath, 'terraform.tfstate'),
            path.join(this.config.workspacePath, '.terraform', 'terraform.tfstate'),
        ];
        return candidates.find(c => fs.existsSync(c)) || null;
    }
}
exports.TerraformIntegration = TerraformIntegration;
