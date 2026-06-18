#!/usr/bin/env node
// Entry: resolve config (workspace root + `swarm` binary), build the server, connect stdio. The stdout
// stream IS the MCP protocol — all diagnostics go to stderr only.

import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { resolve_root } from './roots.ts';
import { create_server } from './server.ts';

export type Config = Readonly<{ root: string; bin: string }>;

// Config order: CLI flags > env > cwd. `--workspace <path>` / SWARM_WORKSPACE picks the workspace;
// `--swarm-bin <path>` / SWARM_BIN picks the `swarm` binary (default `swarm` on PATH).
export function parse_config(argv: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Config {
    let root = env.SWARM_WORKSPACE ?? cwd;
    let bin = env.SWARM_BIN ?? 'swarm';
    for (let i = 0; i < argv.length; i += 1) {
        // Treat a flag-shaped next token as a missing value (don't consume `--swarm-bin` as the workspace).
        const next = argv[i + 1];
        const value = next !== undefined && !next.startsWith('--') ? next : undefined;
        if (argv[i] === '--workspace' && value !== undefined) {
            root = value;
            i += 1;
        } else if (argv[i] === '--swarm-bin' && value !== undefined) {
            bin = value;
            i += 1;
        }
    }
    return { root: resolve_root(root), bin };
}

/* v8 ignore start -- the process entry; create_server + parse_config are unit-tested directly */
async function main(): Promise<void> {
    const { root, bin } = parse_config(process.argv.slice(2), process.env, process.cwd());
    const server = create_server({ env: { bin, cwd: root }, root });
    await server.connect(new StdioServerTransport());
    process.stderr.write(`swarm-mcp: ready (workspace=${root}, swarm=${bin})\n`);
}

function is_main_module(metaUrl: string, entry: string | undefined): boolean {
    return entry !== undefined && metaUrl === pathToFileURL(entry).href;
}
if (is_main_module(import.meta.url, process.argv[1])) {
    main().catch((error: unknown) => {
        process.stderr.write(`swarm-mcp: fatal: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
    });
}
/* v8 ignore stop */
