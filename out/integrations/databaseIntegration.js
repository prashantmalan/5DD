"use strict";
/**
 * Database Integration
 * Token strategy:
 *  - Schema only (table names + column names + types), never row data
 *  - Query explain plan instead of actual results
 *  - If user wants sample data, limit to 3 rows max
 *  - Detect slow queries from pg_stat_statements / slow query log
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DatabaseIntegration = void 0;
const child_process_1 = require("child_process");
class DatabaseIntegration {
    constructor(config) {
        this.config = config;
        this.maxRows = config.maxSampleRows ?? 3;
    }
    async getMinimalContext(query, level) {
        const results = ['## Database Context'];
        // Extract table names from the query
        const tables = this.extractTableNames(query);
        if (tables.length > 0) {
            for (const table of tables.slice(0, 4)) {
                const schema = await this.getTableSchema(table);
                if (schema)
                    results.push(schema);
            }
        }
        else {
            // No specific table — list all table names only (very cheap)
            const tableList = await this.listTables();
            if (tableList)
                results.push(tableList);
        }
        // Level 2+: include slow query info
        if (level >= 2) {
            const slowQueries = await this.getSlowQueries();
            if (slowQueries)
                results.push(slowQueries);
        }
        return results.join('\n\n');
    }
    async getTableSchema(tableName) {
        const sql = this.schemaQuery(tableName);
        const rows = await this.runQuery(sql);
        if (!rows || rows.length === 0)
            return '';
        const lines = [`### Table: \`${tableName}\``];
        for (const row of rows) {
            const col = row.column_name || row.COLUMN_NAME || Object.values(row)[0];
            const type = row.data_type || row.DATA_TYPE || Object.values(row)[1];
            const nullable = row.is_nullable || row.IS_NULLABLE;
            lines.push(`- ${col}: ${type}${nullable === 'NO' ? ' NOT NULL' : ''}`);
        }
        return lines.join('\n');
    }
    async listTables() {
        const sql = this.listTablesQuery();
        const rows = await this.runQuery(sql);
        if (!rows || rows.length === 0)
            return '';
        const names = rows.map((r) => Object.values(r)[0]).join(', ');
        return `### Tables: ${names}`;
    }
    async getSlowQueries() {
        if (this.config.type !== 'postgres')
            return '';
        const sql = `
      SELECT query, calls, mean_exec_time::int as avg_ms
      FROM pg_stat_statements
      ORDER BY mean_exec_time DESC LIMIT 3;
    `;
        const rows = await this.runQuery(sql);
        if (!rows || rows.length === 0)
            return '';
        const lines = ['### Slow Queries (top 3)'];
        for (const r of rows) {
            lines.push(`- ${r.avg_ms}ms avg (${r.calls} calls): ${String(r.query).slice(0, 100)}`);
        }
        return lines.join('\n');
    }
    schemaQuery(table) {
        switch (this.config.type) {
            case 'postgres':
                return `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name='${table}' ORDER BY ordinal_position`;
            case 'mysql':
                return `SELECT COLUMN_NAME as column_name, DATA_TYPE as data_type, IS_NULLABLE as is_nullable FROM information_schema.COLUMNS WHERE TABLE_NAME='${table}'`;
            case 'sqlite':
                return `PRAGMA table_info(${table})`;
            default:
                return `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='${table}'`;
        }
    }
    listTablesQuery() {
        switch (this.config.type) {
            case 'postgres': return `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
            case 'mysql': return `SHOW TABLES`;
            case 'sqlite': return `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`;
            default: return `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE'`;
        }
    }
    extractTableNames(query) {
        // Extract table names from natural language: "users table", "FROM orders", etc.
        const patterns = [
            /\b(?:table|from|join|into|update)\s+`?(\w+)`?/gi,
            /`(\w+)`\s+table/gi,
        ];
        const names = new Set();
        for (const p of patterns) {
            let m;
            while ((m = p.exec(query)) !== null) {
                if (m[1] && !['the', 'a', 'an'].includes(m[1].toLowerCase())) {
                    names.add(m[1]);
                }
            }
        }
        return [...names];
    }
    async runQuery(sql) {
        // Use psql / mysql / sqlite3 CLI to avoid requiring a Node.js DB driver
        try {
            let cmd = '';
            const cs = this.config.connectionString;
            switch (this.config.type) {
                case 'postgres':
                    cmd = `psql "${cs}" -t -A -F'|' -c "${sql.replace(/"/g, '\\"')}"`;
                    break;
                case 'mysql':
                    cmd = `mysql "${cs}" -e "${sql.replace(/"/g, '\\"')}" --batch`;
                    break;
                case 'sqlite':
                    cmd = `sqlite3 "${cs}" "${sql.replace(/"/g, '\\"')}"`;
                    break;
                default:
                    return null;
            }
            const out = (0, child_process_1.execSync)(cmd, { timeout: 10000, encoding: 'utf-8' });
            return this.parseTabular(out);
        }
        catch {
            return null;
        }
    }
    parseTabular(output) {
        const lines = output.trim().split('\n').filter(Boolean);
        if (lines.length < 2)
            return [];
        const headers = lines[0].split('|');
        return lines.slice(1).map(line => {
            const vals = line.split('|');
            return Object.fromEntries(headers.map((h, i) => [h.trim(), vals[i]?.trim()]));
        });
    }
}
exports.DatabaseIntegration = DatabaseIntegration;
